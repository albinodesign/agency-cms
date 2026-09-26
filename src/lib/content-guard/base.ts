/**
 * Basis: Konstanten und kleine Helfer der Inhaltsprüfung (W1).
 * Gehört zu src/lib/content-guard.ts (Barrel) – keine Logik ändern.
 */
import { parsePathSafe } from "../json-path";
import type { FieldType } from "../../types/cms";

/** Die Feldliste selbst ist niemals ein normales Feldziel. */
export const MANIFEST_PATH = "src/content/cms.manifest.json";

/** Einzige erlaubte Einzeldatei neben dem Seiten-Ordner. */
export const SITE_JSON = "src/content/site.json";

/** Sichere Dateinamen für Seiten-JSONs: keine Pfadtrennzeichen, keine Punkte-Tricks. */
const PAGES_JSON = /^src\/content\/pages\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** Feldtypen, die der Server im Publish akzeptiert (kein stilles Umdeuten). */
export const SUPPORTED_FIELD_TYPES: FieldType[] = [
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

/** Sinnvolle Obergrenze für Textlängen-Vorgaben aus dem Manifest. */
export const MAX_MANIFEST_MAX_LENGTH = 10000;

/**
 * Prüft, ob eine Datei ein normales Inhaltsziel sein darf.
 * Lehnt absolute Pfade, Traversal (".."), Backslashes und Leerzeichen ab.
 */
export function isAllowedFieldJsonFile(file: unknown): boolean {
  if (typeof file !== "string" || file.length === 0 || file.length > 200) return false;
  if (
    file.includes("..") ||
    file.includes("\\") ||
    file.startsWith("/") ||
    /[\s]/.test(file)
  ) {
    return false;
  }
  if (file === MANIFEST_PATH) return false;
  return file === SITE_JSON || PAGES_JSON.test(file);
}

/** Prüft einen JSON-Pfad und liefert null wenn ok, sonst eine deutsche Meldung. */
export function validateJsonPath(path: unknown): string | null {
  const parsed = parsePathSafe(path);
  return parsed.ok ? null : parsed.error;
}

/**
 * Einheitlicher Zielschlüssel für den Duplikatcheck:
 * "items[0].title" und "items.0.title" ergeben dasselbe Ziel.
 * Liefert null bei ungültigem Pfad.
 */
export function canonicalTarget(file: string, path: string): string | null {
  const parsed = parsePathSafe(path);
  return parsed.ok ? `${file}#${parsed.canonical}` : null;
}

/** Prüft, ob ein Knoten ein reines Objekt ist (kein Array, kein null). */
export function isPlainObject(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** Einheitliche Schreibweise für Segmentlisten (wie json-path-kanonisch). */
export function segmentsToCanonical(segments: Array<string | number>): string {
  let out = "";
  segments.forEach((segment, index) => {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += (index === 0 ? "" : ".") + segment;
    }
  });
  return out;
}
