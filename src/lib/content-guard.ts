/**
 * Serverseitige Schutzprüfungen für normale JSON-Inhaltsziele.
 *
 * Grundsatz: Normale Inhaltsänderungen (Manifestfelder und freie JSON-Entwürfe)
 * dürfen ausschließlich diese Dateien verändern:
 * - src/content/site.json
 * - JSON-Dateien direkt unter src/content/pages/ (sichere Dateinamen)
 * Paket-, Konfigurations- und Manifestdateien sind keine Kundenfeldziele.
 * Das Blog-Format (Markdown) läuft über eine eigene, getrennte Route und bleibt
 * von diesen Regeln unberührt.
 *
 * Grenze (bewusst nicht umgebaut): Vollständige Datei-Entwürfe für Code
 * (Komponenten/Seiten/Layouts/Stile) und für die Feldliste selbst nutzen eigene
 * Regeln in der Publish-Route (Whitelist, Geheimnis-Scan, Brücken-Check,
 * Gültigkeits-Check). Diese Datei deckt nur normale Inhaltsziele ab.
 */
import { getByPath, getBySegments, parsePathSafe } from "./json-path";
import type { CmsManifest, FieldType } from "../types/cms";
import { FREE_DRAFT_PREFIX } from "../types/cms";

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
const MAX_MANIFEST_MAX_LENGTH = 10000;

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

/** Flacht ein Roh-Manifest (alle akzeptierten Formate) zu einer Feldliste ab. */
export function extractRawFields(raw: unknown): unknown[] {
  const candidate = Array.isArray(raw)
    ? raw
    : ((raw as { sections?: unknown; fields?: unknown } | null)?.sections ??
      (raw as { fields?: unknown } | null)?.fields ??
      []);
  if (!Array.isArray(candidate)) return [];
  const looksLikeSections = candidate.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      Array.isArray((item as { fields?: unknown }).fields)
  );
  if (!looksLikeSections) return candidate;
  const out: unknown[] = [];
  for (const section of candidate) {
    if (
      typeof section === "object" &&
      section !== null &&
      Array.isArray((section as { fields?: unknown }).fields)
    ) {
      out.push(...((section as { fields: unknown[] }).fields));
    }
  }
  return out;
}

interface RawField {
  id?: unknown;
  file?: unknown;
  path?: unknown;
  type?: unknown;
  maxLength?: unknown;
}

function fileTargetError(fieldLabel: string, file: string): string {
  if (file === "package.json" || file.endsWith("/package.json")) {
    return `Feld "${fieldLabel}": Die Datei "package.json" ist kein erlaubtes Inhaltsziel. Erlaubt sind ${SITE_JSON} und JSON-Dateien unter src/content/pages/.`;
  }
  if (file === MANIFEST_PATH || file.endsWith("cms.manifest.json")) {
    return `Feld "${fieldLabel}": Die Feldliste selbst ist kein bearbeitbares Inhaltsziel.`;
  }
  return `Feld "${fieldLabel}": Die Datei "${file}" ist kein erlaubtes Inhaltsziel. Erlaubt sind ${SITE_JSON} und JSON-Dateien unter src/content/pages/.`;
}

/**
 * Prüft die vom Server geladene Manifestdefinition gegen die tatsächlich
 * geladenen Datei-Inhalte. Liefert eine Liste deutscher Fehlermeldungen
 * (leer = alles ok). Prüft: vorhandene id, eindeutige IDs, unterstützte Typen,
 * sinnvolle maxLength, erlaubte Zieldatei, sicheren Pfad, eindeutige Ziele
 * (Schreibweisen-normiert) und tatsächliche Pfad-Existenz in der Datei.
 * Pfade, die im selben Änderungssatz durch eine akzeptierte Erstellung
 * (pendingCreations als "datei#kanonisch") entstehen, gelten als abgedeckt.
 */
