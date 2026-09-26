import { NextResponse } from "next/server";
import { requireSiteAccess } from "@/lib/auth";
import { commitFileWithRetry, createOctokit, getManifest, getRepoFile } from "@/lib/github";
import { AI_MAX_FILE_CHARS, breaksBridge, isAllowedCodePath, isAllowedContentPath } from "@/lib/ai";
import {
  SITE_JSON,
  findDangerousKeys,
  getBannerProblems,
  parseFreeDraftIdSafe,
} from "@/lib/content-guard";
import type { Draft, PublishHistoryEntry } from "@/types/cms";
import { FREE_DRAFT_PREFIX } from "@/types/cms";

const COMMIT_MESSAGE = "cms: rollback to historical version";

type Payload = Record<string, Record<string, unknown>>;

/**
 * Whitelist: Inhalts-JSONs, Blog-Artikel und Arbeits-Code dürfen
 * wiederhergestellt werden – niemals Configs oder Secrets.
 */
function isAllowedFilePath(filePath: string): boolean {
  return isAllowedContentPath(filePath) || isAllowedCodePath(filePath);
}

/** Rohtext-Snapshots tragen nur den Schlüssel __text (siehe publish-Route). */
function asRawText(value: Record<string, unknown>): string | null {
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "__text" && typeof value.__text === "string") {
    return value.__text;
  }
  return null;
}

function isValidPayload(payload: unknown): payload is Payload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.keys(payload as object).length > 0 &&
    Object.values(payload as object).every(
      (v) => typeof v === "object" && v !== null && !Array.isArray(v)
    )
  );
}

