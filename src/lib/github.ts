import { Octokit } from "@octokit/rest";
import type { CmsManifest, FieldType, ManifestField, ManifestSection } from "@/types/cms";

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

/** Erkennt Versionskonflikte (paralleler Push) anhand der GitHub-Meldung. */
export function isShaConflictError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /409|sha|conflict|does not match|stale|veraltet/i.test(msg);
}

/**
 * Kundentauglicher Grund für einen gescheiterten GitHub-Schreibvorgang (W12).
 * Bekannte Fälle bleiben verständlich, alles andere wird bewusst allgemein
 * gehalten – Rohmeldungen (Rate-Limits, Token-Hinweise, Pfade) gehören nur
 * ins Server-Protokoll, niemals an den Browser.
 */
export function githubFehlerGrund(err: unknown): string {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status: unknown }).status
      : null;
  if (status === 404) {
    return "Die Datei wurde inzwischen gelöscht oder verschoben.";
  }
  if (status === 409) {
    return "Gleichzeitige Änderung – bitte erneut versuchen.";
  }
  if (status === 403 || status === 429) {
    return "Der Zugriff ist gerade begrenzt – bitte in einer Minute erneut versuchen.";
  }
  return "Details stehen im Server-Protokoll – bitte erneut versuchen.";
}

export interface FileCommit {
  /** Dateipfad im Repo */
  file: string;
  /** Neuer Datei-Inhalt (UTF-8-Text) */
  text: string;
  /** Zuletzt gelesener SHA ("" = neue Datei) */
  sha: string;
}

export type CommitResult =
  | { ok: true; sha: string | null }
  | { ok: false; error: string };

/**
 * Committet eine Datei auf main (W3, gemeinsam für Publish und Rollback).
 * Bei SHA-Konflikt wird der frische Stand einmal über reloadSha() geladen
 * und erneut versucht – erst danach gilt der Commit als fehlgeschlagen.
 * Der Fehlertext ist kundentauglich (W12), die Rohmeldung landet nur im
 * Server-Protokoll.
 */
export async function commitFileWithRetry(
  octokit: Octokit,
  owner: string,
  repo: string,
  message: string,
  commit: FileCommit,
  reloadSha: () => Promise<string>
): Promise<CommitResult> {
  let sha = commit.sha;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data } = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: commit.file,
        message,
        content: Buffer.from(commit.text, "utf-8").toString("base64"),
        ...(sha ? { sha } : {}),
        branch: "main",
      });
      return { ok: true, sha: data.commit.sha ?? null };
    } catch (err) {
      if (attempt === 0 && isShaConflictError(err)) {
        try {
          sha = await reloadSha();
          continue;
        } catch {
          // Frisches Laden scheiterte ebenfalls – unten als Fehler melden
        }
      }
      console.error(
        `GitHub-Commit für "${commit.file}" fehlgeschlagen:`,
        err instanceof Error ? err.message : err
      );
      return {
        ok: false,
        error: `GitHub-Commit für "${commit.file}" fehlgeschlagen: ${githubFehlerGrund(err)}`,
      };
    }
  }
  return { ok: false, error: `GitHub-Commit für "${commit.file}" fehlgeschlagen.` };
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

/** Erlaubte Feldtypen; alles andere wird als "text" behandelt statt gelöscht. */
const ALLOWED_FIELD_TYPES: FieldType[] = [
  "text",
  "textarea",
  "image",
  "number",
  "email",
  "phone",
  "url",
  "date",
  "boolean",
];

function pickString(...values: unknown[]): string | undefined {
  return values.find(
    (v): v is string => typeof v === "string" && v.trim() !== ""
  );
}

/**
 * Normalisiert ein Roh-Feld in ein ManifestField.
 * Liefert null, wenn Pflichtangaben (id, file, path) fehlen.
 * Unbekannte Typen werden als "text" übernommen, das Label fällt auf
 * title bzw. id zurück. Hinweise (W16) machen stille Deutungen sichtbar,
 * damit Tippfehler im Website-Manifest auffallen statt zu wirken.
 */
