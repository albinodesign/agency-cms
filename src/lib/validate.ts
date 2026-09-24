import type { FieldType } from "@/types/cms";

/**
 * Prüft einen Entwurfswert gegen den Feldtyp aus dem Manifest.
 * Liefert null wenn ok, sonst eine deutsche Fehlermeldung für den Kunden.
 * Leere Werte sind erlaubt (Feld leeren) – Pflichtfelder kennt das Manifest nicht.
 * Wird vom Veröffentlichen UND vom KI-Chat benutzt (eine Prüfung für alles).
 */
export function validateDraftValue(
  type: FieldType,
  value: string,
  maxLength?: number
): string | null {
  if (maxLength != null && value.length > maxLength) {
    return `Text ist zu lang (${value.length} von max. ${maxLength} Zeichen).`;
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  switch (type) {
    case "number":
      if (!/^[-+]?\d+([.,]\d+)?$/.test(trimmed)) {
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
