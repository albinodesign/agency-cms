/** Liest einen Wert per Dot-Path (z. B. "hero.title") aus einem Objekt. */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Schreibt einen Wert per Dot-Path in ein Objekt (legt fehlende Ebenen an). */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: string
): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (
      typeof current[key] !== "object" ||
      current[key] === null ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}
