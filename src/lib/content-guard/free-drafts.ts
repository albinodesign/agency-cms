/**
 * Freie Entwürfe (json:-Aliase) und Voll-Datei-Prüfung (W1).
 * Gehört zu src/lib/content-guard.ts (Barrel) – keine Logik ändern.
 */
import { getBySegments, parsePathSafe } from "../json-path";
import { FREE_DRAFT_PREFIX } from "../../types/cms";
import { SITE_JSON, isAllowedFieldJsonFile, isPlainObject, validateJsonPath } from "./base";
import { validateBannerValue } from "./banner";

export type FreeDraftParse =
  | { ok: true; file: string; path: string; error: "" }
  | { ok: false; file: ""; path: ""; error: string };

/** Generelle Wert-Obergrenze für freie Entwürfe (wie im KI-Werkzeug). */
export const FREE_VALUE_MAX = 20_000;

export interface FreeCreation {
  kind: "banner";
  file: string;
  canonical: string;
}

export type FreeClassify =
  | { ok: true; creation: FreeCreation | null; canonical: string }
  | { ok: false; error: string };

/**
 * Enge Erstellungsregeln für freie Entwürfe: Bereits vorhandene Pfade sind
 * normales Schreiben. Einzige Ausnahme vom Bestandsgebot sind Banner-Felder
 * (`banner.enabled|variant|text` in site.json): Sie dürfen den
 * `banner`-Behälter anlegen, Werte werden typgeprüft (an/aus, Stil-Enum,
 * Textlänge). Das CMS besitzt dieses Modell (Banner-Schalter), die Website
 * rendert `site.banner`.
 * Alles andere Neue (beliebige Schlüssel, tiefere Strukturen,
 * Listen-Ergänzungen) wird abgelehnt – alle Listen sind fest.
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
  // So bleibt die Korrektur desselben Pfads ein normales Schreiben.
  const base = candidateJson ?? fileJson;
  if (base && getBySegments(base, segments) !== undefined) {
    return { ok: true, creation: null, canonical };
  }

  // Ausnahme: Banner-Modell (Besitzer: CMS-Banner-Schalter).
  // Der Wert wurde oben bereits geprüft – hier nur noch die Struktur.
  if (bannerKey) {
    const existing = fileJson?.banner;
    if (existing !== undefined && !isPlainObject(existing)) {
      return { ok: false, error: `Der Schlüssel "banner" in ${SITE_JSON} ist kein Objekt – Banner kann nicht angelegt werden.` };
    }
    return { ok: true, creation: { kind: "banner", file, canonical }, canonical };
  }

  return {
    ok: false,
    error: `Der Pfad "${path}" existiert nicht in Datei "${file}" – freie Entwürfe dürfen nur bestehende Pfade beschreiben oder Banner-Felder anlegen. Alle Listen sind fest.`,
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