export async function POST(request: Request) {
  try {
    let body: { siteId?: string; historyId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    const { siteId: requestedSiteId, historyId } = body;
    if (!historyId) {
      return NextResponse.json({ error: "historyId fehlt." }, { status: 400 });
    }

    // Zugriff prüfen (zentral: Session + user_sites + Site, src/lib/auth.ts)
    const access = await requireSiteAccess(requestedSiteId);
    if (!access.ok) return access.error;
    const { supabase, user, site } = access;

    const siteId = site.id;
    const typedSite = site;

    // Payload ausschließlich serverseitig über historyId aus publish_history laden
    const { data: entry, error: entryError } = await supabase
      .from("publish_history")
      .select("*")
      .eq("id", historyId)
      .eq("site_id", siteId)
      .single();

    if (entryError || !entry) {
      return NextResponse.json({ error: "Version nicht gefunden." }, { status: 404 });
    }

    const payload: unknown = (entry as PublishHistoryEntry).payload;

    if (!isValidPayload(payload)) {
      return NextResponse.json(
        {
          error:
            "Diese Version enthält keinen wiederherstellbaren Payload (erwartet: { dateipfad: { ... } }).",
        },
        { status: 400 }
      );
    }

    // Pfad-Whitelist: nur erlaubte Inhalts-/Code-Dateien dürfen überschrieben werden
    const forbiddenPaths = Object.keys(payload).filter((p) => !isAllowedFilePath(p));
    if (forbiddenPaths.length > 0) {
      return NextResponse.json(
        {
          error: `Der Payload enthält nicht erlaubte Dateipfade: ${forbiddenPaths.join(", ")}.`,
        },
        { status: 400 }
      );
    }

    // B6: Rollback-Kandidat vor dem ersten Commit prüfen (wie beim Publish):
    // JSON muss ein sauberes Objekt sein, keine gefährlichen Schlüssel, Banner
    // muss in sich gültig sein, Text-Dateien begrenzt groß. Fehlerhafte Dateien
    // werden einzeln zurückgehalten statt alles abzubrechen.
    const fileErrors = new Map<string, string[]>();
    const holdBack = (file: string, message: string): void => {
      const list = fileErrors.get(file) ?? [];
      list.push(message);
      fileErrors.set(file, list);
    };
    for (const [filePath, oldContent] of Object.entries(payload)) {
      const raw = asRawText(oldContent);
      if (raw !== null) {
        if (raw.length > AI_MAX_FILE_CHARS) {
          holdBack(filePath, `Die gespeicherte Version von "${filePath}" ist zu groß und wird nicht zurückgerollt.`);
        }
        continue;
      }
      const dangerous = findDangerousKeys(oldContent);
      if (dangerous.length > 0) {
        holdBack(
          filePath,
          `Die gespeicherte Version von "${filePath}" enthält verbotene Schlüssel (${dangerous.join(", ")}) und wird nicht zurückgerollt.`
        );
        continue;
      }
      if (filePath === SITE_JSON) {
        const banner = (oldContent as Record<string, unknown>).banner;
        if (banner !== undefined) {
          for (const problem of getBannerProblems(banner)) holdBack(filePath, problem);
        }
      }
    }

    // Manifest laden, um später nur Entwürfe zurückgerollter Dateien zu löschen
    // (unbeteiligte Arbeit bleibt erhalten). Scheitert das Laden, wird vor dem
    // ersten Commit abgebrochen – es geht nichts verloren.
    const fieldFileOf = new Map<string, string>();
    try {
      const octokitForManifest = createOctokit();
      const manifest = await getManifest(
        octokitForManifest,
        typedSite.repo_owner,
        typedSite.repo_name
      );
      for (const section of manifest.sections) {
        for (const field of section.fields) {
          if (!fieldFileOf.has(field.id)) fieldFileOf.set(field.id, field.file);
        }
      }
    } catch (err) {
      return NextResponse.json(
        {
          error: `Feldliste konnte nicht aus GitHub geladen werden, Rollback abgebrochen (nichts wurde geändert): ${
            err instanceof Error ? err.message : "Unbekannter Fehler"
          }`,
        },
        { status: 502 }
      );
    }

    const octokit = createOctokit();
    let lastCommitSha: string | null = null;
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ file: string; error: string }> = [];

    // Jede Datei im Payload: aktuellen SHA holen, alten Stand darüber committen
    // (JSON als formatiertes JSON, Text-Dateien wie Blog/Code als Rohtext).
    // B6: Jede Datei läuft einzeln – ein Fehler hält nur seine Datei auf, der
    // Rest wird trotzdem zurückgerollt. Bei SHA-Konflikt einmal neu versuchen.
    for (const [filePath, oldContent] of Object.entries(payload)) {
      if (fileErrors.has(filePath)) continue;
      const raw = asRawText(oldContent);
      const newText = raw ?? JSON.stringify(oldContent, null, 2);

      let currentSha: string | null = null;
      let currentText: string | null = null;
      try {
        const { data } = await octokit.repos.getContent({
          owner: typedSite.repo_owner,
          repo: typedSite.repo_name,
          path: filePath,
          ref: "main",
        });
        if (Array.isArray(data) || data.type !== "file") {
          throw new Error(`"${filePath}" ist keine Datei im Repository.`);
        }
        currentSha = data.sha;
        currentText =
          typeof data.content === "string"
            ? Buffer.from(data.content, "base64").toString("utf-8")
            : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Rollback: SHA für "${filePath}" nicht ladbar:`, message);
        failedFiles.push({ file: filePath, error: `GitHub-Fehler beim Laden: ${message}` });
        continue;
      }

      // Brücken-Schutz auch beim Zurückrollen: Keine Version ohne
      // CMS-Vorschau-Brücke einspielen (gegen versehentlich alte Stände).
      if (raw !== null && currentText !== null && isAllowedCodePath(filePath) && breaksBridge(currentText, newText)) {
        failedFiles.push({
          file: filePath,
          error: `Die gespeicherte Version von "${filePath}" würde die CMS-Vorschau-Brücke entfernen und wird nicht zurückgerollt.`,
        });
        continue;
      }

      // Commit über den gemeinsamen Helfer (ein Retry bei SHA-Konflikt, W3)
      const commitResult = await commitFileWithRetry(
        octokit,
        typedSite.repo_owner,
        typedSite.repo_name,
        COMMIT_MESSAGE,
        { file: filePath, text: newText, sha: currentSha as string },
        async () => {
          const fresh = await getRepoFile(octokit, typedSite.repo_owner, typedSite.repo_name, filePath);
          return fresh.sha;
        }
      );
      if (!commitResult.ok) {
        console.error(`Rollback: Commit für "${filePath}" fehlgeschlagen:`, commitResult.error);
        failedFiles.push({ file: filePath, error: commitResult.error.replace(/^GitHub-Commit für "[^"]+" fehlgeschlagen: /, "GitHub-Fehler beim Committen: ") });
        continue;
      }
      lastCommitSha = commitResult.sha;
      restoredFiles.push(filePath);
    }

    // Nichts zurückgerollt? Dann ehrlich melden – keine History, keine Löschung.
    if (restoredFiles.length === 0) {
      const heldBack = [...fileErrors.entries()].flatMap(([file, msgs]) =>
        msgs.map((m) => `[${file}] ${m}`)
      );
      const failedNote = failedFiles.map((f) => `[${f.file}] ${f.error}`);
      return NextResponse.json(
        {
          error: `Es wurde nichts wiederhergestellt (keine Änderung, keine Löschung):\n- ${[...heldBack, ...failedNote].join("\n- ")}`,
        },
        { status: 500 }
      );
    }

    // B6: Nur Entwürfe löschen, deren Datei wirklich zurückgerollt wurde.
    // Alle anderen Entwürfe (unbeteiligte Arbeit) bleiben erhalten.
    const restoredSet = new Set(restoredFiles);
    const { data: draftRows, error: draftsLoadError } = await supabase
      .from("drafts")
      .select("id,field_id")
      .eq("site_id", siteId);

    if (draftsLoadError) {
      console.error("Rollback: drafts laden fehlgeschlagen:", draftsLoadError.message);
      return NextResponse.json(
        {
          error: `Rollback wurde committet (${restoredFiles.length} Datei(en)), aber die Entwürfe konnten nicht geprüft werden: ${draftsLoadError.message} – Entwürfe bleiben erhalten, bitte ggf. manuell aufräumen.`,
        },
        { status: 500 }
      );
    }

    const draftIdsToDelete: string[] = [];
    for (const row of ((draftRows ?? []) as Draft[])) {
      const mapped = fieldFileOf.get(row.field_id);
      if (mapped && restoredSet.has(mapped)) {
        draftIdsToDelete.push(row.id);
        continue;
      }
      if (row.field_id.startsWith(FREE_DRAFT_PREFIX)) {
        const parsed = parseFreeDraftIdSafe(row.field_id);
        if (parsed.ok && restoredSet.has(parsed.file)) draftIdsToDelete.push(row.id);
      }
    }
    if (draftIdsToDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from("drafts")
        .delete()
        .eq("site_id", siteId)
        .in("id", draftIdsToDelete);
      if (deleteError) {
        console.error("Rollback: drafts delete fehlgeschlagen:", deleteError.message);
        return NextResponse.json(
          {
            error: `Rollback wurde committet, aber die Entwürfe konnten nicht gelöscht werden: ${deleteError.message}`,
          },
          { status: 500 }
        );
      }
    }

    const { error: codeDeleteError } = await supabase
      .from("code_drafts")
      .delete()
      .eq("site_id", siteId)
      .in("file_path", restoredFiles);

    if (codeDeleteError) {
      console.error("Rollback: code_drafts delete fehlgeschlagen:", codeDeleteError.message);
    }

    // Rollback als neuen Verlaufseintrag dokumentieren (mit Notiz "Rollback").
    // Gesichert wird nur, was wirklich zurückgerollt wurde.
    const restoredPayload: Payload = {};
    for (const filePath of restoredFiles) {
      restoredPayload[filePath] = payload[filePath] as Record<string, unknown>;
    }
    const historyRow = {
      site_id: siteId,
      published_by: user.id ?? null,
      commit_sha: lastCommitSha,
      payload: restoredPayload,
    };
    const { error: historyError } = await supabase
      .from("publish_history")
      .insert({ ...historyRow, note: "Rollback" });

    if (historyError) {
      // Fallback für Tabellen ohne "note"-Spalte
      const { error: retryError } = await supabase
        .from("publish_history")
        .insert(historyRow);
      if (retryError) {
        console.error("Rollback: publish_history insert fehlgeschlagen:", retryError);
      } else {
        console.log(`publish_history: Rollback für Site ${siteId} gespeichert (Commit ${lastCommitSha ?? "unbekannt"})`);
      }
    } else {
      console.log(`publish_history: Rollback für Site ${siteId} gespeichert (Commit ${lastCommitSha ?? "unbekannt"})`);
    }

    const partialNote =
      failedFiles.length > 0 || fileErrors.size > 0
        ? ` Zurückgehalten/fehlgeschlagen: ${[
            ...[...fileErrors.entries()].flatMap(([file, msgs]) =>
              msgs.map((m) => `${file} (${m})`)
            ),
            ...failedFiles.map((f) => `${f.file} (${f.error})`),
          ].join("; ")}.`
        : "";
    return NextResponse.json({
      message: `Version wiederhergestellt (${restoredFiles.length} von ${Object.keys(payload).length} Datei(en) live geschaltet).${partialNote}`,
      commitSha: lastCommitSha,
      restoredFiles,
      failed: failedFiles,
      blocked: [...fileErrors.entries()].map(([file, errors]) => ({ file, errors })),
      partial: failedFiles.length > 0 || fileErrors.size > 0,
    });
  } catch (err) {
    console.error("Rollback fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
