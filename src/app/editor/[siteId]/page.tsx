import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifest, getRepoFile } from "@/lib/github";
import { getByPath } from "@/lib/json-path";
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

  const typedSite = site as Site;

  const { data: draftRows } = await supabase
    .from("drafts")
    .select("*")
    .eq("site_id", siteId);

  const drafts: DraftMap = {};
  (draftRows as Draft[] | null)?.forEach((d) => {
    drafts[d.field_id] = d.value;
  });

  // Manifest + aktuelle Inhaltsdateien aus GitHub laden
  let manifest: CmsManifest | null = null;
  let manifestError: string | null = null;
  let contentWarning: string | null = null;
  const liveValues: DraftMap = {};

  try {
    const octokit = createOctokit();
    manifest = await getManifest(octokit, typedSite.repo_owner, typedSite.repo_name);

    // Alle referenzierten Content-Dateien einmalig laden
    const filePaths = [
      ...new Set(
        manifest.sections.flatMap((s) => s.fields.map((f) => f.file))
      ),
    ];
    const fileContents = new Map<string, Record<string, unknown>>();
    const failedFiles: string[] = [];

    for (const filePath of filePaths) {
      try {
        const { text } = await getRepoFile(
          octokit,
          typedSite.repo_owner,
          typedSite.repo_name,
          filePath
        );
        fileContents.set(filePath, JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        failedFiles.push(filePath);
        console.error(
          `Content-Datei "${filePath}" konnte nicht geladen werden:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Live-Werte per Dot-Path aus den Dateien extrahieren
    for (const section of manifest.sections) {
      for (const field of section.fields) {
        const json = fileContents.get(field.file);
        if (!json) continue;
        const value = getByPath(json, field.path);
        if (typeof value === "string") {
          liveValues[field.id] = value;
        } else if (value !== null && value !== undefined) {
          liveValues[field.id] = String(value);
        }
      }
    }

    if (failedFiles.length > 0) {
      contentWarning = `Einige Inhaltsdateien konnten nicht geladen werden: ${failedFiles.join(
        ", "
      )}. Betroffene Felder sind leer.`;
    }
  } catch (err) {
    manifestError =
      err instanceof Error
        ? err.message
        : "Das CMS-Manifest konnte nicht aus dem Repository geladen werden.";
  }

  // Drafts überschreiben Live-Werte
  const initialValues: DraftMap = { ...liveValues, ...drafts };

  return (
    <EditorClient
      site={typedSite}
      manifest={manifest}
      manifestError={manifestError}
      contentWarning={contentWarning}
      initialValues={initialValues}
      draftFields={Object.keys(drafts)}
    />
  );
}
