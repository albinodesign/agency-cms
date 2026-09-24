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
import type { CmsManifest, FieldType, ManifestField } from "../types/cms";
import { FREE_DRAFT_PREFIX } from "../types/cms";
import { convertStoredValue, validateFinalJsonValue } from "./validate";

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

/** Prüft einen Banner-Wert – gilt beim Anlegen UND auf vorhandenen Pfaden. */
export function validateBannerValue(key: string, value: string): string | null {
  const trimmed = value.trim();
  if (key === "enabled") {
    if (trimmed !== "true" && trimmed !== "false") {
      return `Banner-Schalter braucht "true" oder "false" (erhalten: "${value.slice(0, 40)}").`;
    }
    return null;
  }
  if (key === "variant") {
    if (!(BANNER_VARIANTS as readonly string[]).includes(trimmed)) {
      return `Banner-Stil muss einer von ${BANNER_VARIANTS.join(", ")} sein.`;
    }
    return null;
  }
  if (key === "text") {
    if (value.length > BANNER_TEXT_MAX) {
      return `Banner-Text ist zu lang (${value.length} von max. ${BANNER_TEXT_MAX} Zeichen).`;
    }
    return null;
  }
  return `Unbekanntes Banner-Feld "${key}" (erlaubt: enabled, variant, text).`;
}

/** Zieltyp eines Banner-Pfads (für einheitliche Validierung/Umwandlung). */
export function bannerTargetType(key: string): FieldType {
  return key === "enabled" ? "boolean" : "text";
}

/** Maximale Länge eines Banner-Pfads (nur Text hat eine). */
export function bannerMaxLength(key: string): number | undefined {
  return key === "text" ? BANNER_TEXT_MAX : undefined;
}

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

