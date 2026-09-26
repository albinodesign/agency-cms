/**
 * Banner-Regeln des CMS-Banners (W1).
 * Gehört zu src/lib/content-guard.ts (Barrel) – keine Logik ändern.
 */
import type { FieldType } from "../../types/cms";
import { SITE_JSON, isPlainObject } from "./base";

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
