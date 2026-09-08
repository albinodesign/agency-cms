export type FieldType = "text" | "textarea" | "image";

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
}

export interface ManifestSection {
  id: string;
  title: string;
  fields: ManifestField[];
}

export interface CmsManifest {
  sections: ManifestSection[];
}

export interface Site {
  id: string;
  name: string;
  domain: string | null;
  preview_url: string;
  repo_owner: string;
  repo_name: string;
  created_at?: string;
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
  user_id: string;
  user_email: string | null;
  snapshot: Record<string, string>;
  created_at: string;
}

export type DraftMap = Record<string, string>;
