export type FieldType =
  | "text"
  | "textarea"
  | "image"
  | "number"
  | "email"
  | "phone"
  | "url"
  | "date"
  | "boolean";

export interface ManifestField {
  /** Eindeutige Feld-ID, z. B. "hero.title" */
  id: string;
  label: string;
  type: FieldType;
  /** Pfad zur JSON-Datei im Repo, z. B. "src/content/pages/home.json" */
  file: string;
  /** Dot-Path innerhalb der JSON-Datei, z. B. "hero.title" */
  path: string;
  placeholder?: string;
  /** Optionale Zeichenbegrenzung für den Zeichenzähler */
  maxLength?: number;
  /** Optionales Bildformat aus dem Manifest, z. B. "16:9", "1:1", "4:3" */
  aspectRatio?: string;
}

export interface ManifestSection {
  id: string;
  title: string;
  fields: ManifestField[];
  /**
   * Optionale Seitenzuordnung (N3): Wenn die Agentur sie pflegt, gruppiert
   * der Editor danach statt nach Schlüsselwort-Heuristik.
   */
  page?: string;
}

export interface CmsManifest {
  sections: ManifestSection[];
  /** Optionale Feature-Flags, z. B. { blog: true } oder { blog: { enabled: true } } */
  features?: {
    blog?: boolean | { enabled?: boolean };
  };
}

export interface BlogFrontmatter {
  title: string;
  slug: string;
  date: string;
  coverImage: string;
  /** Alt-Text des Beitragsbilds (Fallback: Titel) */
  coverImageAlt?: string;
  excerpt: string;
  draft: boolean;
}

export interface BlogPost extends BlogFrontmatter {
  /** Repo-Pfad, z. B. "src/content/blog/mein-beitrag.md" */
  path: string;
  sha: string;
}

export interface Site {
  id: string;
  name: string;
  domain: string | null;
  preview_url: string;
  repo_owner: string;
  repo_name: string;
  created_at?: string;
  /** true = Kunde sieht den KI-Chat im Editor (Schalter im Dashboard) */
  ai_enabled?: boolean;
}

export interface Draft {
  id: string;
  site_id: string;
  field_id: string;
  value: string;
  updated_at: string;
}

export interface PublishHistoryEntry {
  id: string;
  site_id: string;
  published_by: string | null;
  commit_sha: string | null;
  /** Vollständige Datei-Inhalte, verschachtelt nach Dateipfad (nur bei Bedarf geladen, kann fehlen) */
  payload?: Record<string, Record<string, unknown>>;
  created_at: string;
  /** Optionale Notiz, z. B. "Rollback" oder "ai-chat" (Spalte kann fehlen) */
  note?: string | null;
  /** Dateiliste des Eintrags für metadaten-schlankes Laden (Spalte kann fehlen/legacy null sein) */
  files?: string[] | null;
}

export type DraftMap = Record<string, string>;

/** Freier Datei-Pfad als Entwurfs-ID: "json:<datei>:<pfad>", z. B. "json:src/content/pages/home.json:hero.title" */
export const FREE_DRAFT_PREFIX = "json:";

export interface CodeDraft {
  id: string;
  site_id: string;
  file_path: string;
  content: string;
  updated_at: string;
}

export interface AiConversation {
  id: string;
  site_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AiUsage {
  site_id: string;
  month: string;
  messages: number;
  prompt_tokens: number;
  completion_tokens: number;
}
