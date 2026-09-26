import { NextResponse } from "next/server";
import { requireSiteAccess } from "@/lib/auth";
import { createOctokit } from "@/lib/github";

interface BackupPageProps {
  params: Promise<{ siteId: string }>;
}

/** Lädt das komplette Website-Repo als .zip herunter (1-Klick-Backup). */
export async function GET(_request: Request, { params }: BackupPageProps) {
  const { siteId } = await params;

  // Zugriff prüfen (zentral: Session + user_sites + Site, src/lib/auth.ts)
  const access = await requireSiteAccess(siteId);
  if (!access.ok) return access.error;
  const typedSite = access.site;

  try {
    const octokit = createOctokit();
    const { data } = await octokit.repos.downloadZipballArchive({
      owner: typedSite.repo_owner,
      repo: typedSite.repo_name,
      ref: "main",
    });
    const buffer = data as unknown as ArrayBuffer;
    // Dateiname gegen Header-Injection härten: Quotes, Zeilenumbrüche und
    // Sonderzeichen aus dem (adminseitig geprüften) Repo-Namen entfernen.
    const safeName =
      typedSite.repo_name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 100) ||
      "website";
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName}-backup.zip"`,
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
