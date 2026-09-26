import { NextResponse } from "next/server";
import { requireSiteAccess } from "@/lib/auth";
import { createOctokit } from "@/lib/github";

interface StatusPageProps {
  params: Promise<{ siteId: string }>;
}

/**
 * Echter Aufbau-Status: GitHub sammelt pro Version die Bau-Meldungen
 * (Vercel meldet dort "läuft" / "fertig" / "fehlgeschlagen").
 * Der Editor fragt das nach dem Veröffentlichen ab – keine geratenen Zeiten mehr.
 */
export async function GET(request: Request, { params }: StatusPageProps) {
  const { siteId } = await params;
  const sha = new URL(request.url).searchParams.get("sha");

  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return NextResponse.json({ error: "Gültiger Versions-Stempel fehlt." }, { status: 400 });
  }

  // Zugriff prüfen (zentral: Session + user_sites + Site, src/lib/auth.ts)
  const access = await requireSiteAccess(siteId);
  if (!access.ok) return access.error;
  const typedSite = access.site;

  try {
    const octokit = createOctokit();
    const { data } = await octokit.repos.getCombinedStatusForRef({
      owner: typedSite.repo_owner,
      repo: typedSite.repo_name,
      ref: sha,
    });
    // state: "success" | "pending" | "failure" | "error"
    return NextResponse.json({ state: data.state, count: data.total_count });
  } catch (err) {
    console.error("Aufbau-Status fehlgeschlagen:", err);
    return NextResponse.json(
      { error: "Aufbau-Status konnte nicht abgefragt werden." },
      { status: 502 }
    );
  }
}
