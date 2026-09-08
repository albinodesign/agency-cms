import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit } from "@/lib/github";
import type { PublishHistoryEntry, Site } from "@/types/cms";

const COMMIT_MESSAGE = "cms: rollback to historical version";

type Payload = Record<string, Record<string, unknown>>;

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
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
    }

    let body: { siteId?: string; historyId?: string; payload?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    const { siteId, historyId } = body;
    if (!siteId) {
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

    // Payload bestimmen: direkt mitgeschickt oder über historyId aus publish_history laden
    let payload: unknown = body.payload ?? null;

    if (!payload) {
      if (!historyId) {
        return NextResponse.json(
          { error: "historyId oder payload fehlt." },
          { status: 400 }
        );
      }

      const { data: entry, error: entryError } = await supabase
        .from("publish_history")
        .select("*")
        .eq("id", historyId)
        .eq("site_id", siteId)
        .single();

      if (entryError || !entry) {
        return NextResponse.json({ error: "Version nicht gefunden." }, { status: 404 });
      }

      payload = (entry as PublishHistoryEntry).payload;
    }

    if (!isValidPayload(payload)) {
      return NextResponse.json(
        {
          error:
            "Diese Version enthält keinen wiederherstellbaren Payload (erwartet: { dateipfad: { ... } }).",
        },
        { status: 400 }
      );
    }

    const octokit = createOctokit();
    let lastCommitSha: string | null = null;

    // Jede Datei im Payload: aktuellen SHA holen, alten Stand darüber committen
    for (const [filePath, oldContent] of Object.entries(payload)) {
      let currentSha: string;
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Rollback: SHA für "${filePath}" nicht ladbar:`, message);
        return NextResponse.json(
          { error: `GitHub-Fehler beim Laden von "${filePath}": ${message}` },
          { status: 500 }
        );
      }

      try {
        const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
          owner: typedSite.repo_owner,
          repo: typedSite.repo_name,
          path: filePath,
          message: COMMIT_MESSAGE,
          content: Buffer.from(JSON.stringify(oldContent, null, 2)).toString("base64"),
          sha: currentSha,
          branch: "main",
        });
        lastCommitSha = commitData.commit.sha ?? null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Rollback: Commit für "${filePath}" fehlgeschlagen:`, message);
        return NextResponse.json(
          { error: `GitHub-Fehler beim Committen von "${filePath}": ${message}` },
          { status: 500 }
        );
      }
    }

    // Alle offenen Drafts dieser Site verwerfen
    const { error: deleteError } = await supabase
      .from("drafts")
      .delete()
      .eq("site_id", siteId);

    if (deleteError) {
      console.error("Rollback: drafts delete fehlgeschlagen:", deleteError.message);
      return NextResponse.json(
        {
          error: `Rollback wurde committet, aber die Entwürfe konnten nicht gelöscht werden: ${deleteError.message}`,
        },
        { status: 500 }
      );
    }

    // Rollback als neuen Verlaufseintrag dokumentieren (mit Notiz "Rollback")
    const historyRow = {
      site_id: siteId,
      published_by: user.id ?? null,
      commit_sha: lastCommitSha,
      payload,
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

    return NextResponse.json({
      message: `Version erfolgreich wiederhergestellt (${Object.keys(payload).length} Datei(en) auf main committed).`,
      commitSha: lastCommitSha,
    });
  } catch (err) {
    console.error("Rollback fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
