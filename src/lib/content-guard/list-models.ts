/**
 * Listen, Zielauflösung, Typumwandlung und Kandidaten-Strukturprüfung (W1).
 * Gemeinsam für Publish und Chat – keine Logik ändern.
 */
import { getBySegments, parsePathSafe } from "../json-path";
import { convertStoredValue } from "../validate";
import type { FieldType } from "../../types/cms";
import {
  MANIFEST_PATH,
  SITE_JSON,
  isPlainObject,
  segmentsToCanonical,
} from "./base";
import { bannerMaxLength, bannerTargetType } from "./banner";

/**
 * Erforderliche Schlüssel eines Listen-Elements: Schnittmenge der Schlüssel
 * aller vorhandenen Objekt-Elemente.
 *
 * ACHTUNG: Diese Ableitung aus Nachbareinträgen ist KEINE verlässliche
 * Quelle für Pflichtfelder, Typen oder Listenlängen und begründet keine
 * Veröffentlichungsentscheidung. Die Funktion bleibt nur für
 * Diagnosezwecke und bestehende Tests erhalten.
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
 * Gemeinsame Logik: Zielauflösung, Typumwandlung, Banner-Endprüfung und
 * Kandidaten-Strukturprüfung (feste Listen).
 *
 * Diese Bausteine werden vom Veröffentlichen UND vom KI-Chat verwendet –
 * für dasselbe Ziel gelten dieselben Regeln, egal ob es über Manifest-ID,
 * freien json:-Alias, vollständigen Datei-Entwurf oder eine Kombination
 * bearbeitet wird. Kundendaten (Live-Inhalte, Entwürfe) schwächen ihre
 * eigenen Prüfregeln nicht ab: Längenänderungen an Listen werden ehrlich
 * abgelehnt statt aus Nachbarn geraten.
 * ===================================================================== */

/** Typ-, Längen- und Label-Eintrag je kanonischem Ziel (Manifest oder Modell). */
export interface TypeEntry {
  type: FieldType;
  maxLength?: number;
  label: string;
}

/** Aufgelöster Bearbeitungstyp inkl. Herkunft (für einheitliche Umwandlung). */
export interface ResolvedEditType extends TypeEntry {
  via: "manifest" | "banner" | "frei";
}

/* =====================================================================
 * Listen sind fest: Keine Liste darf per Entwurf wachsen oder schrumpfen
 * (kein dynamisches Modell mehr – auch FAQ nicht). Bestehende Einträge
 * bleiben wie normale Felder änderbar; Längenänderungen lehnt
 * validateListStructures ehrlich ab. Neue Listeneinträge legt die Agentur
 * direkt im Website-Repo an.
 * ===================================================================== */

/**
 * Löst den Bearbeitungstyp eines Ziels einheitlich auf – unabhängig vom
 * Zugriffsweg: deklariertes Manifestfeld, Banner-Regel oder freier Text.
 * Wird vom Veröffentlichen (Umwandlung + Prüfung) und vom Chat
 * (Kandidatenbildung + Hinweise) gemeinsam benutzt.
 */
export function resolveEditType(
  file: string,
  segments: Array<string | number>,
  canonical: string | null,
  typeMap: Map<string, TypeEntry>
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
  typeMap: Map<string, TypeEntry>
): unknown {
  const parsed = parsePathSafe(editPath);
  if (!parsed.ok) return rawValue;
  const resolved = resolveEditType(
    file,
    parsed.segments,
    `${file}#${parsed.canonical}`,
    typeMap
  );
  return convertStoredValue(resolved.type, rawValue);
}

/** Fehlermeldung für Wachstum einer festen Liste. */
export function fixedListGrowError(file: string, listPath: string): string {
  return `Die Liste "${listPath}" in "${file}" ist eine feste Liste und darf nicht wachsen. Neue Einträge legt die Agentur direkt im Website-Repo an.`;
}

/** Fehlermeldung für Kürzen einer festen Liste. */
export function fixedListShrinkError(file: string, listPath: string): string {
  return `Die Liste "${listPath}" in "${file}" ist eine feste Liste und darf nicht gekürzt werden. Bitte über die Agentur ändern lassen.`;
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

/* =====================================================================
 * Vollständige Prüfung bestehender Inhalte: Alle Listen sind fest.
 * Gleichartige Wertänderungen (gleicher Typ) bleiben zulässig; jede
 * Längenänderung wird ehrlich abgelehnt.
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
 * verbindlicher Regel (deklariertes Manifestfeld, Banner-Bereich) werden von
 * der allgemeinen Formerhaltungsprüfung ausgenommen – für sie gelten ihre
 * eigenen Regeln am Kandidatenwert. Gemeinsam für Publish und Chat.
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
 * (Live gegen Kandidat, je Datei). Alle Listen sind fest:
 * - Bei gleicher Länge behalten sie exakt ihre Form (fremde/fehlende
 *   Schlüssel und Typwechsel werden abgewiesen).
 * - Wachstum, Schrumpfung und neue Listen werden abgelehnt – neue Einträge
 *   legt die Agentur direkt im Website-Repo an.
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
      if (candArr.length === liveArr.length) {
        errors.push(...compareFixedShape(liveArr, candArr, file, spot.segments, isCovered));
        continue;
      }
      if (candArr.length > liveArr.length) {
        errors.push(fixedListGrowError(file, label));
        continue;
      }
      errors.push(fixedListShrinkError(file, label));
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
