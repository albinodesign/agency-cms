import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifest } from "@/lib/github";
import { EditorClient } from "@/components/editor/EditorClient";
import type { CmsManifest, Draft, DraftMap, Site } from "@/types/cms";

export const dynamic = "force-dynamic";

interface EditorPageProps {
  params: Promise<{ siteId: string }>;
}

export default async function EditorPage({ params }: EditorPageProps) {
  const { siteId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Zugriff prüfen: Site muss dem Nutzer zugeordnet sein
  const { data: assignment } = await supabase
    .from("user_sites")
    .select("site_id")
    .eq("user_id", user.id)
    .eq("site_id", siteId)
    .maybeSingle();

  if (!assignment) {
    notFound();
  }

  const { data: site, error: siteError } = await supabase
    .from("sites")
    .select("*")
    .eq("id", siteId)
    .single();

  if (siteError || !site) {
    notFound();
  }

  const { data: draftRows } = await supabase
    .from("drafts")
    .select("*")
    .eq("site_id", siteId);

  const drafts: DraftMap = {};
  (draftRows as Draft[] | null)?.forEach((d) => {
    drafts[d.field_id] = d.value;
  });

  let manifest: CmsManifest | null = null;
  let manifestError: string | null = null;
  try {
    const octokit = createOctokit();
    manifest = await getManifest(
      octokit,
      (site as Site).repo_owner,
      (site as Site).repo_name
    );
  } catch (err) {
    manifestError =
      err instanceof Error
        ? err.message
        : "Das CMS-Manifest konnte nicht aus dem Repository geladen werden.";
  }

  return (
    <EditorClient
      site={site as Site}
      manifest={manifest}
      manifestError={manifestError}
      initialDrafts={drafts}
    />
  );
}
