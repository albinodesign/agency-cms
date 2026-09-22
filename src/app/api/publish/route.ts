import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifest, getRepoFile } from "@/lib/github";
import { setByPath } from "@/lib/json-path";
import type { Draft, FieldType, Site } from "@/types/cms";

const COMMIT_MESSAGE = "cms: update content by client";

/**
 * Prüft einen Entwurfswert gegen den Feldtyp aus dem Manifest.
 * Liefert null wenn ok, sonst eine deutsche Fehlermeldung für den Kunden.
 * Leere Werte sind erlaubt (Feld leeren) – Pflichtfelder kennt das Manifest nicht.
 */
function validateDraftValue(
  type: FieldType,
  value: string,
  maxLength?: number
): string | null {
  if (maxLength != null && value.length > maxLength) {
    return `Text ist zu lang (${value.length} von max. ${maxLength} Zeichen).`;
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  switch (type) {
    case "number":
      if (!/^[-+]?\d+([.,]\d+)?$/.test(trimmed)) {
        return `"${value}" ist keine gültige Zahl (erlaubt z. B. "42" oder "19,90").`;
      }
      return null;
    case "email":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
        return `"${value}" ist keine gültige E-Mail-Adresse.`;
      }
      return null;
    case "url":
    case "image":
      try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return `"${value}" muss mit http:// oder https:// beginnen (oder als Bild aus der Galerie hochgeladen werden).`;
        }
      } catch {
        // Relative Pfade wie "/bilder/foto.jpg" gelten lassen
        if (!trimmed.startsWith("/")) {
          return `"${value}" ist keine gültige Internetadresse.`;
        }
      }
      return null;
    case "phone":
      if (!/^[+()\d][\d\s/().-]{4,}$/.test(trimmed)) {
        return `"${value}" sieht nicht wie eine Telefonnummer aus.`;
      }
      return null;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
        return `"${value}" ist kein gültiges Datum (Format: JJJJ-MM-TT).`;
      }
      return null;
    default:
      return null;
  }
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

    // Alle Entwürfe dieser Site laden
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

    const typedDrafts = (drafts ?? []) as Draft[];
    if (typedDrafts.length === 0) {
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

    // Entwürfe nach Zieldatei gruppieren
    const draftsByFile = new Map<string, Draft[]>();
    const skipped: string[] = [];
    for (const draft of typedDrafts) {
      const field = fieldMap.get(draft.field_id);
      if (!field) {
        skipped.push(draft.field_id);
        continue;
      }
      const list = draftsByFile.get(field.file) ?? [];
      list.push(draft);
      draftsByFile.set(field.file, list);
    }

    if (draftsByFile.size === 0) {
      return NextResponse.json(
        { error: "Keine Entwürfe konnten Feldern im Manifest zugeordnet werden." },
        { status: 400 }
      );
    }

    // Dateien aus GitHub laden, aktualisieren und committen
    const committedFields: string[] = [];
    // Primärschlüssel der tatsächlich publizierten Entwürfe: Beim Löschen werden
    // nur exakt diese IDs entfernt, damit während des Publish-Vorgangs neu
    // getippte Entwürfe niemals verloren gehen
    const committedDraftIds: string[] = [];
    const payload: Record<string, Record<string, unknown>> = {};
    let lastCommitSha: string | null = null;

    // Phase 1: ALLE Dateien vorab laden + ALLE Werte prüfen.
    // Erst wenn alles ok ist, wird überhaupt etwas committet.
    // So gibt es keinen halben Live-Stand mehr (Hälfte neu, Hälfte alt).
    const fileJson = new Map<string, { json: Record<string, unknown>; sha: string }>();
    for (const [filePath] of draftsByFile) {
      // Ausschließlich JSON-Dateien verarbeiten (kein JSON.parse auf Markdown o. ä.)
      if (!filePath.endsWith(".json")) {
        continue;
      }
      try {
        const file = await getRepoFile(octokit, typedSite.repo_owner, typedSite.repo_name, filePath);
        fileJson.set(filePath, {
          json: JSON.parse(file.text) as Record<string, unknown>,
          sha: file.sha,
        });
      } catch (err) {
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

    // Alle Entwurfswerte gegen ihren Feldtyp prüfen, bevor irgendwas live geht
    const validationErrors: string[] = [];
    for (const [filePath, fileDrafts] of draftsByFile) {
      if (!filePath.endsWith(".json")) {
        skipped.push(...fileDrafts.map((d) => d.field_id));
        continue;
      }
      for (const draft of fileDrafts) {
        const field = fieldMap.get(draft.field_id)!;
        const problem = validateDraftValue(field.type, draft.value, field.maxLength);
        if (problem) {
          validationErrors.push(`${field.label}: ${problem}`);
        }
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

    // Phase 2: jetzt erst schreiben + committen (alles wurde oben geprüft)
    for (const [filePath, fileDrafts] of draftsByFile) {
      if (!filePath.endsWith(".json")) {
        continue;
      }
      const loaded = fileJson.get(filePath);
      if (!loaded) continue;
      const { json, sha } = loaded;

      for (const draft of fileDrafts) {
        const field = fieldMap.get(draft.field_id)!;
        // Zahlen als echte Zahlen speichern (nicht als Text), sonst meckert
        // die strenge Prüfung auf der Website und der Bau schlägt fehl
        let stored: unknown = draft.value;
        if (field.type === "number" && draft.value.trim() !== "") {
          stored = Number(draft.value.trim().replace(",", "."));
        }
        setByPath(json, field.path, stored);
      }

      try {
        const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
          owner: typedSite.repo_owner,
          repo: typedSite.repo_name,
          path: filePath,
          message: COMMIT_MESSAGE,
          content: Buffer.from(JSON.stringify(json, null, 2), "utf-8").toString("base64"),
          sha,
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

      committedFields.push(...fileDrafts.map((d) => d.field_id));
      committedDraftIds.push(...fileDrafts.map((d) => d.id));
      // Vollständiges, aktualisiertes JSON-Objekt der Datei für den Verlauf merken
      payload[filePath] = json;
    }

    // Snapshot in publish_history speichern (vollständiger Payload pro Datei)
    const { error: historyError } = await supabase.from("publish_history").insert({
      site_id: siteId,
      published_by: user.id ?? null,
      commit_sha: lastCommitSha,
      payload,
    });

    if (historyError) {
      // Der GitHub-Commit ist bereits erfolgt – Fehler laut melden statt verschlucken
      console.error("publish_history insert fehlgeschlagen:", historyError);
      return NextResponse.json(
        {
          error: `Die Änderungen wurden zu GitHub übertragen, aber der Verlaufseintrag konnte nicht gespeichert werden: ${historyError.message}`,
        },
        { status: 500 }
      );
    }

    console.log(
      `publish_history: Eintrag für Site ${siteId} gespeichert (Commit ${lastCommitSha ?? "unbekannt"}, ${committedFields.length} Feld(er))`
    );

    // Publizierte Entwürfe löschen – nur exakt die zuvor geladenen und
    // committeten Primärschlüssel (kein Datenverlust bei parallelen Änderungen)
    const { error: deleteError } = await supabase
      .from("drafts")
      .delete()
      .eq("site_id", siteId)
      .in("id", committedDraftIds);

    if (deleteError) {
      console.error("drafts delete fehlgeschlagen:", deleteError.message);
    }

    const skippedNote =
      skipped.length > 0
        ? ` ${skipped.length} Feld(er) ohne Manifest-Zuordnung wurden übersprungen.`
        : "";

    return NextResponse.json({
      message: `${committedFields.length} Änderung(en) veröffentlicht.${skippedNote}`,
      publishedFields: committedFields,
    });
  } catch (err) {
    console.error("Publish fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
