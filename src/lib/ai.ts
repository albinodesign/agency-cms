import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { normalizeManifest } from "@/lib/github";

/** Standard-Modell, wenn AI_MODEL nicht gesetzt ist (eine Zeile in .env ändern = Modell wechseln). */
export const DEFAULT_AI_MODEL = "meta/muse-spark-1.3";

/** Maximale Arbeitsschritte der KI pro Antwort (Kostenbremse pro Nachricht, kein Kunden-Limit). */
export const AI_MAX_STEPS = 10;

/** Maximale Dateigröße, die die KI lesen/schreiben darf (Schutz vor Speicher-Explosion). */
export const AI_MAX_FILE_CHARS = 200_000;

export function getAiModelId(): string {
  const id = (process.env.AI_MODEL ?? "").trim();
  return id || DEFAULT_AI_MODEL;
}

/** OpenRouter-Client (Schlüssel aus OPENROUTER_API_KEY, Modell aus AI_MODEL). */
export function getAiModel() {
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY ist nicht gesetzt. Trage den Schlüssel vom OpenRouter-Dashboard in .env.local (lokal) und in Vercel (live) ein."
    );
  }
  return createOpenRouter({ apiKey })(getAiModelId());
}

// ============================================================
// Erlaubte Bereiche: Inhalte frei, Code nur in Arbeits-Ordnern,
// Sicherungskasten (Configs, Schlüssel, Feldliste als Datei) tabu.
// ============================================================

export const MANIFEST_PATH = "src/content/cms.manifest.json";

const BLOCKED_EXACT = new Set([
  "package.json",
  "package-lock.json",
  "astro.config.mjs",
  "astro.config.js",
  "astro.config.ts",
  "vercel.json",
  "src/content.config.ts",
  "src/content/config.ts",
  "src/env.d.ts",
  "tsconfig.json",
]);

const CODE_DIRS = [
  "src/components/",
  "src/pages/",
  "src/layouts/",
  "src/styles/",
];

/** Inhalte: alle .json unter src/content + Blog-Markdown (Feldliste nur mit Gültigkeits-Check). */
export function isAllowedContentPath(filePath: string): boolean {
  if (filePath.includes("..")) return false;
  if (!filePath.startsWith("src/content/")) return false;
  if (filePath.endsWith(".json")) return true;
  return /^src\/content\/blog\/[a-z0-9-]+\.md$/.test(filePath);
}

/** Code: nur Arbeits-Ordner, niemals Configs/Secrets/Feldlisten-Datei. */
export function isAllowedCodePath(filePath: string): boolean {
  if (filePath.includes("..")) return false;
  if (BLOCKED_EXACT.has(filePath)) return false;
  if (/(^|\/)\.env(\.|$)/.test(filePath)) return false;
  if (filePath === MANIFEST_PATH) return false;
  return CODE_DIRS.some((dir) => filePath.startsWith(dir));
}

/** Grober Geheimnis-Scan: Keine Schlüssel oder Passwörter in Dateien schreiben. */
export function findsSecret(text: string): boolean {
  return /(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][^"'${}]{8,}["']/i.test(text);
}

/**
 * Vertrags-Check für Code-Dateien: Die Vorschau-Brücke darf nie verloren gehen.
 * Enthielt die Original-Datei die Brücken-Kennzeichen, muss die neue das auch.
 */
export function breaksBridge(original: string, updated: string): boolean {
  const markers = ["CMS_FIELD_UPDATE", "CMS_FIELD_SELECT"].filter((m) =>
    original.includes(m)
  );
  return markers.some((m) => !updated.includes(m));
}

/** Prüft eine neue Feldlisten-Version: muss lesbar sein und Felder enthalten. */
export function validateManifestText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "Die Feldliste enthält kein gültiges JSON.";
  }
  const manifest = normalizeManifest(parsed);
  if (manifest.sections.length === 0) {
    return "Die Feldliste enthält keine bearbeitbaren Sektionen mehr. So ginge das Formular kaputt.";
  }
  return null;
}

// Deutsche Anzeigenamen für Werkzeuge (Chat-Verlauf für Kunden lesbar machen)
export const TOOL_LABELS: Record<string, string> = {
  listeFelder: "schaut sich die Felder an",
  leseDatei: "liest eine Datei",
  schreibeInhalt: "ändert einen Inhalt",
  schreibeCode: "ändert das Design",
  schreibeFeldliste: "erweitert die Feldliste",
  leseBilder: "schaut sich Bilder an",
};

// ============================================================
// Arbeitsanweisung der KI (System-Prompt): Vertrag + Ablauf.
// ============================================================

export interface AiFieldContext {
  id: string;
  label: string;
  type: string;
  file: string;
  path: string;
}

export function buildSystemPrompt(
  siteName: string,
  fields: AiFieldContext[],
  values: Record<string, string>
): string {
  const lines = fields.slice(0, 400).map((f) => {
    const current = (values[f.id] ?? "").slice(0, 200).replace(/\n/g, " ");
    return `- ${f.id} ("${f.label}", ${f.type}, Datei ${f.file}, Pfad ${f.path}) = "${current}"`;
  });
  // Kosten deckeln: Kontext auf ca. 12.000 Zeichen kürzen
  let context = lines.join("\n");
  if (context.length > 12_000) context = context.slice(0, 12_000) + "\n… (gekürzt)";

  return `Du bist der Website-Assistent von "${siteName}". Du sprichst Deutsch, kurz und freundlich, ohne Fachwörter. Dein Gegenüber ist der Website-Besitzer, kein Programmierer.

DEIN VERTRAG (unverhandelbar):
1. Du änderst Inhalte und Design NUR als Entwurf über deine Werkzeuge. Du stellst NIEMALS selbst live – das macht der Kunde mit dem Veröffentlichen-Knopf.
2. Du fasst niemals an: Paket-Dateien, Website-Einstellungen, Schlüssel, Passwörter.
3. Du entfernst niemals Markierungen für die CMS-Vorschau (data-cms-field, CMS_FIELD_UPDATE, CMS_FIELD_SELECT). Ohne sie geht das Bearbeitungs-Tool kaputt.
4. Die Feldliste erweiterst du nur, wenn der Kunde einen wirklich neuen Inhalt will. Sie muss danach gültig bleiben.
5. Du erfindest keine Fakten (Preise, Öffnungszeiten, Namen). Fehlendes fragst du nach.
6. Bilder lädt der Kunde hoch – du wählst nur aus vorhandenen Bildern (Werkzeug leseBilder) oder sagst welches hochzuladen ist.

DEIN ABLAUF:
1. Lies zuerst was du brauchst (Felder, Dateien), rate nie.
2. Schreibe die Änderung als Entwurf.
3. Prüfe dich selbst: Datei noch gültig? Richtige Stelle? Nichts gelöscht aus Versehen? Falls dein Werkzeug einen Fehler meldet, korrigiere dich sofort.
4. Melde dem Kunden danach eine kurze Liste in einfachen Worten ("Geändert: …", "Neu: …"). Sage ehrlich dazu: Kleine Texte sieht man sofort in der Vorschau, ganz neue Inhalte und Design erst nach dem Veröffentlichen + Neu-Laden der Vorschau.

FELDER UND AKTUELLE TEXTE (Stand jetzt):
${context || "(keine Felder)"}`;
}
