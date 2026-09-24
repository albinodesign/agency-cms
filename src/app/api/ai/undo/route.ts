import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Macht eine KI-Antwort rückgängig: Löscht die von ihr erzeugten (noch
 * unveröffentlichten) Entwürfe und danach die Nachricht selbst.
 * Bereits Veröffentlichtes bleibt live (dafür gibt es Verlauf/Rollback).
 */
export async function POST(request: Request) {
  try {
    let body: { messageId?: string; conversationId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }
    const byId = typeof body.messageId === "string" && body.messageId !== "";
    const byConv = !byId && typeof body.conversationId === "string" && body.conversationId !== "";
    if (!byId && !byConv) {
      return NextResponse.json({ error: "messageId oder conversationId fehlt." }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
    }

    // Zielnachricht bestimmen: direkt per ID oder die neueste Antwort mit
    // Entwürfen im Gespräch (für frische Nachrichten ohne bekannte ID).
    let message: { id: string; conversation_id: string; role: string; content: unknown } | null = null;
    if (byId) {
      const { data } = await supabase
        .from("ai_messages")
        .select("id,conversation_id,role,content")
        .eq("id", body.messageId as string)
        .maybeSingle();
      message = data;
    } else {
      const { data } = await supabase
        .from("ai_messages")
        .select("id,conversation_id,role,content")
        .eq("conversation_id", body.conversationId as string)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(10);
      const rows = (data ?? []) as Array<{ id: string; conversation_id: string; role: string; content: unknown }>;
      message =
        rows.find((r) => {
          const c = (r.content ?? {}) as { entwuerfe?: unknown; codeEntwuerfe?: unknown };
          return (
            (Array.isArray(c.entwuerfe) && c.entwuerfe.length > 0) ||
            (Array.isArray(c.codeEntwuerfe) && c.codeEntwuerfe.length > 0)
          );
        }) ?? null;
    }

    if (!message || message.role !== "assistant") {
      return NextResponse.json({ error: "Nachricht nicht gefunden." }, { status: 404 });
    }

    const { data: conversation } = await supabase
      .from("ai_conversations")
      .select("id,site_id")
      .eq("id", message.conversation_id)
      .maybeSingle();

    if (!conversation) {
      return NextResponse.json({ error: "Gespräch nicht gefunden." }, { status: 404 });
    }

    const { data: assignment } = await supabase
      .from("user_sites")
      .select("site_id")
      .eq("user_id", user.id)
      .eq("site_id", conversation.site_id)
      .maybeSingle();

    if (!assignment) {
      return NextResponse.json({ error: "Kein Zugriff auf diese Website." }, { status: 403 });
    }

    const siteId = conversation.site_id as string;
    const content = (message.content ?? {}) as {
      entwuerfe?: unknown;
      codeEntwuerfe?: unknown;
    };
    const draftIds = Array.isArray(content.entwuerfe)
      ? content.entwuerfe.filter((v): v is string => typeof v === "string")
      : [];
    const codePaths = Array.isArray(content.codeEntwuerfe)
      ? content.codeEntwuerfe.filter((v): v is string => typeof v === "string")
      : [];

    // Noch vorhandene Entwürfe ermitteln (Rest ist bereits veröffentlicht
    // oder anderweitig verschwunden und kann nicht rückgängig gemacht werden).
    let existingDrafts: string[] = [];
    if (draftIds.length > 0) {
      const { data } = await supabase
        .from("drafts")
        .select("field_id")
        .eq("site_id", siteId)
        .in("field_id", draftIds);
      existingDrafts = ((data ?? []) as Array<{ field_id: string }>).map((r) => r.field_id);
    }
    let existingCode: string[] = [];
    if (codePaths.length > 0) {
      const { data } = await supabase
        .from("code_drafts")
        .select("file_path")
        .eq("site_id", siteId)
        .in("file_path", codePaths);
      existingCode = ((data ?? []) as Array<{ file_path: string }>).map((r) => r.file_path);
    }

    if (existingDrafts.length > 0) {
      const { error } = await supabase
        .from("drafts")
        .delete()
        .eq("site_id", siteId)
        .in("field_id", existingDrafts);
      if (error) {
        return NextResponse.json(
          { error: `Entwürfe konnten nicht gelöscht werden: ${error.message}` },
          { status: 500 }
        );
      }
    }
    if (existingCode.length > 0) {
      const { error } = await supabase
        .from("code_drafts")
        .delete()
        .eq("site_id", siteId)
        .in("file_path", existingCode);
      if (error) {
        return NextResponse.json(
          { error: `Code-Entwürfe konnten nicht gelöscht werden: ${error.message}` },
          { status: 500 }
        );
      }
    }

    const { error: msgError } = await supabase
      .from("ai_messages")
      .delete()
      .eq("id", message.id);

    if (msgError) {
      return NextResponse.json(
        { error: `Nachricht konnte nicht gelöscht werden: ${msgError.message}` },
        { status: 500 }
      );
    }

    const geloeschteEntwuerfe = existingDrafts.length + existingCode.length;
    const bereitsLive = draftIds.length + codePaths.length - geloeschteEntwuerfe;

    let message_text =
      geloeschteEntwuerfe > 0
        ? `${geloeschteEntwuerfe} Entwurf${geloeschteEntwuerfe === 1 ? "" : "e"} rückgängig gemacht.`
        : "Keine unveröffentlichten Entwürfe mehr vorhanden.";
    if (geloeschteEntwuerfe > 0 && bereitsLive > 0) {
      message_text += ` ${bereitsLive} Änderung${bereitsLive === 1 ? " war" : "en waren"} bereits veröffentlicht und bleibt${bereitsLive === 1 ? "" : "en"} live (siehe Verlauf).`;
    }

    return NextResponse.json({
      message: message_text,
      geloeschteEntwuerfe,
      bereitsLive,
    });
  } catch (err) {
    console.error("ai/undo fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