function normalizeField(field: unknown, hinweise?: string[]): ManifestField | null {
  if (typeof field !== "object" || field === null) {
    hinweise?.push("Ein Eintrag ist kein Objekt und wurde weggelassen.");
    return null;
  }
  const f = field as Partial<ManifestField> & { title?: unknown };

  if (
    typeof f.id !== "string" ||
    typeof f.file !== "string" ||
    typeof f.path !== "string"
  ) {
    hinweise?.push("Ein Eintrag ohne id, Datei oder Pfad wurde weggelassen.");
    return null;
  }

  const type = ALLOWED_FIELD_TYPES.includes(f.type as FieldType)
    ? (f.type as FieldType)
    : "text";
  if (type === "text" && f.type !== undefined && f.type !== "text") {
    hinweise?.push(`Feld "${f.id}": Typ "${String(f.type)}" ist unbekannt und wird als Text behandelt.`);
  }

  return {
    ...f,
    id: f.id,
    label: pickString(f.label, f.title, f.id) ?? f.id,
    type,
    file: f.file,
    path: f.path,
  };
}

/**
 * Normalisiert das Manifest in ein einheitliches { sections: [...] }-Format.
 * Akzeptiert: Array von Sektionen, Array von Feldern, { sections: [...] }
 * oder { fields: [...] }. Ungültige Felder/Sektionen werden herausgefiltert.
 */
export function normalizeManifest(raw: unknown): CmsManifest {
  return normalizeManifestWithWarnings(raw).manifest;
}

/**
 * Wie normalizeManifest, meldet zusätzlich stille Deutungen (W16):
 * unbekannte Typen (→ Text), weggelassene Einträge, vergebene Fallback-
 * Kennungen und ausgeblendete leere Sektionen. Der Editor zeigt sie als
 * Warnung, damit Website-Tippfehler auffallen.
 */
export function normalizeManifestWithWarnings(raw: unknown): { manifest: CmsManifest; hinweise: string[] } {
  const hinweise: string[] = [];
  const candidate = Array.isArray(raw)
    ? raw
    : ((raw as CmsManifest)?.sections ?? (raw as { fields?: unknown[] })?.fields ?? []);

  if (!Array.isArray(candidate)) {
    return {
      manifest: {
        sections: [],
        features: Array.isArray(raw) ? undefined : (raw as CmsManifest)?.features,
      },
      hinweise,
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

  const sections: ManifestSection[] = [];
  rawSections
    .filter((s) => typeof s === "object" && s !== null)
    .forEach((s, index) => {
      const rawSection = s as ManifestSection & {
        section?: unknown;
        label?: unknown;
        sectionLabel?: unknown;
      };
      const id = pickString(rawSection.id, rawSection.section) ?? `section-${index}`;
      if (!pickString(rawSection.id, rawSection.section)) {
        hinweise.push(`Sektion ${index + 1} hat keine Kennung und heißt jetzt "${id}".`);
      }
      const fields = (Array.isArray(s.fields) ? s.fields : [])
        .map((f) => normalizeField(f, hinweise))
        .filter((f): f is ManifestField => f !== null);
      if (fields.length === 0) {
        hinweise.push(`Sektion "${id}" enthält keine gültigen Felder und wird ausgeblendet.`);
        return;
      }
      sections.push({
        id,
        title:
          pickString(rawSection.label, rawSection.title, rawSection.sectionLabel, rawSection.id, rawSection.section) ??
          `Sektion ${index + 1}`,
        fields,
        // page bleibt erhalten (gruppiert Editor-Tabs); ohne Angabe rät der Editor.
        ...(typeof rawSection.page === "string" && rawSection.page.trim() !== ""
          ? { page: rawSection.page.trim() }
          : {}),
      });
    });

  const features = Array.isArray(raw)
    ? undefined
    : (raw as CmsManifest)?.features;

  return { manifest: { sections, features }, hinweise };
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

/**
 * Lädt das Roh-Manifest (ein Abruf) für serverseitige Prüfungen:
 * Die Publish-Route validiert die Roh-Definition (IDs, Typen, Ziele),
 * bevor sie der normalisierten Form vertraut.
 */
export async function getManifestRaw(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<{ text: string; parsed: unknown }> {
  const { text } = await getRepoFile(octokit, owner, repo, MANIFEST_PATH);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Die Datei "${MANIFEST_PATH}" enthält kein gültiges JSON.`
    );
  }

  return { text, parsed };
}
