import { NextResponse } from "next/server";
import { streamText, tool, stepCountIs, convertToModelMessages } from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getRepoFile } from "@/lib/github";
import { validateDraftValue } from "@/lib/validate";
import {
  AI_MAX_FILE_CHARS,
  AI_MAX_STEPS,
  MANIFEST_PATH,
  AiFieldContext,
  breaksBridge,
  buildSystemPrompt,
  findsSecret,
  getAiModel,
  getAiModelId,
  isAllowedCodePath,
  isAllowedContentPath,
  validateManifestText,
} from "@/lib/ai";
import type { Site } from "@/types/cms";
import { FREE_DRAFT_PREFIX } from "@/types/cms";

/** Ordnet einen OpenRouter-Fehler auf eine deutsche Kunden-Meldung zu. */
function mapAiError(err: unknown): { message: string; status: number } {
  const text = err instanceof Error ? `${err.message} ${"cause" in err ? String((err as { cause: unknown }).cause) : ""}` : String(err);
  const lower = text.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("api key")) {
    return {
      message: "Der KI-Schlüssel stimmt nicht (OPENROUTER_API_KEY). Bitte im Dashboard prüfen und in .env.local bzw. Vercel eintragen.",
      status: 500,
    };
  }
  if (lower.includes("402") || lower.includes("credit") || lower.includes("guthaben")) {
    return {
      message: "Das OpenRouter-Guthaben ist aufgebraucht. Bitte im OpenRouter-Dashboard aufladen.",
      status: 500,
    };
  }
  if (lower.includes("404") || lower.includes("not found") || lower.includes("no endpoints")) {
    return {
      message: `Das Modell "${getAiModelId()}" wurde auf OpenRouter nicht gefunden. Bitte die exakte Modell-ID aus dem OpenRouter-Dashboard in AI_MODEL eintragen.`,
      status: 500,
    };
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return {
      message: "Die KI ist gerade überlastet. Bitte in einer Minute erneut versuchen.",
      status: 503,
    };
  }
  console.error("KI-Chat fehlgeschlagen:", err);
  return { message: "Die KI antwortet gerade nicht. Bitte später erneut versuchen.", status: 500 };
}

interface ChatContext {
  fields?: AiFieldContext[];
  values?: Record<string, string>;
}