export function validateFieldTargets(
  rawFields: unknown[],
  fileContents: Map<string, Record<string, unknown>>,
  pendingCreations: Set<string> = new Set()
): string[] {
  const errors: string[] = [];
  const seenIds = new Map<string, number>();
  const seenTargets = new Map<string, string>();

  rawFields.forEach((entry, index) => {
    const label = `Feld Nr. ${index + 1}`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${label} ist ungültig (kein Objekt).`);
      return;
    }
    const field = entry as RawField;
    const id =
      typeof field.id === "string" && field.id.trim() !== "" ? field.id : null;
    const name = id ?? label;
    if (!id) {
      errors.push(`${label} hat keine gültige id.`);
      return;
    }
    const firstSeen = seenIds.get(id);
    if (firstSeen !== undefined) {
      errors.push(`Feld "${id}" ist doppelt vergeben (auch ${label}).`);
    } else {
      seenIds.set(id, index);
    }

    if (!SUPPORTED_FIELD_TYPES.includes(field.type as FieldType)) {
      errors.push(
        `Feld "${id}": Typ "${String(field.type)}" wird nicht unterstützt (erlaubt: ${SUPPORTED_FIELD_TYPES.join(", ")}).`
      );
    }

    if (field.maxLength !== undefined && field.maxLength !== null) {
      if (
        !Number.isInteger(field.maxLength) ||
        (field.maxLength as number) < 1 ||
        (field.maxLength as number) > MAX_MANIFEST_MAX_LENGTH
      ) {
        errors.push(
          `Feld "${id}": maxLength muss eine ganze Zahl zwischen 1 und ${MAX_MANIFEST_MAX_LENGTH} sein.`
        );
      }
    }

    const file = typeof field.file === "string" ? field.file : "";
    if (!isAllowedFieldJsonFile(file)) {
      errors.push(fileTargetError(name, file || "(leer)"));
      return;
    }

    const pathProblem = validateJsonPath(field.path);
    if (pathProblem) {
      errors.push(`Feld "${id}": ${pathProblem}`);
      return;
    }
    const target = canonicalTarget(file, field.path as string) as string;
    const other = seenTargets.get(target);
    if (other !== undefined) {
      errors.push(
        `Feld "${id}" und Feld "${other}" zeigen auf dasselbe Ziel (${file}, Pfad "${field.path}").`
      );
    } else {
      seenTargets.set(target, id);
    }

    const json = fileContents.get(file);
    if (!json) {
      errors.push(`Feld "${id}": Datei "${file}" konnte nicht geladen werden.`);
      return;
    }
    if (getByPath(json, field.path as string) === undefined) {
      const target = canonicalTarget(file, field.path as string) as string;
      if (pendingCreations.has(target)) return; // entsteht im selben Satz
      errors.push(`Feld "${id}": Pfad "${field.path}" existiert nicht in Datei "${file}".`);
    }
  });

  return errors;
}

/** Sammelt die normierten Ziele aller gültigen Manifestfelder (für Free-Draft-Abgleich). */
export function collectManifestTargets(rawFields: unknown[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const entry of rawFields) {
    if (typeof entry !== "object" || entry === null) continue;
    const field = entry as RawField;
    if (typeof field.id !== "string" || typeof field.file !== "string") continue;
    if (!isAllowedFieldJsonFile(field.file)) continue;
    const target =
      typeof field.path === "string" ? canonicalTarget(field.file, field.path) : null;
    if (target && !targets.has(target)) targets.set(target, field.id);
  }
  return targets;
}

export type FreeDraftParse =
  | { ok: true; file: string; path: string; error: "" }
  | { ok: false; file: ""; path: ""; error: string };

/** Erlaubte Banner-Stile (muss zur Website-Darstellung passen). */
export const BANNER_VARIANTS = ["vacation", "emergency", "info"] as const;

/** Maximale Banner-Textlänge (muss zum Website-Layout passen). */
export const BANNER_TEXT_MAX = 160;

/** Generelle Wert-Obergrenze für freie Entwürfe (wie im KI-Werkzeug). */
export const FREE_VALUE_MAX = 20_000;

export interface FreeCreation {
  kind: "banner" | "append";
  file: string;
  canonical: string;
}

export type FreeClassify =
  | { ok: true; creation: FreeCreation | null; canonical: string }
  | { ok: false; error: string };

function isPlainObject(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/**
 * Enge Erstellungsregeln für freie Entwürfe (Ausnahmen vom Bestandsgebot):
 * - Bereits vorhandene Pfade: normales Schreiben.
 * - Banner-Felder (`banner.enabled|variant|text` in site.json): dürfen den
 *   `banner`-Behälter anlegen, Werte werden typgeprüft (an/aus, Stil-Enum,
 *   Textlänge). Das CMS besitzt dieses Modell (Banner-Schalter), die Website
 *   rendert `site.banner`.
 * - Listen-Ergänzung: Anhängen exakt am Ende einer bestehenden Liste, wahlweise
 *   als einzelner Wert oder als neues Element mit genau einem Feld
 *   (z. B. `items[3].frage` bei Länge 3 für eine neue FAQ-Frage).
 * Alles andere Neue (beliebige Schlüssel, tiefere Strukturen) wird abgelehnt.
 * Aufrufstellen: Publish-Route (vorab + Endkontrolle) und KI-Werkzeug
 * `schreibeInhalt` (frühe Rückmeldung).
 */
export function classifyFreeTarget(
  file: string,
  path: string,
  fileJson: Record<string, unknown> | undefined,
  value: string
): FreeClassify {
  const parsed = parsePathSafe(path);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const segments = parsed.segments;
  const canonical = `${file}#${parsed.canonical}`;

  if (fileJson && getBySegments(fileJson, segments) !== undefined) {
    return { ok: true, creation: null, canonical };
  }

  // Ausnahme 1: Banner-Modell (Besitzer: CMS-Banner-Schalter).
  if (
    file === SITE_JSON &&
    segments.length === 2 &&
    segments[0] === "banner" &&
    typeof segments[1] === "string"
  ) {
    const key = segments[1];
    const existing = fileJson?.banner;
    if (existing !== undefined && !isPlainObject(existing)) {
      return { ok: false, error: `Der Schlüssel "banner" in ${SITE_JSON} ist kein Objekt – Banner kann nicht angelegt werden.` };
    }
    const trimmed = value.trim();
    if (key === "enabled") {
      if (trimmed !== "true" && trimmed !== "false") {
        return { ok: false, error: `Banner-Schalter braucht "true" oder "false" (erhalten: "${value.slice(0, 40)}").` };
      }
    } else if (key === "variant") {
      if (!(BANNER_VARIANTS as readonly string[]).includes(trimmed)) {
        return { ok: false, error: `Banner-Stil muss einer von ${BANNER_VARIANTS.join(", ")} sein.` };
      }
    } else if (key === "text") {
      if (value.length > BANNER_TEXT_MAX) {
        return { ok: false, error: `Banner-Text ist zu lang (${value.length} von max. ${BANNER_TEXT_MAX} Zeichen).` };
      }
    } else {
      return { ok: false, error: `Unbekanntes Banner-Feld "${key}" (erlaubt: enabled, variant, text).` };
    }
    return { ok: true, creation: { kind: "banner", file, canonical }, canonical };
  }

  // Ausnahme 2: Listen-Ergänzung exakt am Ende einer bestehenden Liste.
  if (fileJson) {
    let node: unknown = fileJson;
    for (let k = 0; k < segments.length; k += 1) {
      const seg = segments[k];
      if (typeof seg === "number") {
        if (!Array.isArray(node)) break;
        if (seg < 0 || seg > node.length) break;
        if (seg === node.length) {
          const rest = segments.slice(k + 1);
          if (rest.length === 0 || (rest.length === 1 && typeof rest[0] === "string")) {
            if (value.length > FREE_VALUE_MAX) {
              return { ok: false, error: `Der Text ist zu lang (max. ${FREE_VALUE_MAX} Zeichen).` };
            }
            return { ok: true, creation: { kind: "append", file, canonical }, canonical };
          }
          break;
        }
        node = node[seg];
        continue;
      }
      if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, seg)) break;
      node = node[seg];
    }
  }

  return {
    ok: false,
    error: `Der Pfad "${path}" existiert nicht in Datei "${file}" – freie Entwürfe dürfen nur bestehende Pfade beschreiben oder ausdrücklich freigegebene Ergänzungen (Banner-Felder, Listen-Ergänzung am Ende) anlegen.`,
  };
}

