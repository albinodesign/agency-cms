import { Octokit } from "@octokit/rest";
import type { CmsManifest, ManifestField, ManifestSection } from "@/types/cms";

export function createOctokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN ist nicht gesetzt.");
  }
  return new Octokit({ auth: token });
}

export const MANIFEST_PATH = "src/content/cms.manifest.json";

interface GitHubFileContent {
  content: string;
  sha: string;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

/** Lädt eine Datei aus dem Repo und dekodiert sie (Base64 -> UTF-8). */
export async function getRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string
): Promise<{ text: string; sha: string }> {
  let data;
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: "main",
    });
    data = response.data;
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(
        `Die Datei "${path}" existiert nicht im Repository ${owner}/${repo} (Branch: main).`
      );
    }
    throw err;
  }

  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`"${path}" ist keine Datei im Repository.`);
  }

  const file = data as unknown as GitHubFileContent;
  if (typeof file.content !== "string") {
    throw new Error(`Die Datei "${path}" hat keinen lesbaren Inhalt.`);
  }

  const text = Buffer.from(file.content, "base64").toString("utf-8");
  return { text, sha: file.sha };
}

function isValidField(field: unknown): field is ManifestField {
  const f = field as ManifestField;
  return (
    typeof f === "object" &&
    f !== null &&
    typeof f.id === "string" &&
    typeof f.label === "string" &&
    ["text", "textarea", "image"].includes(f.type) &&
    typeof f.file === "string" &&
    typeof f.path === "string"
  );
}

/**
 * Normalisiert das Manifest in ein einheitliches { sections: [...] }-Format.
 * Akzeptiert: Array von Sektionen, Array von Feldern, { sections: [...] }
 * oder { fields: [...] }. Ungültige Felder/Sektionen werden herausgefiltert.
 */
export function normalizeManifest(raw: unknown): CmsManifest {
  const candidate = Array.isArray(raw)
    ? raw
    : ((raw as CmsManifest)?.sections ?? (raw as { fields?: unknown[] })?.fields ?? []);

  if (!Array.isArray(candidate)) {
    return {
      sections: [],
      features: Array.isArray(raw) ? undefined : (raw as CmsManifest)?.features,
    };
  }

  // Unterscheidung: Array von Sektionen (mit .fields) oder flaches Feld-Array
  const looksLikeSections = candidate.some(
    (item) => typeof item === "object" && item !== null && Array.isArray((item as ManifestSection).fields)
  );

  const rawSections: ManifestSection[] = looksLikeSections
    ? (candidate as ManifestSection[])
    : [
        {
          id: "content",
          title: "Inhalte",
          fields: candidate as ManifestField[],
        },
      ];

  const sections = rawSections
    .filter((s) => typeof s === "object" && s !== null)
    .map((s, index) => ({
      id: typeof s.id === "string" ? s.id : `section-${index}`,
      title: typeof s.title === "string" ? s.title : `Sektion ${index + 1}`,
      fields: (Array.isArray(s.fields) ? s.fields : []).filter(isValidField),
    }))
    .filter((s) => s.fields.length > 0);

  const features = Array.isArray(raw)
    ? undefined
    : (raw as CmsManifest)?.features;

  return { sections, features };
}

export async function getManifest(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<CmsManifest> {
  const { text } = await getRepoFile(octokit, owner, repo, MANIFEST_PATH);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Die Datei "${MANIFEST_PATH}" enthält kein gültiges JSON.`
    );
  }

  return normalizeManifest(parsed);
}
