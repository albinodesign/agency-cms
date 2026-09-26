import { NextResponse } from "next/server";
import { requireSiteAccess } from "@/lib/auth";

/** Liefert das letzte Gespräch einer Website mit Nachrichten (zum Fortsetzen). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const siteId = searchParams.get("siteId");

  // Zugriff prüfen (zentral: Session + user_sites + Site, src/lib/auth.ts)
  const access = await requireSiteAccess(siteId);
  if (!access.ok) return access.error;
  const { supabase, user, site } = access;
  const verifiedSiteId = site.id;

  // W10: Nur eigene Gespräche (plus alte ohne Ersteller) – fremde
  // Gespräche derselben Site bleiben unsichtbar.
  // W12: DB-Fehler nicht still als „kein Verlauf" werten.
  const { data: conv, error: convError } = await supabase
    .from("ai_conversations")
    .select("id,title,updated_at,created_by")
    .eq("site_id", verifiedSiteId)
    .or(`created_by.eq.${user.id},created_by.is.null`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (convError) {
    console.error("ai/history: Gespräche laden fehlgeschlagen:", convError.message);
    return NextResponse.json(
      { error: "Verlauf konnte nicht geladen werden. Details stehen im Server-Protokoll." },
      { status: 500 }
    );
  }

  if (!conv) {
    return NextResponse.json({ conversation: null, messages: [] });
  }
  const conversation = conv as { id: string; title: string; updated_at: string };

  // W12: DB-Fehler nicht still als „kein Verlauf" werten.
  const { data: rows, error: rowsError } = await supabase
    .from("ai_messages")
    .select("role,content,created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true })
    .limit(40);
  if (rowsError) {
    console.error("ai/history: Nachrichten laden fehlgeschlagen:", rowsError.message);
    return NextResponse.json(
      { error: "Verlauf konnte nicht geladen werden. Details stehen im Server-Protokoll." },
      { status: 500 }
    );
  }

  const messages = ((rows ?? []) as Array<{ role: string; content: { text?: string; dateien?: Array<{ name?: string; url?: string; mediaType?: string }> } | null }>)
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      role: r.role,
      text: typeof r.content?.text === "string" ? r.content.text : "",
      dateien: Array.isArray(r.content?.dateien) ? r.content.dateien : [],
    }))
    .filter((m) => m.text !== "" || m.dateien.length > 0);

  return NextResponse.json({ conversation, messages });
}
