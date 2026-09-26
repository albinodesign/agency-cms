/**
 * Manifest-Zielprüfung: Feldziele, Duplikate, Pfad-Existenz (W1).
 * Gehört zu src/lib/content-guard.ts (Barrel) – keine Logik ändern.
 */
import { getByPath } from "../json-path";
import type { FieldType, ManifestField } from "../../types/cms";
import {
  MANIFEST_PATH,
  MAX_MANIFEST_MAX_LENGTH,
  SITE_JSON,
  SUPPORTED_FIELD_TYPES,
  canonicalTarget,
  isAllowedFieldJsonFile,
  validateJsonPath,
} from "./base";
import { bannerMaxLength, bannerTargetType } from "./banner";

/** Flacht ein Roh-Manifest (alle akzeptierten Formate) zu einer Feldliste ab. */
export function extractRawFields(raw: unknown): unknown[] {
  const candidate = Array.isArray(raw)
    ? raw
    : ((raw as { sections?: unknown; fields?: unknown } | null)?.sections ??
      (raw as { fields?: unknown } | null)?.fields ??
      []);
  if (!Array.isArray(candidate)) return [];
  const looksLikeSections = candidate.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      Array.isArray((item as { fields?: unknown }).fields)
  );
  if (!looksLikeSections) return candidate;
  const out: unknown[] = [];
  for (const section of candidate) {
    if (
      typeof section === "object" &&
      section !== null &&
      Array.isArray((section as { fields?: unknown }).fields)
    ) {
      out.push(...((section as { fields: unknown[] }).fields));
    }
  }
  return out;
}

interface RawField {
  id?: unknown;
  file?: unknown;
  path?: unknown;
  type?: unknown;
  maxLength?: unknown;
}

function fileTargetError(fieldLabel: string, file: string): string {
  if (file === "package.json" || file.endsWith("/package.json")) {
    return `Feld "${fieldLabel}": Die Datei "package.json" ist kein erlaubtes Inhaltsziel. Erlaubt sind ${SITE_JSON} und JSON-Dateien unter src/content/pages/.`;
  }
  if (file === MANIFEST_PATH || file.endsWith("cms.manifest.json")) {
    return `Feld "${fieldLabel}": Die Feldliste selbst ist kein bearbeitbares Inhaltsziel.`;
  }
  return `Feld "${fieldLabel}": Die Datei "${file}" ist kein erlaubtes Inhaltsziel. Erlaubt sind ${SITE_JSON} und JSON-Dateien unter src/content/pages/.`;
}

/**
 * Prüft die vom Server geladene Manifestdefinition gegen die tatsächlich
 * geladenen Datei-Inhalte. Liefert eine Liste deutscher Fehlermeldungen
 * (leer = alles ok). Prüft: vorhandene id, eindeutige IDs, unterstützte Typen,
 * sinnvolle maxLength, erlaubte Zieldatei, sicheren Pfad, eindeutige Ziele
 * (Schreibweisen-normiert) und tatsächliche Pfad-Existenz in der Datei.
 * Pfade, die im selben Änderungssatz durch eine akzeptierte Erstellung
 * (pendingCreations als "datei#kanonisch") entstehen, gelten als abgedeckt.
 */
export function validateFieldTargets(
  rawFields: unknown[],
  fileContents: Map<string, Record<string, unknown>>,
  pendingCreations: Set<string> = new Set()
): string[] {
  const errors: string[] = [];
  const seenIds = new Map<string, number>();
  const seenTargets = new Map<string, string>();

  rawFields.forEach((entry, index) => {
    const label = `Feld Nr. ${index + 1}`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${label} ist ungültig (kein Objekt).`);
      return;
    }
    const field = entry as RawField;
    const id =
      typeof field.id === "string" && field.id.trim() !== "" ? field.id : null;
    const name = id ?? label;
    if (!id) {
      errors.push(`${label} hat keine gültige id.`);
      return;
    }
    const firstSeen = seenIds.get(id);
    if (firstSeen !== undefined) {
      errors.push(`Feld "${id}" ist doppelt vergeben (auch ${label}).`);
    } else {
      seenIds.set(id, index);
    }

    if (!SUPPORTED_FIELD_TYPES.includes(field.type as FieldType)) {
      errors.push(
        `Feld "${id}": Typ "${String(field.type)}" wird nicht unterstützt (erlaubt: ${SUPPORTED_FIELD_TYPES.join(", ")}).`
      );
    }

    if (field.maxLength !== undefined && field.maxLength !== null) {
      if (
        !Number.isInteger(field.maxLength) ||
        (field.maxLength as number) < 1 ||
        (field.maxLength as number) > MAX_MANIFEST_MAX_LENGTH
      ) {
        errors.push(
          `Feld "${id}": maxLength muss eine ganze Zahl zwischen 1 und ${MAX_MANIFEST_MAX_LENGTH} sein.`
        );
      }
    }

    const file = typeof field.file === "string" ? field.file : "";
    if (!isAllowedFieldJsonFile(file)) {
      errors.push(fileTargetError(name, file || "(leer)"));
      return;
    }

    const pathProblem = validateJsonPath(field.path);
    if (pathProblem) {
      errors.push(`Feld "${id}": ${pathProblem}`);
      return;
    }
    const target = canonicalTarget(file, field.path as string) as string;
    const other = seenTargets.get(target);
    if (other !== undefined) {
      errors.push(
        `Feld "${id}" und Feld "${other}" zeigen auf dasselbe Ziel (${file}, Pfad "${field.path}").`
      );
    } else {
      seenTargets.set(target, id);
    }

    const json = fileContents.get(file);
    if (!json) {
      errors.push(`Feld "${id}": Datei "${file}" konnte nicht geladen werden.`);
      return;
    }
    if (getByPath(json, field.path as string) === undefined) {
      const target = canonicalTarget(file, field.path as string) as string;
      if (pendingCreations.has(target)) return; // entsteht im selben Satz
      errors.push(`Feld "${id}": Pfad "${field.path}" existiert nicht in Datei "${file}".`);
    }
  });

  return errors;
}

/** Aufgelöster Zieltyp: Manifestfeld, Banner-Regel oder freier Text. */
export interface ResolvedTarget {
  type: FieldType;
  maxLength?: number;
  label: string;
  via: "manifest" | "banner" | "frei";
}

/**
 * Löst den Typ eines Inhaltsziels einheitlich auf – unabhängig vom
 * Zugriffsweg (Manifestfeld oder freier Alias). Ein freier Alias auf ein
 * deklariertes Manifestziel erbt dessen Typ, maxLength und Label. So kann
 * z. B. kein Alias die Längenbegrenzung umgehen und Zahlen werden auch über
 * Alias als Zahlen gespeichert.
 */
export function resolveTargetType(
  canonical: string,
  manifestByCanonical: Map<string, ManifestField>,
  file: string,
  segments: Array<string | number>
): ResolvedTarget {
  const declared = manifestByCanonical.get(canonical);
  if (declared) {
    return { type: declared.type, maxLength: declared.maxLength, label: declared.label, via: "manifest" };
  }
  if (
    file === SITE_JSON &&
    segments.length === 2 &&
    segments[0] === "banner" &&
    typeof segments[1] === "string"
  ) {
    const key = segments[1];
    return {
      type: bannerTargetType(key),
      maxLength: bannerMaxLength(key),
      label: `Banner-${key}`,
      via: "banner",
    };
  }
  const leaf = segments[segments.length - 1];
  return { type: "text", label: String(leaf), via: "frei" };
}
