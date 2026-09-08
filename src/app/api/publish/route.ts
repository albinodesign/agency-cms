import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifest, getRepoFile } from "@/lib/github";
import { setByPath } from "@/lib/json-path";
import type { Draft, Site } from "@/types/cms";

const COMMIT_MESSAGE = "cms: update content by client";

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
    const payload: Record<string, Record<string, unknown>> = {};
    let lastCommitSha: string | null = null;

    for (const [filePath, fileDrafts] of draftsByFile) {
      let json: Record<string, unknown>;
      let sha: string;
      try {
        const file = await getRepoFile(octokit, typedSite.repo_owner, typedSite.repo_name, filePath);
        sha = file.sha;
        json = JSON.parse(file.text) as Record<string, unknown>;
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

      for (const draft of fileDrafts) {
        const field = fieldMap.get(draft.field_id)!;
        setByPath(json, field.path, draft.value);
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

    // Publizierte Entwürfe löschen
    const { error: deleteError } = await supabase
      .from("drafts")
      .delete()
      .eq("site_id", siteId)
      .in("field_id", committedFields);

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
