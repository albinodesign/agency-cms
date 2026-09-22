/**
 * Zerlegt einen Pfad in Segmente und versteht dabei drei Schreibweisen:
 * "hero.title", "cards.0.title" und "cards[0].title".
 * Zahlen werden als Array-Index zurückgegeben, alles andere als Objekt-Schlüssel.
 */
function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const part of path.split(".")) {
    // Bsp. "cards[0][1]" -> ["cards", 0, 1]
    const re = /([^\[\]]+)|\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = re.exec(part)) !== null) {
      found = true;
      if (match[1] !== undefined) {
        // Reiner Zahlen-String nach Punkt ("cards.0") ist ebenfalls ein Index
        segments.push(/^\d+$/.test(match[1]) ? Number(match[1]) : match[1]);
      } else if (match[2] !== undefined) {
        segments.push(Number(match[2]));
      }
    }
    if (!found && part !== "") segments.push(part);
  }
  return segments;
}

/** Liest einen Wert per Pfad (z. B. "hero.title" oder "faq.items[0].frage") aus einem Objekt. */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = parsePath(path);
  let current: unknown = obj;
  for (const key of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key as string];
  }
  return current;
}

/**
 * Schreibt einen Wert per Pfad in ein Objekt (legt fehlende Ebenen an).
 * Zahlen-Segmente legen automatisch Arrays an, Text-Segmente legen Objekte an.
 * Bestehende Arrays bleiben erhalten (früher wurden sie fälschlich überschrieben).
 */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const segments = parsePath(path);
  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const needArray = typeof segments[i + 1] === "number";

    if (typeof key === "number") {
      // Aktuelle Ebene muss ein Array sein (wird notfalls eins)
      const arr = (Array.isArray(current) ? current : []) as unknown[];
      if (typeof arr[key] !== "object" || arr[key] === null) {
        arr[key] = needArray ? [] : {};
      }
      current = arr[key] as Record<string, unknown> | unknown[];
    } else {
      const rec = current as Record<string, unknown>;
      if (needArray) {
        if (!Array.isArray(rec[key])) rec[key] = [];
      } else if (typeof rec[key] !== "object" || rec[key] === null) {
        // Bestehende Arrays/Objekte bleiben erhalten, nur Strings/Zahlen werden ersetzt
        rec[key] = {};
      }
      current = rec[key] as Record<string, unknown> | unknown[];
    }
  }
  const last = segments[segments.length - 1];
  if (typeof last === "number" && Array.isArray(current)) {
    current[last] = value;
  } else {
    (current as Record<string, unknown>)[last as string] = value;
  }
}
