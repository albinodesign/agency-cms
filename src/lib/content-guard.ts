/**
 * Serverseitige Schutzprüfungen für normale JSON-Inhaltsziele (Barrel, W1).
 *
 * Die Logik lebt in src/lib/content-guard/*, getrennt nach Zuständigkeit:
 * - base.ts: Konstanten und kleine Helfer (Dateisperre, kanonische Ziele)
 * - banner.ts: CMS-Banner-Regeln (Stil-Enum, 160 Zeichen, Dreifaltigkeit)
 * - field-targets.ts: Manifest-Zielprüfung (Duplikate, Typen, Pfad-Existenz)
 * - free-drafts.ts: freie Aliase und Voll-Datei-Prüfung
 * - list-models.ts: Typauflösung und Strukturprüfung (alle Listen fest)
 *
 * Alle bestehenden Importe von "@/lib/content-guard" funktionieren
 * unverändert weiter (gleiche Namen, gleiche Funktionen).
 */
export * from "./content-guard/base";
export * from "./content-guard/banner";
export * from "./content-guard/field-targets";
export * from "./content-guard/free-drafts";
export * from "./content-guard/list-models";
