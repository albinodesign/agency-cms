import type { FieldType } from "@/types/cms";

const NUM_RE = /^[-+]?\d+([.,]\d+)?$/;

/** Beschreibt einen gefundenen Nicht-String-Wert für Fehlermeldungen. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "Liste";
  if (value === null) return "leer";
  switch (typeof value) {
    case "number":
      return "Zahl";
    case "boolean":
      return "An/Aus";
    case "object":
      return "Objekt";
    default:
      return typeof value;
  }
}

/**
 * Prüft einen bereits vorliegenden JSON-Wert (String, Zahl, Boolean …)
 * gegen den Feldtyp. Leere Werte (null, undefined, Leertext) sind ok
 * (Feld leeren) – Pflichtfelder kennt das Manifest nicht.
 * Wird vom Veröffentlichen UND vom KI-Chat benutzt (eine Prüfung für alles).
 */
export function validateJsonValue(
  type: FieldType,
  value: unknown,
  maxLength?: number
): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value !== "string") {
    switch (type) {
      case "number":
        return typeof value === "number" && Number.isFinite(value)
          ? null
          : "Dieser Wert muss eine Zahl sein.";
      case "boolean":
        return typeof value === "boolean" ? null : "Dieser Wert muss an oder aus sein.";
      default:
        return `Dieser Wert muss ein Text sein (gefunden: ${kindOf(value)}).`;
    }
  }

  if (maxLength != null && value.length > maxLength) {
    return `Text ist zu lang (${value.length} von max. ${maxLength} Zeichen).`;
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  switch (type) {
    case "number":
      if (!NUM_RE.test(trimmed)) {
        return `"${value}" ist keine gültige Zahl (erlaubt z. B. "42" oder "19,90").`;
      }
      return null;
    case "email":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
        return `"${value}" ist keine gültige E-Mail-Adresse.`;
      }
      return null;
    case "url":
    case "image":
      try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return `"${value}" muss mit http:// oder https:// beginnen (oder als Bild aus der Galerie hochgeladen werden).`;
        }
      } catch {
        // Relative Pfade wie "/bilder/foto.jpg" gelten lassen
        if (!trimmed.startsWith("/")) {
          return `"${value}" ist keine gültige Internetadresse.`;
        }
      }
      return null;
    case "phone":
      if (!/^[+()\d][\d\s/().-]{4,}$/.test(trimmed)) {
        return `"${value}" sieht nicht wie eine Telefonnummer aus.`;
      }
      return null;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
        return `"${value}" ist kein gültiges Datum (Format: JJJJ-MM-TT).`;
      }
      return null;
    case "boolean":
      if (trimmed !== "true" && trimmed !== "false") {
        return `"${value}" ist kein gültiger An/Aus-Wert (erlaubt: an oder aus).`;
      }
      return null;
    default:
      return null;
  }
}

/**
 * Prüft einen Entwurfswert (immer String) gegen den Feldtyp.
 * Liefert null wenn ok, sonst eine deutsche Fehlermeldung für den Kunden.
 */
export function validateDraftValue(
  type: FieldType,
  value: string,
  maxLength?: number
): string | null {
  return validateJsonValue(type, value, maxLength);
}

/**
 * Wandelt einen Entwurfs-String zieltypabhängig um: Nur Boolean-Felder
 * werden zu echten Booleans, nur Zahl-Felder zu echten Zahlen. Texte wie
 * "true" in Textfeldern bleiben Text. Ungültiges bleibt unverändert (die
 * Prüfung meldet es danach).
 */
export function convertStoredValue(type: FieldType, value: string): unknown {
  const trimmed = value.trim();
  if (type === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return value;
  }
  if (type === "number") {
    if (trimmed !== "" && NUM_RE.test(trimmed)) {
      return Number(trimmed.replace(",", "."));
    }
    return value;
  }
  return value;
}
