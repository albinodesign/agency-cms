/**
 * Sichere Pfadfunktionen für JSON-Inhalte.
 *
 * Versteht drei Schreibweisen ("hero.title", "cards.0.title", "cards[0].title").
 * Schutzregeln:
 * - "__proto__", "constructor" und "prototype" sind als Segmente verboten
 *   (Schutz vor Prototyp-Verschmutzung).
 * - Es wird nur über eigene, vorhandene Eigenschaften gelesen.
 * - Beim Schreiben werden fehlende Zwischenebenen nur als reine Objekte
 *   angelegt – niemals Arrays. Listen müssen bereits existieren; gültig sind
 *   vorhandene Indizes sowie das exakte Anhängen am Ende (Index == Länge).
 * - Ungültige Pfade liefern Fehler statt still falscher Ergebnisse.
 */

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const MAX_SEGMENTS = 20;
const MAX_INDEX = 9999;
const MAX_PATH_LENGTH = 500;

export interface SafeParsedPath {
  segments: Array<string | number>;
  /** Einheitliche Schreibweise: "items[0].title" und "items.0.title" werden identisch. */
  canonical: string;
}

/**
 * Ergebnis einer Pfadprüfung. Absichtlich ein flaches Interface statt Union,
 * damit es in jedem Kompiliermodus (auch ohne strict) ohne Eingrenzung nutzbar ist.
 */
export interface PathParseResult {
  ok: boolean;
  segments: Array<string | number>;
  canonical: string;
  /** Leere Zeichenkette wenn ok, sonst deutsche Fehlermeldung. */
  error: string;
}

function fail(error: string): PathParseResult {
  return { ok: false, segments: [], canonical: "", error };
}

function toCanonical(segments: Array<string | number>): string {
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

/**
 * Prüft einen Pfad streng und zerlegt ihn in Segmente.
 * Zahlen werden als Array-Index zurückgegeben, alles andere als Objekt-Schlüssel.
 */
export function parsePathSafe(path: unknown): PathParseResult {
  if (typeof path !== "string" || path.length === 0) {
    return fail("Der Pfad ist leer.");
  }
  if (path.length > MAX_PATH_LENGTH) {
    return fail("Der Pfad ist zu lang (max. 500 Zeichen).");
  }
  const segments: Array<string | number> = [];
  for (const part of path.split(".")) {
    if (part === "") {
      return fail(`Der Pfad "${path}" enthält leere Abschnitte.`);
    }
    // Bsp. "cards[0][1]" -> ["cards", 0, 1]. Alles muss verbraucht werden,
    // sonst ist der Abschnitt ungültig (z. B. "[name]" oder "[0").
    const re = /([^\[\]]+)|\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    let matchedAny = false;
    let consumed = 0;
    while ((match = re.exec(part)) !== null) {
      matchedAny = true;
      consumed += match[0].length;
      if (match[1] !== undefined) {
        // Reiner Zahlen-String nach Punkt ("cards.0") ist ebenfalls ein Index
        if (/^\d+$/.test(match[1])) {
          const index = Number(match[1]);
          if (index > MAX_INDEX) {
            return fail(`Der Listen-Index ${match[1]} ist zu groß (Pfad "${path}").`);
          }
          segments.push(index);
        } else {
          if (FORBIDDEN_SEGMENTS.has(match[1])) {
            return fail(`Der Pfad enthält ein verbotenes Segment ("${match[1]}").`);
          }
          segments.push(match[1]);
        }
      } else if (match[2] !== undefined) {
        const index = Number(match[2]);
        if (index > MAX_INDEX) {
          return fail(`Der Listen-Index ${match[2]} ist zu groß (Pfad "${path}").`);
        }
        segments.push(index);
      }
    }
    if (!matchedAny || consumed !== part.length) {
      return fail(`Der Pfad "${path}" ist ungültig (Abschnitt "${part}").`);
    }
  }
  if (segments.length === 0) {
    return fail("Der Pfad ist leer.");
  }
  if (segments.length > MAX_SEGMENTS) {
    return fail("Der Pfad ist zu tief verschachtelt (max. 20 Ebenen).");
  }
  return { ok: true, segments, canonical: toCanonical(segments), error: "" };
}

/** Prüft einen Pfad und liefert null wenn ok, sonst eine deutsche Fehlermeldung. */
export function validateJsonPath(path: unknown): string | null {
  const parsed = parsePathSafe(path);
  return parsed.ok ? null : parsed.error;
}

/** Liest einen Wert per Pfad (z. B. "hero.title" oder "faq.items[0].frage"). */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parsed = parsePathSafe(path);
  if (!parsed.ok) return undefined;
  let current: unknown = obj;
  for (const key of parsed.segments) {
    if (typeof current !== "object" || current === null) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(current) || key < 0 || key >= current.length) return undefined;
      current = current[key];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

function structureError(path: string): Error {
  return new Error(`Der Pfad "${path}" passt nicht zur Datei-Struktur.`);
}

/**
 * Schreibt einen Wert per Pfad in ein Objekt.
 * Fehlende Zwischenebenen werden nur als reine Objekte angelegt; Listen müssen
 * bereits existieren (am Ende ist das Anhängen per Index == Länge erlaubt).
 * Wirft einen Fehler bei ungültigem Pfad oder unpassender Struktur.
 */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parsed = parsePathSafe(path);
  if (!parsed.ok) throw new Error(parsed.error);
  const segments = parsed.segments;
  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const next = segments[i + 1];
    if (typeof key === "number") {
      if (!Array.isArray(current) || key < 0 || key > current.length) {
        throw new Error(`Der Listen-Index ${key} ist ungültig (Pfad "${path}").`);
      }
      if (key === current.length) {
        // Anhängen exakt am Ende (z. B. neuer FAQ-Eintrag) – Container passend
        // zum Folgesegment. Größere Sprünge (Löcher) sind verboten.
        const fresh: Record<string, unknown> | unknown[] =
          typeof next === "number" ? [] : {};
        current[key] = fresh;
        current = fresh;
      } else {
        const child: unknown = current[key];
        if (typeof child !== "object" || child === null) throw structureError(path);
        current = child as Record<string, unknown> | unknown[];
      }
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw structureError(path);
      }
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        // Nur reine Objekte anlegen – Listen werden nie aus Kundeneingaben erzeugt.
        if (typeof next === "number") {
          throw new Error(`Die Liste "${key}" existiert nicht (Pfad "${path}").`);
        }
        record[key] = {};
      } else if (typeof record[key] !== "object" || record[key] === null) {
        throw structureError(path);
      }
      current = record[key] as Record<string, unknown> | unknown[];
    }
  }
  const last = segments[segments.length - 1];
  if (typeof last === "number") {
    if (!Array.isArray(current) || last < 0 || last > current.length) {
      throw new Error(`Der Listen-Index ${last} ist ungültig (Pfad "${path}").`);
    }
    current[last] = value;
  } else {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw structureError(path);
    }
    (current as Record<string, unknown>)[last] = value;
  }
}