function getTextFromUIMessage(msg: UIMessage): string {
  return (msg.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("\n")
    .trim();
}

export async function POST(request: Request) {
  let body: {
    siteId?: string;
    conversationId?: string | null;
    messages?: UIMessage[];
    context?: ChatContext;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
  }

  const { siteId, conversationId } = body;
  const clientMessages = Array.isArray(body.messages) ? body.messages : [];
  const context = body.context ?? {};
  const fields = Array.isArray(context.fields) ? context.fields : [];
  const values = context.values && typeof context.values === "object" ? context.values : {};

  if (!siteId || typeof siteId !== "string") {
    return NextResponse.json({ error: "siteId fehlt." }, { status: 400 });
  }
  const userText = [...clientMessages].reverse().find((m) => m.role === "user") ?? null;
  const userContent = userText ? getTextFromUIMessage(userText) : "";
  if (!userContent) {
    return NextResponse.json({ error: "Nachricht ist leer." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
  }

  // Zugriff + KI-Freischaltung prüfen
  const { data: assignment } = await supabase
    .from("user_sites")
    .select("site_id")
    .eq("user_id", user.id)
    .eq("site_id", siteId)
    .maybeSingle();
  if (!assignment) {
    return NextResponse.json({ error: "Kein Zugriff auf diese Website." }, { status: 403 });
  }
  const { data: siteRow } = await supabase.from("sites").select("*").eq("id", siteId).single();
  const site = siteRow as Site | null;
  if (!site) {
    return NextResponse.json({ error: "Website nicht gefunden." }, { status: 404 });
  }
  if (!site.ai_enabled) {
    return NextResponse.json(
      { error: "Der KI-Chat ist für diese Website nicht freigeschaltet." },
      { status: 403 }
    );
  }

  // Gespräch laden oder anlegen (Titel aus erster Nachricht).
  // Der Kunde schickt eine eigene ID mit – so geht beim Neuladen nichts verloren.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let convId = typeof conversationId === "string" && conversationId ? conversationId : null;
  if (convId && !uuidRe.test(convId)) convId = null;
  if (convId) {
    const { data: conv } = await supabase
      .from("ai_conversations")
      .select("id")
      .eq("id", convId)
      .eq("site_id", siteId)
      .maybeSingle();
    if (!conv) {
      // Neue ID vom Kunden: Gespräch damit anlegen
      const { error } = await supabase.from("ai_conversations").insert({
        id: convId,
        site_id: siteId,
        created_by: user.id,
        title: userContent.slice(0, 60) || "Neues Gespräch",
      });
      if (error) convId = null;
    }
  }
  if (!convId) {
    const { data: created, error } = await supabase
      .from("ai_conversations")
      .insert({ site_id: siteId, created_by: user.id, title: userContent.slice(0, 60) || "Neues Gespräch" })
      .select("id")
      .single();
    if (error || !created) {
      return NextResponse.json({ error: "Gespräch konnte nicht angelegt werden." }, { status: 500 });
    }
    convId = (created as { id: string }).id;
  }
  const activeConvId = convId;

  // Kunden-Nachricht speichern (für Verlauf + späteres Fortsetzen)
  await supabase.from("ai_messages").insert({
    conversation_id: activeConvId,
    role: "user",
    content: { text: userContent },
  });

  const fieldMap = new Map(fields.map((f) => [f.id, f]));
  let octokit: ReturnType<typeof createOctokit> | null = null;
  function octo() {
    if (!octokit) octokit = createOctokit();
    return octokit;
  }

  async function upsertDraft(fieldId: string, value: string) {
    return supabase
      .from("drafts")
      .upsert({ site_id: siteId, field_id: fieldId, value }, { onConflict: "site_id,field_id" });
  }

  const tools = {
    listeFelder: tool({
      description: "Listet alle bearbeitbaren Felder der Website (ID, Name, Typ).",
      inputSchema: z.object({}),
      execute: async () => ({
        felder: fields.map((f) => ({ id: f.id, name: f.label, typ: f.type })),
      }),
    }),
    leseDatei: tool({
      description: "Liest eine Website-Datei (Inhalt oder Code). Nur erlaubte Dateien.",
      inputSchema: z.object({ datei: z.string().describe("Dateipfad im Repo, z. B. src/content/pages/home.json") }),
      execute: async ({ datei }) => {
        if (!isAllowedContentPath(datei) && !isAllowedCodePath(datei)) {
          return { fehler: `Die Datei "${datei}" darfst du nicht öffnen (Tabu-Bereich).` };
        }
        try {
          const file = await getRepoFile(octo(), site.repo_owner, site.repo_name, datei);
          return { datei, inhalt: file.text.slice(0, AI_MAX_FILE_CHARS) };
        } catch (err) {
          return { fehler: `Die Datei "${datei}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : "unbekannt"}` };
        }
      },
    }),
    schreibeInhalt: tool({
      description: "Ändert einen Inhalt als Entwurf (geht NICHT live, nur Vorbereitung). Entweder feldId ODER datei+pfad angeben.",
      inputSchema: z.object({
        feldId: z.string().optional().describe("Feld-ID aus der Feldliste, z. B. hero.title"),
        datei: z.string().optional().describe("Nur ohne feldId: Zieldatei, z. B. src/content/pages/home.json"),
        pfad: z.string().optional().describe("Nur ohne feldId: Pfad in der Datei, z. B. hero.title oder faq.eintraege[0].frage"),
        wert: z.string().describe("Der neue Text"),
      }),
      execute: async ({ feldId, datei, pfad, wert }) => {
        if (typeof wert !== "string" || wert.length > 20_000) {
          return { fehler: "Der Text ist zu lang (max. 20.000 Zeichen). Bitte kürzen." };
        }
        if (feldId) {
          const field = fieldMap.get(feldId);
          if (!field) return { fehler: `Das Feld "${feldId}" gibt es nicht.` };
          const problem = validateDraftValue(field.type as "text", wert, undefined);
          if (problem) return { fehler: `${field.label}: ${problem}` };
          const { error } = await upsertDraft(feldId, wert);
          if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
          return { art: "feld", feldId, wert, vorschau: "sofort", meldung: `"${field.label}" als Entwurf gespeichert, Kunde sieht es sofort in der Vorschau.` };
        }
        if (datei && pfad) {
          if (!isAllowedContentPath(datei) || datei === MANIFEST_PATH) {
            return { fehler: `Die Datei "${datei}" darfst du so nicht ändern.` };
          }
          const freeId = `${FREE_DRAFT_PREFIX}${datei}:${pfad}`;
          const { error } = await upsertDraft(freeId, wert);
          if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
          return { art: "frei", feldId: freeId, vorschau: "nach Veröffentlichen", meldung: `Entwurf für ${datei} (${pfad}) gespeichert, sichtbar nach dem Veröffentlichen.` };
        }
        return { fehler: "Bitte feldId oder datei+pfad angeben." };
      },
    }),
    schreibeCode: tool({
      description: "Ändert eine Design-/Code-Datei als Entwurf (geht NICHT live). Ganzen neuen Datei-Inhalt übergeben.",
      inputSchema: z.object({
        datei: z.string().describe("Dateipfad, z. B. src/components/Header.astro"),
        inhalt: z.string().describe("Der komplette neue Datei-Inhalt"),
      }),
      execute: async ({ datei, inhalt }) => {
        if (!isAllowedCodePath(datei)) {
          return { fehler: `Die Datei "${datei}" darfst du nicht ändern (Tabu-Bereich: Einstellungen, Pakete, Feldliste).` };
        }
        if (inhalt.length > AI_MAX_FILE_CHARS) {
          return { fehler: "Die Datei ist zu groß. Bitte in kleinere Schritte aufteilen." };
        }
        if (findsSecret(inhalt)) {
          return { fehler: "Der Inhalt sieht nach Schlüssel oder Passwort aus. So etwas gehört niemals in Dateien." };
        }
        try {
          const file = await getRepoFile(octo(), site.repo_owner, site.repo_name, datei);
          const original = file.text;
          if (breaksBridge(original, inhalt)) {
            return { fehler: "Der neue Inhalt würde die CMS-Vorschau-Brücke entfernen. Die muss bleiben – bitte Version mit Brücke einreichen." };
          }
        } catch (err) {
          return { fehler: `Original-Datei konnte nicht gelesen werden: ${err instanceof Error ? err.message : "unbekannt"}` };
        }
        const { error } = await supabase
          .from("code_drafts")
          .upsert({ site_id: siteId, file_path: datei, content: inhalt }, { onConflict: "site_id,file_path" });
        if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
        return { art: "code", datei, vorschau: "nach Veröffentlichen", meldung: `Design-Entwurf für ${datei} gespeichert, sichtbar nach dem Veröffentlichen.` };
      },
    }),
    schreibeFeldliste: tool({
      description: "Erweitert die Feldliste des Editors (nur wenn der Kunde wirklich neue Inhalte will). Ganzen neuen JSON-Inhalt übergeben.",
      inputSchema: z.object({ inhalt: z.string().describe("Der komplette neue Inhalt von src/content/cms.manifest.json") }),
      execute: async ({ inhalt }) => {
        const problem = validateManifestText(inhalt);
        if (problem) return { fehler: problem };
        const { error } = await supabase
          .from("code_drafts")
          .upsert({ site_id: siteId, file_path: MANIFEST_PATH, content: inhalt }, { onConflict: "site_id,file_path" });
        if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
        return { art: "manifest", datei: MANIFEST_PATH, vorschau: "nach Veröffentlichen", meldung: "Feldlisten-Entwurf gespeichert, aktiv nach dem Veröffentlichen." };
      },
    }),
    leseBilder: tool({
      description: "Listet bereits hochgeladene Bilder (zum Wiederverwenden statt neu hochladen).",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { data, error } = await supabase.storage.from("cms-media").list(`sites/${siteId}`, { limit: 30 });
          if (error) return { bilder: [], meldung: "Keine Bilder gefunden – Kunde muss erst welche hochladen." };
          const urls = (data ?? [])
            .filter((f) => f.name && !f.name.startsWith("."))
            .map((f) => supabase.storage.from("cms-media").getPublicUrl(`sites/${siteId}/${f.name}`).data.publicUrl);
          return { bilder: urls };
        } catch {
          return { bilder: [], meldung: "Bilder konnten nicht geladen werden." };
        }
      },
    }),
  };

  let model;
  try {
    model = getAiModel();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "KI nicht konfiguriert." },
      { status: 500 }
    );
  }

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(clientMessages);
  } catch {
    return NextResponse.json({ error: "Nachrichten konnten nicht verarbeitet werden." }, { status: 400 });
  }

  try {
    const result = streamText({
      model,
      system: buildSystemPrompt(site.name, fields, values),
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(AI_MAX_STEPS),
      onFinish: async ({ text, totalUsage }) => {
        try {
          await supabase.from("ai_messages").insert({
            conversation_id: activeConvId,
            role: "assistant",
            content: { text },
            prompt_tokens: totalUsage?.inputTokens ?? 0,
            completion_tokens: totalUsage?.outputTokens ?? 0,
          });
          const month = new Date().toISOString().slice(0, 7);
          const { data: existing } = await supabase
            .from("ai_usage")
            .select("*")
            .eq("site_id", siteId)
            .eq("month", month)
            .maybeSingle();
          const row = existing as { messages: number; prompt_tokens: number; completion_tokens: number } | null;
          await supabase.from("ai_usage").upsert(
            {
              site_id: siteId,
              month,
              messages: (row?.messages ?? 0) + 1,
              prompt_tokens: (row?.prompt_tokens ?? 0) + (totalUsage?.inputTokens ?? 0),
              completion_tokens: (row?.completion_tokens ?? 0) + (totalUsage?.outputTokens ?? 0),
            },
            { onConflict: "site_id,month" }
          );
          await supabase.from("ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", activeConvId);
        } catch (err) {
          console.error("KI-Verlauf speichern fehlgeschlagen:", err);
        }
      },
    });
    const response = result.toUIMessageStreamResponse();
    return response;
  } catch (err) {
    const mapped = mapAiError(err);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}
