import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit } from "@/lib/github";
import type { Site } from "@/types/cms";

interface BackupPageProps {
  params: Promise<{ siteId: string }>;
}

/** Lädt das komplette Website-Repo als .zip herunter (1-Klick-Backup). */
export async function GET(_request: Request, { params }: BackupPageProps) {
  const { siteId } = await params;

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
    const { data } = await octokit.repos.downloadZipballArchive({
      owner: typedSite.repo_owner,
      repo: typedSite.repo_name,
      ref: "main",
    });
    const buffer = data as unknown as ArrayBuffer;
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${typedSite.repo_name}-backup.zip"`,
      },
    });
  } catch (err) {
    console.error("Backup-Download fehlgeschlagen:", err);
    return NextResponse.json(
      { error: "Backup konnte nicht erstellt werden. Bitte später erneut versuchen." },
      { status: 502 }
    );
  }
}
