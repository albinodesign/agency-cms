import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifest, getRepoFile } from "@/lib/github";
import { setByPath } from "@/lib/json-path";
import type { PublishHistoryEntry, Site } from "@/types/cms";

const COMMIT_MESSAGE = "cms: rollback by client";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
    }

    let body: { siteId?: string; historyId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    const { siteId, historyId } = body;
    if (!siteId || !historyId) {
      return NextResponse.json({ error: "siteId oder historyId fehlt." }, { status: 400 });
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

    // History-Eintrag laden
    const { data: entry, error: entryError } = await supabase
      .from("publish_history")
      .select("*")
      .eq("id", historyId)
      .eq("site_id", siteId)
      .single();

    if (entryError || !entry) {
      return NextResponse.json({ error: "Version nicht gefunden." }, { status: 404 });
    }

    const snapshot = (entry as PublishHistoryEntry).snapshot ?? {};
    const snapshotFields = Object.keys(snapshot);
    if (snapshotFields.length === 0) {
      return NextResponse.json(
        { error: "Diese Version enthält keinen Snapshot." },
        { status: 400 }
      );
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

    // Snapshot-Felder nach Zieldatei gruppieren
    const byFile = new Map<string, { path: string; value: string }[]>();
    for (const fieldId of snapshotFields) {
      const field = fieldMap.get(fieldId);
      if (!field) continue;
      const list = byFile.get(field.file) ?? [];
      list.push({ path: field.path, value: snapshot[fieldId] });
      byFile.set(field.file, list);
    }

    if (byFile.size === 0) {
      return NextResponse.json(
        { error: "Der Snapshot konnte keinen Feldern im Manifest zugeordnet werden." },
        { status: 400 }
      );
    }

    // Dateien laden, Snapshot-Werte anwenden, committen
    const restoredFields: string[] = [];
    for (const [filePath, entries] of byFile) {
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

      for (const { path, value } of entries) {
        setByPath(json, path, value);
      }

      try {
        await octokit.repos.createOrUpdateFileContents({
          owner: typedSite.repo_owner,
          repo: typedSite.repo_name,
          path: filePath,
          message: COMMIT_MESSAGE,
          content: Buffer.from(JSON.stringify(json, null, 2), "utf-8").toString("base64"),
          sha,
          branch: "main",
        });
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

      restoredFields.push(
        ...snapshotFields.filter((id) => fieldMap.get(id)?.file === filePath)
      );
    }

    // Wiederherstellung als neue Version im Verlauf dokumentieren
    await supabase.from("publish_history").insert({
      site_id: siteId,
      user_id: user.id,
      user_email: user.email ?? null,
      snapshot,
    });

    // Editor-Stand zurücksetzen: Drafts der wiederhergestellten Felder löschen
    await supabase
      .from("drafts")
      .delete()
      .eq("site_id", siteId)
      .in("field_id", restoredFields);

    return NextResponse.json({
      message: `Version wiederhergestellt (${restoredFields.length} Feld(er)).`,
      restoredFields,
    });
  } catch (err) {
    console.error("Rollback fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