export function isPlainObject(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/**
 * Enge Erstellungsregeln für freie Entwürfe (Ausnahmen vom Bestandsgebot):
 * - Bereits vorhandene Pfade: normales Schreiben.
 * - Banner-Felder (`banner.enabled|variant|text` in site.json): dürfen den
 *   `banner`-Behälter anlegen, Werte werden typgeprüft (an/aus, Stil-Enum,
 *   Textlänge). Das CMS besitzt dieses Modell (Banner-Schalter), die Website
 *   rendert `site.banner`.
 * - Listen-Ergänzung: Anhängen exakt am Ende einer bestehenden Liste
 *   (gegen den LIVE-Stand geprüft), wahlweise als einzelner Wert oder als
 *   neues Element mit genau einem Feld
 *   (z. B. `items[3].frage` bei Länge 3 für eine neue FAQ-Frage).
 * Alles andere Neue (beliebige Schlüssel, tiefere Strukturen) wird abgelehnt.
 * Ob eine Listen-Ergänzung veröffentlichbar ist, entscheidet NICHT diese
 * Einordnung, sondern die gemeinsame Strukturprüfung (validateListStructures)
 * anhand ausdrücklicher Listenmodelle – Nachbareinträge allein begründen
 * keine Pflichtfelder (siehe DYNAMIC_LIST_MODELS).
 * Aufrufstellen: Publish-Route (vorab + Endkontrolle) und KI-Werkzeug
 * `schreibeInhalt` (frühe Rückmeldung).
 */
export function classifyFreeTarget(
  file: string,
  path: string,
  fileJson: Record<string, unknown> | undefined,
  value: string,
  candidateJson?: Record<string, unknown>
): FreeClassify {
  const parsed = parsePathSafe(path);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const segments = parsed.segments;
  const canonical = `${file}#${parsed.canonical}`;

  // Banner-Werte gelten immer – auch auf bereits vorhandenen Pfaden.
  // So kann z. B. variant="party" nicht durchschlüpfen, nur weil der Pfad existiert.
  const bannerKey =
    file === SITE_JSON &&
    segments.length === 2 &&
    segments[0] === "banner" &&
    typeof segments[1] === "string"
      ? segments[1]
      : null;
  if (bannerKey) {
    const bannerProblem = validateBannerValue(bannerKey, value);
    if (bannerProblem) return { ok: false, error: bannerProblem };
  }

  // Bestand zählt inklusive bereits gespeicherter Entwürfe (falls übergeben):
  // So bleibt ein erlaubter begonnener Eintrag vervollständigbar und eine
  // Korrektur desselben Pfads ein normales Schreiben. Die Ergänzungsprüfung
  // darunter läuft bewusst gegen den Live-Stand (fileJson).
  const base = candidateJson ?? fileJson;
  if (base && getBySegments(base, segments) !== undefined) {
    return { ok: true, creation: null, canonical };
  }

  // Ausnahme 1: Banner-Modell (Besitzer: CMS-Banner-Schalter).
  // Der Wert wurde oben bereits geprüft – hier nur noch die Struktur.
  if (bannerKey) {
    const existing = fileJson?.banner;
    if (existing !== undefined && !isPlainObject(existing)) {
      return { ok: false, error: `Der Schlüssel "banner" in ${SITE_JSON} ist kein Objekt – Banner kann nicht angelegt werden.` };
    }
    return { ok: true, creation: { kind: "banner", file, canonical }, canonical };
  }

  // Ausnahme 2: Listen-Ergänzung exakt am Ende einer bestehenden Liste
  // (Live-Stand in fileJson – candidateJson zählt hier nicht, damit eine
  // Fortsetzung wie items[2].antwort nach items[2].frage erkannt wird).
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

/** Aufgelöster Zieltyp: Manifestfeld, Banner-Regel oder freier Text. */
export interface ResolvedTarget {
  type: FieldType;
  maxLength?: number;
  label: string;
  via: "manifest" | "banner" | "frei";
}

/**
 * Löst den Typ eines Inhaltsziels einheitlich auf – unabhängig vom
 * Zugriffsweg (Manifestfeld oder freier Alias). Ein freier Alias auf ein
 * deklariertes Manifestziel erbt dessen Typ, maxLength und Label. So kann
 * z. B. kein Alias die Längenbegrenzung umgehen und Zahlen werden auch über
 * Alias als Zahlen gespeichert.
 */
export function resolveTargetType(
  canonical: string,
  manifestByCanonical: Map<string, ManifestField>,
  file: string,
  segments: Array<string | number>
): ResolvedTarget {
  const declared = manifestByCanonical.get(canonical);
  if (declared) {
    return { type: declared.type, maxLength: declared.maxLength, label: declared.label, via: "manifest" };
  }
  if (
    file === SITE_JSON &&
    segments.length === 2 &&
    segments[0] === "banner" &&
    typeof segments[1] === "string"
  ) {
    const key = segments[1];
    return {
      type: bannerTargetType(key),
      maxLength: bannerMaxLength(key),
      label: `Banner-${key}`,
      via: "banner",
    };
  }
  const leaf = segments[segments.length - 1];
  return { type: "text", label: String(leaf), via: "frei" };
}

/**
 * Erforderliche Schlüssel eines Listen-Elements: Schnittmenge der Schlüssel
 * aller vorhandenen Objekt-Elemente.
 *
 * ACHTUNG (1d): Diese Ableitung aus Nachbareinträgen ist KEINE verlässliche
 * Quelle für Pflichtfelder, Typen oder Listenlängen und begründet keine
 * Veröffentlichungsentscheidung. Verbindlich sind nur ausdrückliche
 * Listenmodelle (DYNAMIC_LIST_MODELS) plus die strikte Endprüfung. Die
 * Funktion bleibt nur für Diagnosezwecke und bestehende Tests erhalten.
 */
export function inferRequiredKeys(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const objects = list.filter(isPlainObject);
  if (objects.length === 0 || objects.length !== list.length) return [];
  const [first, ...rest] = objects;
  const keys = Object.keys(first).filter((k) => !["__proto__", "constructor", "prototype"].includes(k));
  return keys.filter((k) => rest.every((o) => Object.prototype.hasOwnProperty.call(o, k)));
}

/* =====================================================================
 * Gemeinsame 1d-Logik: Zielauflösung, Typumwandlung, Listenmodelle,
 * Banner-Endprüfung und Kandidaten-Strukturprüfung.
 *
 * Diese Bausteine werden vom Veröffentlichen UND vom KI-Chat verwendet –
 * für dasselbe Ziel gelten dieselben Regeln, egal ob es über Manifest-ID,
 * freien json:-Alias, vollständigen Datei-Entwurf oder eine Kombination
 * bearbeitet wird. Kundendaten (Live-Inhalte, Entwürfe) schwächen ihre
 * eigenen Prüfregeln nicht ab: Was kein ausdrückliches Modell hat, wird
 * als Strukturänderung ehrlich abgelehnt statt aus Nachbarn geraten.
 * ===================================================================== */

/** Typ-, Längen- und Label-Eintrag je kanonischem Ziel (Manifest oder Modell). */
export interface TypeEntry {
  type: FieldType;
  maxLength?: number;
  label: string;
}

/** Aufgelöster Bearbeitungstyp inkl. Herkunft (für einheitliche Umwandlung). */
export interface ResolvedEditType extends TypeEntry {
  via: "manifest" | "banner" | "modell" | "frei";
}

/**
 * Ausdrücklich modellierte dynamische Liste (vertrauenswürdige Agentur-Regel,
 * kein Ableiten aus Kundendaten): Datei plus kanonischer Listenpfad plus
 * erforderliche Schlüssel mit Typen. Nur solche Listen dürfen per Entwurf am
 * Ende wachsen; neue Elemente brauchen alle Modellschlüssel in typgerechter
 * Form und keine fremden Schlüssel. Alle anderen Listen sind fest:
 * Längenänderungen werden abgelehnt, bis die Agentur hier einen passenden
 * Modellfall hinterlegt. Keine globale Eintrags-Regel, kein Feldanzahl-Limit.
 */
export interface DynamicListModel {
  file: string;
  /** Kanonischer Listenpfad, z. B. "items" oder "testimonials.items". */
  path: string;
  required: Record<string, FieldType>;
}

/**
 * Derzeit einzig ausdrücklich modellierte dynamische Liste: die FAQ-Liste
 * in faq.json (Elemente mit frage + antwort als Text). Feste Sektionen wie
 * testimonials.items haben bewusst KEINEN Eintrag und wachsen daher nicht.
 * Erweiterung nur hier im Code (Agentur), niemals aus Kundendaten.
 */
export const DYNAMIC_LIST_MODELS: DynamicListModel[] = [
  {
    file: "src/content/pages/faq.json",
    path: "items",
    required: { frage: "text", antwort: "text" },
  },
];

/** Findet das ausdrückliche Wachstumsmodell einer Liste (null = feste Liste). */
export function findListModel(file: string, listCanonical: string): DynamicListModel | null {
  return (
    DYNAMIC_LIST_MODELS.find((m) => m.file === file && m.path === listCanonical) ?? null
  );
}

/** Einheitliche Schreibweise für Segmentlisten (wie json-path-kanonisch). */
function segmentsToCanonical(segments: Array<string | number>): string {
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

/** Listenzusammenhang einer Ergänzung (Index auf Live-Länge). */
export interface AppendContext {
  listSegments: Array<string | number>;
  listCanonical: string;
  liveLength: number;
  index: number;
  /** Segmente nach dem Listen-Index (leer = reiner Index-Anhang). */
  rest: Array<string | number>;
}

/**
 * Erkennt, ob Segmente exakt ans Ende einer Live-Liste anhängen
 * (Index == Live-Länge). Null, wenn kein Anhang am Ende vorliegt.
 */
export function appendContextFor(
  segments: Array<string | number>,
  liveJson: Record<string, unknown> | undefined
): AppendContext | null {
  if (!liveJson) return null;
  for (let k = 0; k < segments.length; k += 1) {
    if (typeof segments[k] !== "number") continue;
    const arr = getBySegments(liveJson, segments.slice(0, k));
    const index = segments[k] as number;
    if (Array.isArray(arr) && arr.length === index) {
      const listSegments = segments.slice(0, k);
      return {
        listSegments,
        listCanonical: segmentsToCanonical(listSegments),
        liveLength: arr.length,
        index,
        rest: segments.slice(k + 1),
      };
    }
  }
  return null;
}

/**
 * Modelltyp eines neuen Listen-Blatts (z. B. antwort als Text): Nur für exakt
 * einen neuen Blatt-Schlüssel am Listenende mit ausdrücklichem Modell.
 * Sonst null (kein Raten aus Geschwistertypen).
 */
export function modelTypeForAppend(
  file: string,
  segments: Array<string | number>,
  liveJson: Record<string, unknown> | undefined
): FieldType | null {
  const ctx = appendContextFor(segments, liveJson);
  if (!ctx || ctx.rest.length !== 1 || typeof ctx.rest[0] !== "string") return null;
  const model = findListModel(file, ctx.listCanonical);
  if (!model) return null;
  return model.required[ctx.rest[0]] ?? null;
}

/**
 * Löst den Bearbeitungstyp eines Ziels einheitlich auf – unabhängig vom
 * Zugriffsweg: deklariertes Manifestfeld, Banner-Regel, ausdrückliches
 * Listenmodell oder freier Text. Wird vom Veröffentlichen (Umwandlung +
 * Prüfung) und vom Chat (Kandidatenbildung + Hinweise) gemeinsam benutzt.
 */
export function resolveEditType(
  file: string,
  segments: Array<string | number>,
  canonical: string | null,
  typeMap: Map<string, TypeEntry>,
  liveJson: Record<string, unknown> | undefined
): ResolvedEditType {
  if (canonical) {
    const declared = typeMap.get(canonical);
    if (declared) return { ...declared, via: "manifest" };
  }
  if (
    file === SITE_JSON &&
    segments.length === 2 &&
    segments[0] === "banner" &&
    typeof segments[1] === "string" &&
    (segments[1] === "enabled" || segments[1] === "variant" || segments[1] === "text")
  ) {
    const key = segments[1];
    return {
      type: bannerTargetType(key),
      maxLength: bannerMaxLength(key),
      label: `Banner-${key}`,
      via: "banner",
    };
  }
  const modelType = modelTypeForAppend(file, segments, liveJson);
  if (modelType) {
    return { type: modelType, label: String(segments[segments.length - 1]), via: "modell" };
  }
  return { type: "text", label: String(segments[segments.length - 1]), via: "frei" };
}

/**
 * Wandelt einen rohen Entwurfs-String zieltypabhängig um (gemeinsam für
 * Publish-Kandidat und Chat-Kandidat): Nur Boolean-Felder werden zu echten
 * Booleans, nur Zahl-Felder zu echten Zahlen. Texte wie "true" in
 * Textfeldern bleiben Text.
 */
export function convertEditValue(
  file: string,
  editPath: string,
  rawValue: string,
  typeMap: Map<string, TypeEntry>,
  liveJson: Record<string, unknown> | undefined
): unknown {
  const parsed = parsePathSafe(editPath);
  if (!parsed.ok) return rawValue;
  const resolved = resolveEditType(
    file,
    parsed.segments,
    `${file}#${parsed.canonical}`,
    typeMap,
    liveJson
  );
  return convertStoredValue(resolved.type, rawValue);
}

/** Fehlermeldung für Wachstum einer festen Liste (kein Modell). */
export function fixedListGrowError(file: string, listPath: string): string {
  return `Die Liste "${listPath}" in "${file}" ist eine feste Liste und darf nicht wachsen (kein dynamisches Website-Modell). Bitte über die Agentur anlegen lassen.`;
}

/** Fehlermeldung für Kürzen einer festen Liste (kein Modell). */
export function fixedListShrinkError(file: string, listPath: string): string {
  return `Die Liste "${listPath}" in "${file}" ist eine feste Liste und darf nicht gekürzt werden (kein dynamisches Website-Modell). Bitte über die Agentur ändern lassen.`;
}

/**
 * Prüft den Banner-Endstand – gilt IMMER, wenn ein Banner-Objekt vorhanden
 * ist, auch bei ausgeschaltetem Banner: Vorhandene Werte müssen gültig sein
 * (Stil-Enum, Textlänge). Eingeschaltet braucht zusätzlich Stil + Text.
 * Liefert deutsche Meldungen (leer = gültig). Gemeinsam für Publish und Chat.
 */
export function getBannerProblems(banner: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(banner)) {
    return [`Der Banner-Bereich in ${SITE_JSON} ist beschädigt (muss ein Objekt sein).`];
  }
  const record = banner as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "enabled" && key !== "variant" && key !== "text") {
      problems.push(`Unbekanntes Banner-Feld "${key}" (erlaubt: enabled, variant, text).`);
    }
  }
  const enabled = record.enabled;
  const on = enabled === true;
  if (enabled !== true && enabled !== false) {
    problems.push(`Banner-Schalter muss an oder aus sein (erwartet: true oder false).`);
  }
  const variant = record.variant;
  const variantOk =
    typeof variant === "string" &&
    (BANNER_VARIANTS as readonly string[]).includes(variant.trim());
  if (on && !variantOk) {
    problems.push(
      `Banner ist eingeschaltet, aber der Stil fehlt oder ist ungültig (erlaubt: ${BANNER_VARIANTS.join(", ")}).`
    );
  } else if (variant !== undefined && !variantOk) {
    const shown = typeof variant === "string" ? variant.slice(0, 40) : "unbekannt";
    problems.push(
      `Banner-Stil "${shown}" ist ungültig (erlaubt: ${BANNER_VARIANTS.join(", ")}). Auch bei ausgeschaltetem Banner müssen vorhandene Werte gültig sein.`
    );
  }
  const text = record.text;
  if (on && (typeof text !== "string" || text.trim() === "")) {
    problems.push(`Banner ist eingeschaltet, aber der Text fehlt.`);
  } else if (typeof text === "string" && text.length > BANNER_TEXT_MAX) {
    problems.push(
      `Banner-Text ist zu lang (${text.length} von max. ${BANNER_TEXT_MAX} Zeichen). Auch bei ausgeschaltetem Banner müssen vorhandene Werte gültig sein.`
    );
  } else if (text !== undefined && typeof text !== "string") {
    problems.push(`Banner-Text muss ein Text sein.`);
  }
  return problems;
}

