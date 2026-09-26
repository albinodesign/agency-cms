/**
 * Listenmodelle, Zielauflösung, Typumwandlung und Kandidaten-Strukturprüfung (W1).
 * Gemeinsam für Publish und Chat – keine Logik ändern.
 */
import { getBySegments, parsePathSafe } from "../json-path";
import { convertStoredValue, validateFinalJsonValue } from "../validate";
import type { CmsManifest, FieldType } from "../../types/cms";
import {
  MANIFEST_PATH,
  SITE_JSON,
  SUPPORTED_FIELD_TYPES,
  isAllowedFieldJsonFile,
  isPlainObject,
  segmentsToCanonical,
} from "./base";
import { bannerMaxLength, bannerTargetType } from "./banner";

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
 * Derzeit einzig fest eingebautes dynamisches Listenmodell: die FAQ-Liste
 * in faq.json (Elemente mit frage + antwort als Text). Feste Sektionen wie
 * testimonials.items haben bewusst KEINEN Eintrag und wachsen daher nicht.
 * Weitere Modelle legt die Agentur deklarativ im Manifest an
 * (CmsManifest.listenmodelle, siehe modelleAusManifest) – niemals aus
 * Kundendaten.
 */
export const DYNAMIC_LIST_MODELS: DynamicListModel[] = [
  {
    file: "src/content/pages/faq.json",
    path: "items",
    required: { frage: "text", antwort: "text" },
  },
];

/** Feldname für Modellschlüssel: schlicht, keine Tricks. */
const MODELL_SCHLUESSEL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Baut die gültigen Listenmodelle aus Standard + Manifest (W17).
 * Ungültige Manifest-Modelle werden mit deutschem Fehler gemeldet und
 * ignoriert (der Publish bricht bei Modellfehlern als Ganzes ab).
 */
export function modelleAusManifest(
  manifest: CmsManifest | null | undefined
): { modelle: DynamicListModel[]; fehler: string[] } {
  const modelle: DynamicListModel[] = [...DYNAMIC_LIST_MODELS];
  const fehler: string[] = [];
  const deklariert = manifest?.listenmodelle;
  if (deklariert === undefined) return { modelle, fehler };
  if (!Array.isArray(deklariert)) {
    return { modelle, fehler: [`"listenmodelle" im Manifest muss eine Liste sein.`] };
  }
  deklariert.forEach((eintrag, index) => {
    const nummer = `Listenmodell Nr. ${index + 1}`;
    if (typeof eintrag !== "object" || eintrag === null) {
      fehler.push(`${nummer} ist ungültig (kein Objekt) und wird ignoriert.`);
      return;
    }
    const { datei, pfad, felder } = eintrag as { datei?: unknown; pfad?: unknown; felder?: unknown };
    if (typeof datei !== "string" || !isAllowedFieldJsonFile(datei)) {
      fehler.push(`${nummer}: "${String(datei)}" ist kein erlaubtes Inhaltsziel (erlaubt: src/content/site.json und JSON-Dateien unter src/content/pages/).`);
      return;
    }
    if (typeof pfad !== "string") {
      fehler.push(`${nummer}: Der Listenpfad fehlt oder ist kein Text.`);
      return;
    }
    const geparst = parsePathSafe(pfad);
    if (!geparst.ok || geparst.segments.some((s) => typeof s !== "string")) {
      fehler.push(`${nummer}: Der Listenpfad "${pfad}" ist ungültig (erwartet: Punkt-Pfad wie "items" oder "bereich.items", ohne Index).`);
      return;
    }
    if (typeof felder !== "object" || felder === null || Array.isArray(felder)) {
      fehler.push(`${nummer}: "felder" muss ein Objekt wie { frage: "text" } sein.`);
      return;
    }
    const schluessel = Object.keys(felder);
    if (schluessel.length === 0 || schluessel.length > 20) {
      fehler.push(`${nummer}: "felder" braucht 1 bis 20 Einträge.`);
      return;
    }
    const required: Record<string, FieldType> = {};
    for (const key of schluessel) {
      if (!MODELL_SCHLUESSEL.test(key)) {
        fehler.push(`${nummer}: Feldname "${key}" ist ungültig (erlaubt: Buchstabe + Buchstaben/Zahlen/Unterstrich).`);
        return;
      }
      const typ = (felder as Record<string, unknown>)[key];
      if (!SUPPORTED_FIELD_TYPES.includes(typ as FieldType)) {
        fehler.push(`${nummer}: Typ "${String(typ)}" für "${key}" wird nicht unterstützt.`);
        return;
      }
      required[key] = typ as FieldType;
    }
    const kanonisch = geparst.canonical;
    const vorhanden = modelle.findIndex((m) => m.file === datei && m.path === kanonisch);
    const modell: DynamicListModel = { file: datei, path: kanonisch, required };
    if (vorhanden >= 0) modelle[vorhanden] = modell;
    else modelle.push(modell);
  });
  return { modelle, fehler };
}

/** Findet das ausdrückliche Wachstumsmodell einer Liste (null = feste Liste). */
export function findListModel(
  file: string,
  listCanonical: string,
  modelle: DynamicListModel[] = DYNAMIC_LIST_MODELS
): DynamicListModel | null {
  return (
    modelle.find((m) => m.file === file && m.path === listCanonical) ?? null
  );
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
function modelTypeForAppend(
  file: string,
  segments: Array<string | number>,
  liveJson: Record<string, unknown> | undefined,
  modelle: DynamicListModel[] = DYNAMIC_LIST_MODELS
): FieldType | null {
  const ctx = appendContextFor(segments, liveJson);
  if (!ctx || ctx.rest.length !== 1 || typeof ctx.rest[0] !== "string") return null;
  const model = findListModel(file, ctx.listCanonical, modelle);
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
  liveJson: Record<string, unknown> | undefined,
  modelle: DynamicListModel[] = DYNAMIC_LIST_MODELS
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
  const modelType = modelTypeForAppend(file, segments, liveJson, modelle);
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
  liveJson: Record<string, unknown> | undefined,
  modelle: DynamicListModel[] = DYNAMIC_LIST_MODELS
): unknown {
  const parsed = parsePathSafe(editPath);
  if (!parsed.ok) return rawValue;
  const resolved = resolveEditType(
    file,
    parsed.segments,
    `${file}#${parsed.canonical}`,
    typeMap,
    liveJson,
    modelle
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
  candidate: Record<string, unknown>,
  modelle: DynamicListModel[] = DYNAMIC_LIST_MODELS
): string[] {
  const ctx = appendContextFor(segments, liveJson);
  if (!ctx || ctx.rest.length > 1) return [];
  const model = findListModel(file, ctx.listCanonical, modelle);
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
  typeMap: Map<string, TypeEntry>,
  modelle: DynamicListModel[] = DYNAMIC_LIST_MODELS
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
    for (const m of modelle) {
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
  isCovered: (file: string, canonical: string) => boolean = () => false,
  modelle: DynamicListModel[] = DYNAMIC_LIST_MODELS
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
      const model = findListModel(file, spot.canonical, modelle);
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
