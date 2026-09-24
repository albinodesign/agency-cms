import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifest, getRepoFile } from "@/lib/github";
import { setByPath } from "@/lib/json-path";
import { validateDraftValue } from "@/lib/validate";
import {
  AI_MAX_FILE_CHARS,
  MANIFEST_PATH,
  breaksBridge,
  findsSecret,
  isAllowedCodePath,
  isAllowedContentPath,
  validateManifestText,
} from "@/lib/ai";
import type { CodeDraft, Draft, Site } from "@/types/cms";
import { FREE_DRAFT_PREFIX } from "@/types/cms";

const COMMIT_MESSAGE = "cms: update content by client";
const BLOG_MD = /^src\/content\/blog\/[a-z0-9-]+\.md$/;

/** Zerlegt freie Entwurfs-IDs ("json:<datei>:<pfad>") – null wenn keine freie ID. */
function parseFreeDraftId(id: string): { file: string; path: string } | null {
  if (!id.startsWith(FREE_DRAFT_PREFIX)) return null;
  const rest = id.slice(FREE_DRAFT_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  return { file: rest.slice(0, sep), path: rest.slice(sep + 1) };
}

interface FileEdit {
  draftId: string;
  path: string;
  value: string;
  label: string;
  isNumber: boolean;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
    }

    let body: { siteId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    const siteId = body.siteId;
    if (!siteId || typeof siteId !== "string") {
      return NextResponse.json({ error: "siteId fehlt." }, { status: 400 });
    }

    // Zugriff prüfen
    const { data: assignment } = await supabase
      .from("user_sites")
      .select("site_id")
      .eq("user_id", user.id)
      .eq("site_id", siteId)
      .maybeSingle();

    if (!assignment) {
      return NextResponse.json({ error: "Kein Zugriff auf diese Website." }, { status: 403 });
    }

    const { data: site, error: siteError } = await supabase
      .from("sites")
      .select("*")
      .eq("id", siteId)
      .single();

    if (siteError || !site) {
      return NextResponse.json({ error: "Website nicht gefunden." }, { status: 404 });
    }

    const typedSite = site as Site;

    // Alle Entwürfe dieser Site laden (Formular + freie KI-Pfade)
    const { data: drafts, error: draftsError } = await supabase
      .from("drafts")
      .select("*")
      .eq("site_id", siteId);

    if (draftsError) {
      return NextResponse.json(
        { error: `Entwürfe konnten nicht geladen werden: ${draftsError.message}` },
        { status: 500 }
      );
    }

    // Code-Entwürfe laden (Design, Feldliste, Blog – alles volle Dateien)
    const { data: codeRows } = await supabase.from("code_drafts").select("*").eq("site_id", siteId);
    const codeDrafts = (codeRows ?? []) as CodeDraft[];

    const typedDrafts = (drafts ?? []) as Draft[];
    if (typedDrafts.length === 0 && codeDrafts.length === 0) {
      return NextResponse.json({ message: "Keine unveröffentlichten Änderungen vorhanden." });
    }

    // Manifest laden, um Feld-ID -> Datei/Pfad aufzulösen
    const octokit = createOctokit();
    let manifest;
    try {
      manifest = await getManifest(octokit, typedSite.repo_owner, typedSite.repo_name);
    } catch (err) {
      return NextResponse.json(
        {
          error: `CMS-Manifest konnte nicht aus GitHub geladen werden: ${
            err instanceof Error ? err.message : "Unbekannter Fehler"
          }`,
        },
        { status: 502 }
      );
    }

    const fieldMap = new Map(
      manifest.sections.flatMap((s) => s.fields.map((f) => [f.id, f] as const))
    );

    // Entwürfe auflösen: Manifest-Feld oder freier Datei-Pfad
    const editsByFile = new Map<string, FileEdit[]>();
    const skipped: string[] = [];
    const validationErrors: string[] = [];
    for (const draft of typedDrafts) {
      const field = fieldMap.get(draft.field_id);
      if (field) {
        if (!field.file.endsWith(".json")) {
          skipped.push(draft.field_id);
          continue;
        }
        const problem = validateDraftValue(field.type, draft.value, field.maxLength);
        if (problem) {
          validationErrors.push(`${field.label}: ${problem}`);
          continue;
        }
        const list = editsByFile.get(field.file) ?? [];
        list.push({
          draftId: draft.id,
          path: field.path,
          value: draft.value,
          label: field.label,
          isNumber: field.type === "number",
        });
        editsByFile.set(field.file, list);
        continue;
      }
      const free = parseFreeDraftId(draft.field_id);
      if (free && free.file.endsWith(".json") && isAllowedContentPath(free.file) && free.file !== MANIFEST_PATH && free.path) {
        const list = editsByFile.get(free.file) ?? [];
        list.push({ draftId: draft.id, path: free.path, value: draft.value, label: free.path, isNumber: false });
        editsByFile.set(free.file, list);
      } else {
        skipped.push(draft.field_id);
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        {
          error: `Bitte korrigiere zuerst diese Felder (es wurde nichts veröffentlicht):\n- ${validationErrors.join("\n- ")}`,
        },
        { status: 400 }
      );
    }

    // Code-Entwürfe prüfen (Whitelist, Größe, Geheimnisse) – vor jedem Commit
    const codeByFile = new Map<string, CodeDraft>();
    for (const cd of codeDrafts) {
      const isManifest = cd.file_path === MANIFEST_PATH;
      const isContent = isAllowedContentPath(cd.file_path);
      const isCode = isAllowedCodePath(cd.file_path);
      const isBlog = BLOG_MD.test(cd.file_path);
      if (!isManifest && !isContent && !isCode && !isBlog) {
        return NextResponse.json(
          { error: `Die Datei "${cd.file_path}" darf nicht veröffentlicht werden (Tabu-Bereich). Entwurf wurde nicht angerührt.` },
          { status: 400 }
        );
      }
      if (cd.content.length > AI_MAX_FILE_CHARS) {
        return NextResponse.json(
          { error: `Die Datei "${cd.file_path}" ist zu groß. Bitte in kleinere Schritte aufteilen.` },
          { status: 400 }
        );
      }
      if (findsSecret(cd.content)) {
        return NextResponse.json(
          { error: `Die Datei "${cd.file_path}" sieht nach Schlüssel oder Passwort aus. So etwas gehört niemals in Dateien.` },
          { status: 400 }
        );
      }
      if (isManifest) {
        const problem = validateManifestText(cd.content);
        if (problem) {
          return NextResponse.json(
            { error: `Die neue Feldliste ist ungültig: ${problem}` },
            { status: 400 }
          );
        }
      }
      codeByFile.set(cd.file_path, cd);
    }

    const allFiles = new Set<string>([...editsByFile.keys(), ...codeByFile.keys()]);
    if (allFiles.size === 0) {
      return NextResponse.json(
        { error: "Keine Entwürfe konnten zugeordnet werden." },
        { status: 400 }
      );
    }

    // Phase 1: ALLE Dateien vorab laden. Erst wenn alles ok ist, wird committet.
    const committedFields: string[] = [];
    const committedDraftIds: string[] = [];
    const committedFiles: string[] = [];
    const payload: Record<string, Record<string, unknown>> = {};
    let lastCommitSha: string | null = null;

    const baseFiles = new Map<string, { text: string; sha: string }>();
    for (const filePath of allFiles) {
      try {
        const file = await getRepoFile(octokit, typedSite.repo_owner, typedSite.repo_name, filePath);
        baseFiles.set(filePath, {
          text: file.text,
          sha: file.sha,
        });
      } catch (err) {
        // Blog-Artikel dürfen neu sein (Datei existiert noch nicht)
        if (BLOG_MD.test(filePath)) {
          baseFiles.set(filePath, { text: "", sha: "" });
          continue;
        }
        return NextResponse.json(
          {
            error: `Datei "${filePath}" konnte nicht aus GitHub geladen werden: ${
              err instanceof Error ? err.message : "Unbekannter Fehler"
            }`,
          },
          { status: 502 }
        );
      }
    }

    // Inhalte zusammenbauen: Code-Entwurf als Basis (falls vorhanden), sonst Live-Stand + Feld-Änderungen
    const finalContent = new Map<string, { text: string; kind: "json" | "text" }>();
    for (const filePath of allFiles) {
      const code = codeByFile.get(filePath);
      const edits = editsByFile.get(filePath) ?? [];
      const base = baseFiles.get(filePath)!;
      const isJson = filePath.endsWith(".json");

      if (!isJson) {
        // Text-Dateien (Blog, Code) kommen immer komplett aus dem Entwurf
        if (!code) {
          skipped.push(filePath);
          continue;
        }
        if (isAllowedCodePath(filePath) && breaksBridge(base.text, code.content)) {
          return NextResponse.json(
            {
              error: `Die Datei "${filePath}" würde die CMS-Vorschau-Brücke entfernen. So kann sie nicht live gehen – bitte Version mit Brücke einreichen.`,
            },
            { status: 400 }
          );
        }
        finalContent.set(filePath, { text: code.content, kind: "text" });
        continue;
      }

      // JSON: Basis parsen (Entwurf bevorzugt), Feld-Änderungen einarbeiten
      let json: Record<string, unknown>;
      try {
        json = code
          ? (JSON.parse(code.content) as Record<string, unknown>)
          : (JSON.parse(base.text) as Record<string, unknown>);
      } catch {
        return NextResponse.json(
          { error: `Die Datei "${filePath}" enthält kein gültiges JSON und kann nicht gespeichert werden.` },
          { status: 400 }
        );
      }
      for (const edit of edits) {
        // Ja/Nein-Schalter als echte Booleans speichern (nicht als Text),
        // Zahlen als echte Zahlen – sonst meckert die Website-Prüfung
        let stored: unknown = edit.value;
        if (edit.value === "true") stored = true;
        else if (edit.value === "false") stored = false;
        else if (edit.isNumber && edit.value.trim() !== "") {
          stored = Number(edit.value.trim().replace(",", "."));
        }
        setByPath(json, edit.path, stored);
      }
      const text = JSON.stringify(json, null, 2);
      finalContent.set(filePath, { text, kind: "json" });
      payload[filePath] = json;
    }

    // Phase 2: jetzt erst committen (alles wurde oben geprüft)
    for (const [filePath, final] of finalContent) {
      const base = baseFiles.get(filePath)!;
      try {
        const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
          owner: typedSite.repo_owner,
          repo: typedSite.repo_name,
          path: filePath,
          message: COMMIT_MESSAGE,
          content: Buffer.from(final.text, "utf-8").toString("base64"),
          ...(base.sha ? { sha: base.sha } : {}),
          branch: "main",
        });
        lastCommitSha = commitData.commit.sha ?? null;
      } catch (err) {
        return NextResponse.json(
          {
            error: `GitHub-Commit für "${filePath}" fehlgeschlagen: ${
              err instanceof Error ? err.message : "Unbekannter Fehler"
            }`,
          },
          { status: 502 }
        );
      }
      if (final.kind === "text") {
        // Text-Dateien als Rohtext sichern (für echtes Wiederherstellen)
        payload[filePath] = { __text: final.text };
      }
      committedFiles.push(filePath);
      const edits = editsByFile.get(filePath) ?? [];
      committedFields.push(...edits.map((e) => e.label));
      committedDraftIds.push(...edits.map((e) => e.draftId));
    }

    // Snapshot in publish_history speichern (vollständiger Stand pro Datei)
    const { error: historyError } = await supabase.from("publish_history").insert({
      site_id: siteId,
      published_by: user.id ?? null,
      commit_sha: lastCommitSha,
      payload,
    });

    if (historyError) {
      console.error("publish_history insert fehlgeschlagen:", historyError);
      return NextResponse.json(
        {
          error: `Die Änderungen wurden zu GitHub übertragen, aber der Verlaufseintrag konnte nicht gespeichert werden: ${historyError.message}`,
        },
        { status: 500 }
      );
    }

    console.log(
      `publish_history: Eintrag für Site ${siteId} gespeichert (Commit ${lastCommitSha ?? "unbekannt"}, ${committedFiles.length} Datei(en))`
    );

    // Publizierte Entwürfe löschen – nur exakt die committeten IDs/Dateien
    if (committedDraftIds.length > 0) {
      const { error: deleteError } = await supabase
        .from("drafts")
        .delete()
        .eq("site_id", siteId)
        .in("id", committedDraftIds);
      if (deleteError) {
        console.error("drafts delete fehlgeschlagen:", deleteError.message);
      }
    }
    if (committedFiles.length > 0) {
      const { error: codeDeleteError } = await supabase
        .from("code_drafts")
        .delete()
        .eq("site_id", siteId)
        .in("file_path", committedFiles);
      if (codeDeleteError) {
        console.error("code_drafts delete fehlgeschlagen:", codeDeleteError.message);
      }
    }

    const skippedNote =
      skipped.length > 0
        ? ` ${skipped.length} Eintrag/Einträge ohne Zuordnung wurden übersprungen.`
        : "";

    return NextResponse.json({
      message: `${committedFiles.length} Datei(en) veröffentlicht.${skippedNote}`,
      publishedFields: committedFields,
      publishedFiles: committedFiles,
      // Echter Versions-Stempel für den Aufbau-Check (Vercel meldet den Bau-Status daran)
      commitSha: lastCommitSha,
    });
  } catch (err) {
    console.error("Publish fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