/** Fehlende Modellschlüssel eines Elements (leere/fehlende zählen als fehlend). */
function listModelMissingKeys(
  model: DynamicListModel,
  element: Record<string, unknown>
): string[] {
  return Object.keys(model.required).filter((key) => {
    const v = element[key];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
}

/**
 * Prüft ein neu angehängtes Listen-Element gegen sein ausdrückliches Modell:
 * Objektform, Vollständigkeit, keine fremden Schlüssel, typgerechte Werte
 * (strikte Endtypen). Deutsche Meldungen, leer = ok.
 */
function validateNewListElement(
  file: string,
  listPath: string,
  model: DynamicListModel,
  element: unknown
): string[] {
  const errors: string[] = [];
  const wanted = Object.keys(model.required);
  if (!isPlainObject(element)) {
    errors.push(
      `Ergänzung in "${file}" (${listPath}): Das neue Element muss ein Objekt mit ${wanted.join(", ")} sein.`
    );
    return errors;
  }
  const record = element as Record<string, unknown>;
  const missing = listModelMissingKeys(model, record);
  if (missing.length > 0) {
    errors.push(
      `Ergänzung in "${file}" (${listPath}): unvollständig – es fehlen noch: ${missing.join(", ")}. Alle Angaben im selben Satz liefern, dann geht es.`
    );
  }
  const extras = Object.keys(record).filter(
    (k) => !Object.prototype.hasOwnProperty.call(model.required, k)
  );
  if (extras.length > 0) {
    errors.push(
      `Ergänzung in "${file}" (${listPath}): unerlaubte Felder: ${extras.join(", ")} – das Listen-Modell kennt nur: ${wanted.join(", ")}.`
    );
  }
  for (const key of wanted) {
    const v = record[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
    const problem = validateFinalJsonValue(model.required[key], v);
    if (problem) errors.push(`Ergänzung in "${file}" (${listPath}): Feld "${key}": ${problem}`);
  }
  return errors;
}

interface ArraySpot {
  segments: Array<string | number>;
  canonical: string;
}

/** Sammelt alle Listenpfade eines JSON-Baums (Tiefen-begrenzt, ohne Tricks). */
function collectArrayPaths(
  node: unknown,
  prefix: Array<string | number>,
  out: Array<ArraySpot>,
  depth: number
): void {
  if (depth > 20 || typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    out.push({ segments: [...prefix], canonical: segmentsToCanonical(prefix) });
    node.forEach((el, i) => collectArrayPaths(el, [...prefix, i], out, depth + 1));
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    collectArrayPaths((node as Record<string, unknown>)[key], [...prefix, key], out, depth + 1);
  }
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Fehlende Modellschlüssel einer begonnenen Listen-Ergänzung für ehrliche
 * Chat-Hinweise: Prüft das EINTRAGSOBJEKT im Kandidaten (nicht den
 * Blattwert) gegen das ausdrückliche Modell und meldet vorhandene Angaben
 * niemals als fehlend. Ohne Modell oder ohne Anhang: [] (kein Raten).
 */
export function missingAppendKeys(
  file: string,
  segments: Array<string | number>,
  liveJson: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>
): string[] {
  const ctx = appendContextFor(segments, liveJson);
  if (!ctx || ctx.rest.length > 1) return [];
  const model = findListModel(file, ctx.listCanonical);
  if (!model) return [];
  const element = getBySegments(candidate, [...ctx.listSegments, ctx.index]);
  if (!isPlainObject(element)) return Object.keys(model.required);
  return listModelMissingKeys(model, element as Record<string, unknown>);
}

/* =====================================================================
 * Vollständige Prüfung bestehender Inhalte (Ergänzung nach 29f6da5):
 * Bekannte Modelle gelten für ALLE endgültigen Elemente (auch ohne
 * Wachstum), und Typänderungen außerhalb der Feldliste werden gezielt
 * abgewiesen. Gleichartige Wertänderungen (gleicher Typ) bleiben zulässig.
 * ===================================================================== */

/** Deutscher Typname für Fehlermeldungen (kein Raten, nur Benennung). */
function typName(value: unknown): string {
  if (value === null) return "leer";
  if (Array.isArray(value)) return "Liste";
  switch (typeof value) {
    case "number":
      return "Zahl";
    case "string":
      return "Text";
    case "boolean":
      return "An/Aus";
    case "object":
      return "Objekt";
    default:
      return typeof value;
  }
}

/**
 * Baut das Abdeckungsprädikat für die Strukturprüfung: Pfade mit
 * verbindlicher Regel (deklariertes Manifestfeld, Banner-Bereich,
 * ausdrücklich modellierte Liste) werden von der allgemeinen
 * Formerhaltungsprüfung ausgenommen – für sie gelten ihre eigenen Regeln
 * am Kandidatenwert. Gemeinsam für Publish und Chat.
 */
export function makeCoveragePredicate(
  typeMap: Map<string, TypeEntry>
): (file: string, canonical: string) => boolean {
  return (file: string, canonical: string): boolean => {
    if (typeMap.has(`${file}#${canonical}`)) return true;
    if (
      file === SITE_JSON &&
      (canonical === "banner" ||
        canonical.startsWith("banner.") ||
        canonical.startsWith("banner["))
    ) {
      return true;
    }
    for (const m of DYNAMIC_LIST_MODELS) {
      if (
        m.file === file &&
        (canonical === m.path ||
          canonical.startsWith(`${m.path}.`) ||
          canonical.startsWith(`${m.path}[`))
      ) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Vergleicht die Form eines festen Listen-Elements (rekursiv): gleiche
 * Schlüsselmenge in Objekten, gleiche Typen an Blättern. Längenunterschiede
 * von Listen meldet die äußere Strukturprüfung; hier geht es um gleiche
 * Länge mit geänderter Form (fremde/fehlende Schlüssel, Typwechsel wie
 * Zahl→Text, Objekt↔Text-Tausch). Abgedeckte Pfade (Manifest/Banner/Modell)
 * sind ausgenommen – für sie gelten ihre eigenen Kandidaten-Regeln.
 */
function compareFixedShape(
  liveNode: unknown,
  candNode: unknown,
  file: string,
  segments: Array<string | number>,
  isCovered: (file: string, canonical: string) => boolean
): string[] {
  const errors: string[] = [];
  const canonical = segmentsToCanonical(segments);
  const where = canonical === "" ? "Hauptliste" : canonical;
  if (Array.isArray(liveNode) || Array.isArray(candNode)) {
    if (!Array.isArray(liveNode) || !Array.isArray(candNode)) {
      errors.push(
        `Der Wert "${where}" in "${file}" ändert seine Form (Liste gegen Einzelwert) – feste Inhalte bitte über die Agentur ändern lassen.`
      );
      return errors;
    }
    if (liveNode.length !== candNode.length) return errors; // meldet die äußere Prüfung.
    for (let i = 0; i < liveNode.length; i += 1) {
      errors.push(...compareFixedShape(liveNode[i], candNode[i], file, [...segments, i], isCovered));
    }
    return errors;
  }
  if (isPlainObject(liveNode) || isPlainObject(candNode)) {
    if (!isPlainObject(liveNode) || !isPlainObject(candNode)) {
      errors.push(
        `Der Wert "${where}" in "${file}" ändert seine Form (Objekt gegen Einzelwert) – feste Inhalte bitte über die Agentur ändern lassen.`
      );
      return errors;
    }
    const liveKeys = Object.keys(liveNode).filter(
      (k) => !["__proto__", "constructor", "prototype"].includes(k)
    );
    const candKeys = Object.keys(candNode).filter(
      (k) => !["__proto__", "constructor", "prototype"].includes(k)
    );
    const added = candKeys.filter(
      (k) => !liveKeys.includes(k) && !isCovered(file, segmentsToCanonical([...segments, k]))
    );
    const removed = liveKeys.filter(
      (k) => !candKeys.includes(k) && !isCovered(file, segmentsToCanonical([...segments, k]))
    );
    if (added.length > 0 || removed.length > 0) {
      const parts: string[] = [];
      if (added.length > 0) parts.push(`neu: ${added.join(", ")}`);
      if (removed.length > 0) parts.push(`entfernt: ${removed.join(", ")}`);
      errors.push(
        `Die Struktur von "${where}" in "${file}" hat sich geändert (${parts.join("; ")}) – feste Inhalte bitte über die Agentur ändern lassen.`
      );
      return errors;
    }
    for (const key of liveKeys) {
      if (!Object.prototype.hasOwnProperty.call(candNode, key)) continue; // oben gemeldet.
      errors.push(...compareFixedShape(
        (liveNode as Record<string, unknown>)[key],
        (candNode as Record<string, unknown>)[key],
        file,
        [...segments, key],
        isCovered
      ));
    }
    return errors;
  }
  // Blätter: Typwechsel (auch nach/von leer) ist ohne Modell nicht validierbar.
  if (typeof liveNode !== typeof candNode || (liveNode === null) !== (candNode === null)) {
    if (isCovered(file, canonical)) return errors; // eigene Regel prüft den Kandidaten.
    errors.push(
      `Der Wert "${where}" in "${file}" ändert den Typ (${typName(liveNode)} → ${typName(candNode)}) – Typänderungen außerhalb der Feldliste bitte über die Agentur ändern lassen.`
    );
  }
  return errors;
}

/**
 * Gemeinsame Listen-Strukturprüfung über den GESAMTEN fertigen Kandidaten
 * (Live gegen Kandidat, je Datei).
 *
 * - Bekannte Modelle gelten für ALLE endgültigen Elemente, auch ohne
 *   Wachstum: Verliert ein vorhandener Eintrag sein Pflichtfeld (volle
 *   Datei, gleiche Länge), wird der Satz abgelehnt.
 * - Feste Listen ohne Modell behalten exakt ihre Form: Bei gleicher Länge
 *   werden fremde/fehlende Schlüssel und Typwechsel abgewiesen
 *   (structurelle Treue statt Raten aus Nachbarn).
 * - Wachstum/Schrumpfung/Neue Listen wie bisher (nur mit Modell).
 *
 * Gilt für Feldentwürfe, freie Aliase UND vollständige Datei-Entwürfe
 * gleichermaßen. Deutsche Meldungen, leer = ok. Die Feldliste selbst ist
 * ausgenommen (eigene Manifest-Regeln).
 */
export function validateListStructures(
  liveFiles: Map<string, Record<string, unknown>>,
  candidateFiles: Map<string, Record<string, unknown>>,
  isCovered: (file: string, canonical: string) => boolean = () => false
): string[] {
  const errors: string[] = [];
  for (const [file, live] of liveFiles) {
    // Die Feldliste selbst ist kein Inhaltsziel: Ihre Änderung (neue
    // Sektionen/Felder) wird über Manifest-Regeln geprüft, nicht als
    // Listenwachstum.
    if (file === MANIFEST_PATH) continue;
    const cand = candidateFiles.get(file);
    if (!cand) continue; // Datei entfällt: Manifestziele melden das bereits.
    const liveArrays: Array<ArraySpot> = [];
    collectArrayPaths(live, [], liveArrays, 0);
    const candArrays: Array<ArraySpot> = [];
    collectArrayPaths(cand, [], candArrays, 0);
    const candByPath = new Map(candArrays.map((a) => [a.canonical, a] as const));
    for (const spot of liveArrays) {
      const label = spot.canonical === "" ? "Hauptliste" : spot.canonical;
      const liveArr = getBySegments(live, spot.segments);
      const hit = candByPath.get(spot.canonical);
      const candArr = hit ? getBySegments(cand, hit.segments) : undefined;
      if (candArr === undefined) {
        errors.push(
          `Die Liste "${label}" in "${file}" fehlt im neuen Stand – Listen dürfen nicht per Entwurf entfernt werden. Bitte über die Agentur ändern lassen.`
        );
        continue;
      }
      if (!Array.isArray(candArr)) {
        errors.push(
          `Die Liste "${label}" in "${file}" ist keine Liste mehr – die Listenform bitte über die Agentur ändern lassen.`
        );
        continue;
      }
      if (!Array.isArray(liveArr)) continue;
      const model = findListModel(file, spot.canonical);
      // Das Modell gilt für den gesamten Endstand, auch wenn die Liste
      // gekürzt wird. Wachstum und Länge regeln anschließend nur den Umbau.
      if (model) {
        for (let i = 0; i < candArr.length; i += 1) {
          errors.push(...validateNewListElement(file, `${label}[${i}]`, model, candArr[i]));
        }
      }
      if (candArr.length === liveArr.length) {
        // Feste Listen behalten exakt ihre Form.
        if (!model) {
          errors.push(...compareFixedShape(liveArr, candArr, file, spot.segments, isCovered));
        }
        continue;
      }
      if (candArr.length > liveArr.length) {
        if (!model) {
          errors.push(fixedListGrowError(file, label));
          continue;
        }
        let prefixOk = true;
        for (let i = 0; i < liveArr.length; i += 1) {
          if (!deepEqualJson(liveArr[i], candArr[i])) {
            prefixOk = false;
            break;
          }
        }
        if (!prefixOk) {
          errors.push(
            `Die Liste "${label}" in "${file}" darf nur am Ende ergänzt werden (bestehende Einträge unverändert lassen).`
          );
          continue;
        }
        continue;
      }
      if (!model) {
        errors.push(fixedListShrinkError(file, label));
        continue;
      }
      // Dynamische Liste kürzen: zulässig (kein Mindestmaß modelliert).
    }
    const livePaths = new Set(liveArrays.map((a) => a.canonical));
    for (const spot of candArrays) {
      if (!livePaths.has(spot.canonical)) {
        const label = spot.canonical === "" ? "Hauptliste" : spot.canonical;
        errors.push(
          `Neue Liste "${label}" in "${file}" ohne Website-Modell – bitte über die Agentur anlegen lassen.`
        );
      }
    }
  }
  return errors;
}

/**
 * Allgemeine Typtreue außerhalb der Feldliste (gemeinsam für Publish und
 * Chat): An jedem bestehenden Pfad ohne verbindliche Regel muss der Typ
 * erhalten bleiben (Zahl bleibt Zahl, Text bleibt Text – auch nach/von
 * leer). Gleichartige Wertänderungen bleiben zulässig; Hinzufügungen neuer
 * Schlüssel in reinen Objekten und Listen behandelt die Listenprüfung.
 * Listen selbst gehören der Listenprüfung (Rekursion steigt dort ein und
 * hier aus). Deutsche Meldungen, leer = ok.
 */
export function validateScalarTypePreservation(
  liveFiles: Map<string, Record<string, unknown>>,
  candidateFiles: Map<string, Record<string, unknown>>,
  isCovered: (file: string, canonical: string) => boolean = () => false
): string[] {
  const errors: string[] = [];
  const walk = (
    liveNode: unknown,
    candNode: unknown,
    file: string,
    segments: Array<string | number>
  ): void => {
    const canonical = segmentsToCanonical(segments);
    if (isCovered(file, canonical)) return; // eigene Regel prüft den Kandidaten.
    if (Array.isArray(liveNode) || Array.isArray(candNode)) return; // Listenprüfung zuständig.
    if (isPlainObject(liveNode) && isPlainObject(candNode)) {
      for (const key of Object.keys(liveNode)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        if (!Object.prototype.hasOwnProperty.call(candNode, key)) continue; // Entfall: Entwurf bleibt bzw. Manifest meldet.
        walk(
          (liveNode as Record<string, unknown>)[key],
          (candNode as Record<string, unknown>)[key],
          file,
          [...segments, key]
        );
      }
      return;
    }
    if (isPlainObject(liveNode) || isPlainObject(candNode)) {
      // Objekt↔Einzelwert-Tausch ohne Regel: gezielt abweisen.
      const where = canonical === "" ? "Hauptbereich" : canonical;
      errors.push(
        `Der Wert "${where}" in "${file}" ändert seine Form (${typName(liveNode)} → ${typName(candNode)}) – Strukturänderungen außerhalb der Feldliste bitte über die Agentur ändern lassen.`
      );
      return;
    }
    if (typeof liveNode !== typeof candNode || (liveNode === null) !== (candNode === null)) {
      const where = canonical === "" ? "Hauptbereich" : canonical;
      errors.push(
        `Der Wert "${where}" in "${file}" ändert den Typ (${typName(liveNode)} → ${typName(candNode)}) – Typänderungen außerhalb der Feldliste bitte über die Agentur ändern lassen.`
      );
    }
  };
  for (const [file, live] of liveFiles) {
    if (file === MANIFEST_PATH) continue;
    const cand = candidateFiles.get(file);
    if (!cand) continue;
    walk(live, cand, file, []);
  }
  return errors;
}
