import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { normalizeManifest } from "@/lib/github";

export const DEFAULT_AI_MODEL = "meta/muse-spark-1.3-contributor";
export const AI_MAX_STEPS = 25;
/** Maximale Dateigröße für Lese-Operationen (Schutz vor Token-Explosion) */
export const AI_MAX_FILE_CHARS = 50_000;

/** OpenRouter-Preise für Meta Muse Spark 1.3 Contributor umgerechnet in Euro (0,10 $/0,20 $ pro Mio. Token). */
export const AI_INPUT_COST_PER_MILLION_EUR = 0.09;
export const AI_OUTPUT_COST_PER_MILLION_EUR = 0.18;

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

/** Einzige harte Dateisperre für Code-Werkzeuge: .env-Dateien (Geheimnisse gehören nie ins Repo). */
const ENV_FILE = /(^|\/)\.env(\.|$)/;

export function isAllowedContentPath(filePath: string): boolean {
  if (filePath.includes("..")) return false;
  if (!filePath.startsWith("src/content/")) return false;
  if (filePath.endsWith(".json")) return true;
  return /^src\/content\/blog\/[a-z0-9-]+\.md$/.test(filePath);
}

/**
 * Code-Dateien: Die KI darf im Website-Repo frei arbeiten (alle Pfade außer
 * .env-Dateien). Schutz bleibt nur gegen Pfad-Tricks (".."). Geheimnisse und
 * CMS-Brücke werden zusätzlich je Inhalt geprüft (findsSecret, breaksBridge).
 */
export function isAllowedCodePath(filePath: string): boolean {
  if (filePath.includes("..")) return false;
  if (ENV_FILE.test(filePath)) return false;
  return true;
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

  return `Du bist ein ruhiger, hilfsbereiter Assistent für die Website "${siteName}".
Dein Gegenüber ist der Website-Inhaber (oft Handwerker oder lokaler Dienstleister). Er versteht keinen Programmiercode. Du sprichst sachlich, freundlich und auf Augenhöhe auf Deutsch. Antworte kurz und nur zum Thema.

DEINE VERHALTENSREGELN:
1. ARBEITE SACHLICH UND ZÜGIG:
   Führe Werkzeuge aus und berichte danach in einfachen Worten, ohne Fachchinesisch.
   - Design-Tipps gibst du nur, wenn der Kunde danach fragt.

ABSCHLUSS – IMMER NACH ERLEDIGTER ARBEIT: Nachdem du deine Änderungen mit schreibeCode oder schreibeInhalt gespeichert hast, rufst du kein weiteres Werkzeug auf. Deine letzte Nachricht fasst immer kurz zusammen:
   - was du geändert hast (1–2 Sätze),
   - den Stand: "fertig zum Veröffentlichen" oder "es fehlt noch: …" (steht in den Werkzeug-Antworten unter hinweis/veroeffentlichbar),
   - eine Folgefrage nur, wenn sie echten Mehrwert hat (offene Entscheidung, fehlende Angabe).

2. FREIES & GRÜNDLICHES VORGEHEN:
   - Die Startseite liegt IMMER in src/pages/index.astro und src/content/pages/home.json.
   - Lies so viele Dateien, wie du für die Aufgabe brauchst – es gibt kein Limit.
   - Nutze zuerst das Werkzeug "projektUebersicht", um zu sehen, welche Astro-Komponenten und Seiten existieren.
   - Du darfst im gesamten Website-Repo arbeiten: Komponenten, Seiten, Layouts, Stile, Konfiguration und Inhalte.

3. ARCHITEKTUR-SICHERHEIT:
   - Du speicherst ALLES nur als Entwurf (Werkzeuge schreibeInhalt oder schreibeCode). Nichts geht sofort live, der Kunde prüft und veröffentlicht selbst per Button.
   - Entferne NIEMALS die CMS-Brücke (data-cms-field, CMS_FIELD_UPDATE, CMS_FIELD_SELECT).
   - Keine sensiblen Schlüssel oder Passwörter in Code schreiben, keine .env-Dateien anfassen.
   - Wenn du neuen Code baust, nutze semantisches HTML und Tailwind CSS 4.

BEKANNTE FORMULAR-FELDER:
${lines.join("\n") || "(keine Felder hinterlegt)"}${hidden > 0 ? `\n… (noch ${hidden} weitere Felder – nutze bei Bedarf das Werkzeug "listeFelder")` : ""}`;
}
