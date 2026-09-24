import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { normalizeManifest } from "@/lib/github";

export const DEFAULT_AI_MODEL = "meta/muse-spark-1.3";
export const AI_MAX_STEPS = 25;
/** Maximale Dateigröße für Lese-Operationen (Schutz vor Token-Explosion) */
export const AI_MAX_FILE_CHARS = 50_000;

/** OpenRouter-Preise für Meta Muse Spark 1.3 umgerechnet in Euro */
export const AI_INPUT_COST_PER_MILLION_EUR = 1.15;
export const AI_OUTPUT_COST_PER_MILLION_EUR = 3.90;

export function calculateCostEuro(promptTokens: number, completionTokens: number): number {
  const inputCost = (promptTokens / 1_000_000) * AI_INPUT_COST_PER_MILLION_EUR;
  const outputCost = (completionTokens / 1_000_000) * AI_OUTPUT_COST_PER_MILLION_EUR;
  return Math.round((inputCost + outputCost) * 100) / 100;
}

export function getAiModelId(): string {
  const id = (process.env.AI_MODEL ?? "").trim();
  return id || DEFAULT_AI_MODEL;
}

export function getAiModel() {
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY ist nicht gesetzt. Bitte im Dashboard und in den Umgebungsvariablen hinterlegen."
    );
  }
  return createOpenRouter({ apiKey })(getAiModelId());
}

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

export function isAllowedContentPath(filePath: string): boolean {
  if (filePath.includes("..")) return false;
  if (!filePath.startsWith("src/content/")) return false;
  if (filePath.endsWith(".json")) return true;
  return /^src\/content\/blog\/[a-z0-9-]+\.md$/.test(filePath);
}

export function isAllowedCodePath(filePath: string): boolean {
  if (filePath.includes("..")) return false;
  if (BLOCKED_EXACT.has(filePath)) return false;
  if (/(^|\/)\.env(\.|$)/.test(filePath)) return false;
  if (filePath === MANIFEST_PATH) return false;
  return CODE_DIRS.some((dir) => filePath.startsWith(dir));
}

export function findsSecret(text: string): boolean {
  return /(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][^"'${}]{8,}["']/i.test(text);
}

export function breaksBridge(original: string, updated: string): boolean {
  const markers = ["CMS_FIELD_UPDATE", "CMS_FIELD_SELECT"].filter((m) =>
    original.includes(m)
  );
  return markers.some((m) => !updated.includes(m));
}

export function validateManifestText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "Die Feldliste enthält kein gültiges JSON.";
  }
  const manifest = normalizeManifest(parsed);
  if (manifest.sections.length === 0) {
    return "Die Feldliste enthält keine bearbeitbaren Sektionen mehr.";
  }
  return null;
}

export interface AiFieldContext {
  id: string;
  label: string;
  type: string;
  file: string;
  path: string;
  /** Zeichenbegrenzung aus dem Manifest (gegen stillen Verlust im Chat). */
  maxLength?: number;
}

export function buildSystemPrompt(
  siteName: string,
  fields: AiFieldContext[],
  values: Record<string, string>
): string {
  // Kein Feldanzahl-Limit: Die Anzahl richtet sich nach dem Inhalt.
  // Nur die Gesamtlänge ist per Zeichen-Budget begrenzt (Token-Schutz),
  // nie die Feldanzahl.
  const BUDGET = 12_000;
  const lines: string[] = [];
  let shown = 0;
  let used = 0;
  for (const f of fields) {
    const current = (values[f.id] ?? "").slice(0, 120).replace(/\n/g, " ");
    const line = `- ${f.id} ("${f.label}", ${f.type}) = "${current}"`;
    if (used + line.length > BUDGET) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const hidden = fields.length - shown;

  return `Du bist der proaktive Senior Web Designer, Conversion-Stratege und Full-Stack Astro-Architekt für die Website "${siteName}".
Dein Gegenüber ist der Website-Inhaber (oft Handwerker oder lokaler Dienstleister). Er versteht keinen Programmiercode. Du sprichst sympathisch, professionell, lösungsorientiert und auf Augenhöhe auf Deutsch.

DEINE DREI GOLDENEN VERHALTENSREGELN (KIMI-CODE-PRINZIP):
1. SEI NIEMALS EIN STUMMER BEFEHLSEMPFÄNGER:
   Führe nicht einfach nur still Werkzeuge aus! Antworte nach getaner Arbeit IMMER ausführlich im Chat.
   - Erkläre in einfachen Worten, was du geändert oder neu gebaut hast.
   - Gib ungefragt 1–2 professionelle Webdesign-/Conversion-Ratschläge (z. B. „Ich habe den Button leuchtender gemacht, damit Besucher ihn schneller klicken. Bei Handwerker-Websites empfiehlt es sich außerdem, direkt darunter Kundenbewertungen zu platzieren.“).
   - Beende deine Nachricht IMMER mit einer klaren Entscheidungsfrage für den nächsten logischen Schritt (z. B. „Sollen wir als Nächstes die Galerie ergänzen oder den WhatsApp-Button verknüpfen?“).

ABSCHLUSS-PFLICHT: Nachdem du deine Änderungen mit schreibeCode oder schreibeInhalt gespeichert hast, DARFST DU KEIN WEITERES WERKZEUG AUFRUFEN. Dein allerletzter Schritt MUSS zwingend eine ausführliche, sympathische Textnachricht an den Kunden sein, in der du dein Werk erklärst, 1–2 Design-Tipps gibst und mit einer Frage endest.

2. TOKEN-DIÄT & GEZIELTES VORGEHEN:
   - Die Startseite liegt IMMER in src/pages/index.astro und src/content/pages/home.json.
   - Lies NIEMALS mehr als 2 Dateien auf Verdacht.
   - Nutze zuerst das Werkzeug "projektUebersicht", um zu sehen, welche Astro-Komponenten und Seiten existieren.
   - Lies nur die exakt benötigten Dateien.

3. ARCHITEKTUR-SICHERHEIT:
   - Du speicherst ALLES nur als Entwurf (Werkzeuge schreibeInhalt oder schreibeCode). Nichts geht sofort live, der Kunde prüft und veröffentlicht selbst per Button.
   - Entferne NIEMALS die CMS-Brücke (data-cms-field, CMS_FIELD_UPDATE, CMS_FIELD_SELECT).
   - Keine sensiblen Schlüssel oder Passwörter in Code schreiben.
   - Wenn du neuen Code baust, nutze semantisches HTML und Tailwind CSS 4.

BEKANNTE FORMULAR-FELDER:
${lines.join("\n") || "(keine Felder hinterlegt)"}${hidden > 0 ? `\n… (noch ${hidden} weitere Felder – nutze bei Bedarf das Werkzeug "listeFelder")` : ""}`;
}