/**
 * Zerlegt freie Entwurfs-IDs ("json:<datei>:<pfad>") und prüft Dateisperre
 * sowie Pfad-Sicherheit. Liefert einen Fehler statt still zu scheitern.
 */
export function parseFreeDraftIdSafe(id: unknown): FreeDraftParse {
  if (typeof id !== "string" || !id.startsWith(FREE_DRAFT_PREFIX)) {
    return { ok: false, file: "", path: "", error: "Keine freie Entwurfs-ID." };
  }
  const rest = id.slice(FREE_DRAFT_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) {
    return { ok: false, file: "", path: "", error: `Entwurf "${id}" hat kein gültiges Format (erwartet "json:<datei>:<pfad>").` };
  }
  const file = rest.slice(0, sep);
  const path = rest.slice(sep + 1);
  if (!isAllowedFieldJsonFile(file)) {
    return {
      ok: false,
      file: "",
      path: "",
      error: `Entwurf "${id}": Die Datei "${file || "(leer)"}" ist kein erlaubtes Inhaltsziel. Erlaubt sind ${SITE_JSON} und JSON-Dateien unter src/content/pages/.`,
    };
  }
  const pathProblem = validateJsonPath(path);
  if (pathProblem) {
    return { ok: false, file: "", path: "", error: `Entwurf "${id}": ${pathProblem}` };
  }
  return { ok: true, file, path, error: "" };
}

