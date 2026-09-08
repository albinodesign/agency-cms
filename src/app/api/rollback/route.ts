import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getRepoFile } from "@/lib/github";
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

    const payload = (entry as PublishHistoryEntry).payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length === 0
    ) {
      return NextResponse.json(
        { error: "Diese Version enthält keinen wiederherstellbaren Payload." },
        { status: 400 }
      );
    }

    const octokit = createOctokit();
    let lastCommitSha: string | null = null;

    // Jede Datei im Payload auf den gespeicherten Stand zurücksetzen
    for (const [filePath, content] of Object.entries(payload)) {
      let sha: string;
      try {
        const file = await getRepoFile(octokit, typedSite.repo_owner, typedSite.repo_name, filePath);
        sha = file.sha;
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

      try {
        const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
          owner: typedSite.repo_owner,
          repo: typedSite.repo_name,
          path: filePath,
          message: COMMIT_MESSAGE,
          content: Buffer.from(
            JSON.stringify(content, null, 2),
            "utf-8"
          ).toString("base64"),
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
    }

    // Wiederherstellung als neue Version im Verlauf dokumentieren
    const { error: historyError } = await supabase.from("publish_history").insert({
      site_id: siteId,
      published_by: user.id ?? null,
      commit_sha: lastCommitSha,
      payload,
    });

    if (historyError) {
      console.error("publish_history insert (Rollback) fehlgeschlagen:", historyError);
    } else {
      console.log(
        `publish_history: Rollback für Site ${siteId} gespeichert (Commit ${lastCommitSha ?? "unbekannt"})`
      );
    }

    // Editor-Stand zurücksetzen: alle offenen Entwürfe der Site verwerfen
    const { error: deleteError } = await supabase
      .from("drafts")
      .delete()
      .eq("site_id", siteId);

    if (deleteError) {
      console.error("drafts delete (Rollback) fehlgeschlagen:", deleteError.message);
    }

    return NextResponse.json({
      message: `Version wiederhergestellt (${Object.keys(payload).length} Datei(en)).`,
    });
  } catch (err) {
    console.error("Rollback fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
