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
 * Rohe Formulareingaben dürfen Strings sein (z. B. "42" oder "true") –
 * erst im fertigen Veröffentlichungsstand gelten die strikten Endtypen
 * (siehe validateFinalJsonValue).
 */
export function validateDraftValue(
  type: FieldType,
  value: string,
  maxLength?: number
): string | null {
  return validateJsonValue(type, value, maxLength);
}

/**
 * Prüft einen Wert im fertigen Veröffentlichungskandidaten streng gegen den
 * deklarierten Feldtyp. Im fertigen JSON müssen Zahlen echte endliche Zahlen
 * und Booleans echte Booleans sein; Text bleibt Text. Null und fehlende Werte
 * sind hier nicht erlaubt (ein Entwurf darf unvollständig sein, ein
 * veröffentlichter Stand nicht). Wird vom Veröffentlichen UND sinngemäß von
 * den Chat-Hinweisen benutzt (eine Prüfung für alles).
 */
export function validateFinalJsonValue(
  type: FieldType,
  value: unknown,
  maxLength?: number
): string | null {
  if (value === undefined) return "Dieser Wert fehlt im neuen Stand.";
  if (value === null) {
    return type === "number"
      ? "Dieser Wert muss eine Zahl sein (kein leerer Wert)."
      : type === "boolean"
        ? "Dieser Wert muss an oder aus sein (kein leerer Wert)."
        : `Dieser Wert muss ein Text sein (gefunden: leer).`;
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : "Dieser Wert muss eine Zahl sein (kein Text).";
  }
  if (type === "boolean") {
    return typeof value === "boolean" ? null : "Dieser Wert muss an oder aus sein (kein Text).";
  }
  if (typeof value !== "string") {
    return `Dieser Wert muss ein Text sein (gefunden: ${kindOf(value)}).`;
  }
  // Ab hier: echter String – dieselben Formatregeln wie bei Entwürfen.
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
