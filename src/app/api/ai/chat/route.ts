import { NextResponse } from "next/server";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import type { UIMessage } from "ai";
import { requireSiteAccess } from "@/lib/auth";
import { createOctokit, getManifestRaw, getRepoFile, normalizeManifest } from "@/lib/github";
import { AI_MAX_STEPS, AiFieldContext, buildSystemPrompt, getAiModel, getAiModelId } from "@/lib/ai";
import { buildAiTools } from "@/lib/ai-tools";

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
  // Hinweis: context.fields (Client) wird nicht mehr für Werkzeuge genutzt –
  // entscheidend ist die Server-Feldliste (unten). Nur values als Kontext.
  const values = context.values && typeof context.values === "object" ? context.values : {};

  if (!siteId || typeof siteId !== "string") {
    return NextResponse.json({ error: "siteId fehlt." }, { status: 400 });
  }
  const userText = [...clientMessages].reverse().find((m) => m.role === "user") ?? null;
  const userContent = userText ? getTextFromUIMessage(userText) : "";
  if (!userContent) {
    return NextResponse.json({ error: "Nachricht ist leer." }, { status: 400 });
  }

  // Zugriff + KI-Freischaltung prüfen (zentral: src/lib/auth.ts)
  const access = await requireSiteAccess(siteId);
  if (!access.ok) return access.error;
  const { supabase, user, site } = access;
  if (!site.ai_enabled) {
    return NextResponse.json(
      { error: "Der KI-Chat ist für diese Website nicht freigeschaltet." },
      { status: 403 }
    );
  }

  // Gespräch laden oder anlegen (Titel aus erster Nachricht).
  // Der Kunde schickt eine eigene ID mit – so geht beim Neuladen nichts verloren.
  // W10: Ein Gespräch gehört seinem Ersteller – fremde Gespräche derselben
  // Site lassen sich weder mitlesen noch fortschreiben. Alte Gespräche ohne
  // Ersteller (created_by null) werden beim ersten Aufruf übernommen.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let convId = typeof conversationId === "string" && conversationId ? conversationId : null;
  if (convId && !uuidRe.test(convId)) convId = null;
  if (convId) {
    const { data: conv } = await supabase
      .from("ai_conversations")
      .select("id,created_by")
      .eq("id", convId)
      .eq("site_id", site.id)
      .maybeSingle();
    const owner = (conv as { id: string; created_by: string | null } | null)?.created_by ?? null;
    if (!conv) {
      // Neue ID vom Kunden: Gespräch damit anlegen
      const { error } = await supabase.from("ai_conversations").insert({
        id: convId,
        site_id: site.id,
        created_by: user.id,
        title: userContent.slice(0, 60) || "Neues Gespräch",
      });
      if (error) convId = null;
    } else if (owner !== null && owner !== user.id) {
      // Fremdes Gespräch: nicht übernehmen, frisches Gespräch beginnen
      convId = null;
    } else if (owner === null) {
      // Altes Gespräch ohne Ersteller: übernehmen
      await supabase.from("ai_conversations").update({ created_by: user.id }).eq("id", convId);
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

  // Server-Feldliste zuerst laden (ein Abruf pro Nachricht): Die KI arbeitet
  // damit, nicht mit der Client-Liste. So sind Prompt, listeFelder und
  // schreibeInhalt vollständig und stimmen mit der Publish-Prüfung überein.
  let octokit: ReturnType<typeof createOctokit> | null = null;
  function octo() {
    if (!octokit) octokit = createOctokit();
    return octokit;
  }
  let serverFields: AiFieldContext[];
  try {
    const loaded = await getManifestRaw(octo(), site.repo_owner, site.repo_name);
    const serverManifest = normalizeManifest(loaded.parsed);
    serverFields = serverManifest.sections.flatMap((s) =>
      s.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, file: f.file, path: f.path, maxLength: f.maxLength }))
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: `Die Feldliste konnte nicht aus GitHub geladen werden: ${
          err instanceof Error ? err.message : "Unbekannter Fehler"
        }`,
      },
      { status: 502 }
    );
  }

  // Hochgeladene Dateien (Bilder/PDFs als URL) aus der Kundennachricht einsammeln:
  // convertToModelMessages übergibt sie ans Modell, hier zusätzlich als Hinweis
  // in den Prompt, damit die KI die URLs direkt im Code verwenden darf.
  interface HochgeladeneDatei { name?: string; url?: string; mediaType?: string }
  const hochgeladen: HochgeladeneDatei[] = [];
  if (userText) {
    for (const part of (userText.parts ?? []) as Array<{ type?: string; url?: string; mediaType?: string; filename?: string }>) {
      if (part?.type === "file" && typeof part.url === "string") {
        hochgeladen.push({ name: part.filename, url: part.url, mediaType: part.mediaType });
      }
    }
  }
  let system = buildSystemPrompt(site.name, serverFields, values);
  system += `\n\nHinweis zur Feldliste: Aus Platzgründen stehen oben ggf. nicht alle Felder. Die Liste ist dann unvollständig markiert – die VOLLSTÄNDIGE Liste erhältst du jederzeit über das Werkzeug "listeFelder" (alle IDs, ungekürzt), einzelne Werte über "leseFeld" (vollständig, auch weit hinten in großen Dateien) und Datei-Ausschnitte über "leseDatei" (Paging: gekuerzt=true bedeutet mit abZeichen=weiterAb fortsetzen) oder "projektUebersicht". Rate niemals Pfade, lade sie nach. Unvollständige Ergänzungen (hinweis der Werkzeuge) gibst du dem Kunden ehrlich weiter – erst vollständig veröffentlichen.`;
  if (hochgeladen.length > 0) {
    const liste = hochgeladen
      .map((d) => `- ${d.name ?? "Datei"} (${d.mediaType ?? "unbekannt"}): ${d.url}`)
      .join("\n");
    system += `\n\nDer Kunde hat ${hochgeladen.length === 1 ? "diese Datei" : "diese Dateien"} im Chat hochgeladen – du kannst sie sehen und die URLs direkt verwenden (z. B. im <img src="..." /> oder im Frontmatter als coverImage):\n${liste}`;
  }

  // Kunden-Nachricht speichern (für Verlauf + späteres Fortsetzen, inkl. Dateien)
  await supabase.from("ai_messages").insert({
    conversation_id: activeConvId,
    role: "user",
    content: { text: userContent, dateien: hochgeladen },
  });

  // Werkzeuge aus dem testbaren Modul (dieselben Regeln wie im Publish).
  const tools = buildAiTools({
    site: { id: siteId, repo_owner: site.repo_owner, repo_name: site.repo_name },
    serverFields,
    store: {
      // W12: DB-Rohmledungen gehören ins Server-Protokoll – an KI/Kunde
      // geht nur ein verständlicher Satz (keine Tabellen-/RLS-Details).
      storeDraft: async (sid, fieldId, value) => {
        const { error } = await supabase
          .from("drafts")
          .upsert({ site_id: sid, field_id: fieldId, value }, { onConflict: "site_id,field_id" });
        if (error) {
          console.error("ai/chat: storeDraft fehlgeschlagen:", error.message);
          return { error: { message: "Speichern fehlgeschlagen (Details im Server-Protokoll)." } };
        }
        return { error: null };
      },
      storeCodeDraft: async (sid, filePath, content) => {
        const { error } = await supabase
          .from("code_drafts")
          .upsert({ site_id: sid, file_path: filePath, content }, { onConflict: "site_id,file_path" });
        if (error) {
          console.error("ai/chat: storeCodeDraft fehlgeschlagen:", error.message);
          return { error: { message: "Speichern fehlgeschlagen (Details im Server-Protokoll)." } };
        }
        return { error: null };
      },
      listDrafts: async (sid) => {
        const { data, error } = await supabase.from("drafts").select("field_id,value").eq("site_id", sid);
        if (error) {
          console.error("ai/chat: listDrafts fehlgeschlagen:", error.message);
          return [];
        }
        return (data ?? []) as Array<{ field_id: string; value: string }>;
      },
      listImages: async (sid) => {
        const { data, error } = await supabase.storage.from("cms-media").list(`sites/${sid}`, { limit: 30 });
        if (error || !data) return [];
        return data
          .filter((f) => f.name && !f.name.startsWith("."))
          .map((f) => supabase.storage.from("cms-media").getPublicUrl(`sites/${sid}/${f.name}`).data.publicUrl);
      },
    },
    repo: {
      readFile: async (owner, repoName, filePath) =>
        (await getRepoFile(octo(), owner, repoName, filePath)).text,
      listTree: async (owner, repoName) => {
        const { data } = await octo().git.getTree({
          owner,
          repo: repoName,
          tree_sha: "main",
          recursive: "true",
        });
        return (data.tree ?? []).map((item) => item.path ?? "");
      },
    },
  });

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
      system,
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
