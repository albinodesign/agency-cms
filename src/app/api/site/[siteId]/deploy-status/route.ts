import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit } from "@/lib/github";
import type { Site } from "@/types/cms";

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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
  }

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
