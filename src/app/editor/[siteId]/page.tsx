import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifestRaw, getRepoFile, normalizeManifestWithWarnings } from "@/lib/github";
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
  // W16: Stille Manifest-Deutungen (Tippfehler der Website) für die Warnbox
  let manifestWarnings: string[] = [];
  const liveValues: DraftMap = {};

  try {
    const octokit = createOctokit();
    const { parsed } = await getManifestRaw(octokit, typedSite.repo_owner, typedSite.repo_name);
    const normalized = normalizeManifestWithWarnings(parsed);
    manifest = normalized.manifest;
    manifestWarnings = normalized.hinweise;

    // Alle referenzierten Content-Dateien laden – strikt nur .json,
    // damit z. B. Markdown-Dateien aus src/content/blog/ niemals an JSON.parse gehen.
    // W5: Parallel statt seriell (ein Abruf pro Datei, keine N-fache Wartezeit).
    const filePaths = [
      ...new Set(
        manifest.sections.flatMap((s) => s.fields.map((f) => f.file))
      ),
    ].filter((f) => f.endsWith(".json"));
    // site.json immer mitladen (für den Banner-Schnellschalter unten) –
    // ein Abruf im selben parallelen Satz statt zweitem Octokit.
    // Ein Fehlschlag dort warnt nur, wenn das Manifest die Datei referenziert
    // (sonst wäre es eine Geister-Meldung für eine optionale Datei).
    const manifestPaths = new Set(filePaths);
    if (!filePaths.includes("src/content/site.json")) {
      filePaths.push("src/content/site.json");
    }
    const fileContents = new Map<string, Record<string, unknown>>();
    const failedFiles: string[] = [];

    const loaded = await Promise.all(
      filePaths.map(async (filePath) => {
        try {
          const { text } = await getRepoFile(
            octokit,
            typedSite.repo_owner,
            typedSite.repo_name,
            filePath
          );
          return { filePath, json: JSON.parse(text) as Record<string, unknown> };
        } catch (err) {
          console.error(
            `Content-Datei "${filePath}" konnte nicht geladen werden:`,
            err instanceof Error ? err.message : err
          );
          return { filePath, json: null };
        }
      })
    );
    for (const { filePath, json } of loaded) {
      if (json) fileContents.set(filePath, json);
      else if (manifestPaths.has(filePath)) failedFiles.push(filePath);
      else {
        console.error(
          `Optionale Datei "src/content/site.json" konnte nicht geladen werden (kein Banner-Seed).`
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

    // Banner-Schnellschalter: Live-Werte aus site.json seeden (auch ohne Manifest-Felder),
    // damit Schalter, Undo und Diff von Anfang an den echten Stand zeigen.
    // Die Datei liegt flach (banner.enabled) – getSite() liefert sie direkt als "site".
    // W5: Bereits geladenen Stand wiederverwenden (kein zweiter Abruf derselben Datei).
    const siteData = fileContents.get("src/content/site.json");
    const bannerData =
      siteData && typeof siteData.banner === "object" && siteData.banner !== null
        ? (siteData.banner as Record<string, unknown>)
        : null;
    if (bannerData) {
      if (typeof bannerData.enabled === "boolean") {
        liveValues["json:src/content/site.json:banner.enabled"] = String(bannerData.enabled);
      }
      if (typeof bannerData.variant === "string") {
        liveValues["json:src/content/site.json:banner.variant"] = bannerData.variant;
      }
      if (typeof bannerData.text === "string") {
        liveValues["json:src/content/site.json:banner.text"] = bannerData.text;
      }
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
      manifestWarnings={manifestWarnings}
      contentWarning={contentWarning}
      initialValues={initialValues}
      liveValues={liveValues}
      draftFields={Object.keys(drafts)}
    />
  );
}