const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Findet verbotene Schlüssel in einem JSON-Wert (rekursiv, gegen
 * Prototyp-Verschmutzung beim späteren Einlesen).
 */
export function findDangerousKeys(value: unknown): string[] {
  const hits: string[] = [];
  const seen = new Set<object>();
  const stack: Array<{ node: unknown; path: string; depth: number }> = [
    { node: value, path: "$", depth: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as { node: unknown; path: string; depth: number };
    if (item.depth > 50) continue;
    if (typeof item.node !== "object" || item.node === null) continue;
    if (seen.has(item.node)) continue;
    seen.add(item.node);
    for (const key of Object.keys(item.node)) {
      const childPath = item.path === "$" ? key : `${item.path}.${key}`;
      if (DANGEROUS_KEYS.has(key)) hits.push(childPath);
      stack.push({
        node: (item.node as Record<string, unknown>)[key],
        path: childPath,
        depth: item.depth + 1,
      });
    }
  }
  return hits;
}

/** Prüft einen vollständigen Datei-Entwurf (JSON): Objekt, kein Array, keine Tricks. */
export function validateFullJsonDraft(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "Die Datei enthält kein gültiges JSON.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "Die Datei muss ein JSON-Objekt sein.";
  }
  const bad = findDangerousKeys(parsed);
  if (bad.length > 0) {
    return `Die Datei enthält verbotene Schlüssel (${bad.slice(0, 3).join(", ")}).`;
  }
  return null;
}

/** Stellt sicher, dass ein Manifest-Objekt keine leere Feldliste versteckt. */
export function manifestHasFields(manifest: CmsManifest): boolean {
  return manifest.sections.some((s) => s.fields.length > 0);
}
