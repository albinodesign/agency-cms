import { NextResponse } from "next/server";
import { requireSiteAccess } from "@/lib/auth";

/** Liefert das letzte Gespräch einer Website mit Nachrichten (zum Fortsetzen). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const siteId = searchParams.get("siteId");

  // Zugriff prüfen (zentral: Session + user_sites + Site, src/lib/auth.ts)
  const access = await requireSiteAccess(siteId);
  if (!access.ok) return access.error;
  const { supabase, site } = access;
  const verifiedSiteId = site.id;

  const { data: conv } = await supabase
    .from("ai_conversations")
    .select("id,title,updated_at")
    .eq("site_id", verifiedSiteId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conv) {
    return NextResponse.json({ conversation: null, messages: [] });
  }

  const { data: rows } = await supabase
    .from("ai_messages")
    .select("role,content,created_at")
    .eq("conversation_id", (conv as { id: string }).id)
    .order("created_at", { ascending: true })
    .limit(40);

  const messages = ((rows ?? []) as Array<{ role: string; content: { text?: string; dateien?: Array<{ name?: string; url?: string; mediaType?: string }> } | null }>)
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      role: r.role,
      text: typeof r.content?.text === "string" ? r.content.text : "",
      dateien: Array.isArray(r.content?.dateien) ? r.content.dateien : [],
    }))
    .filter((m) => m.text !== "" || m.dateien.length > 0);

  return NextResponse.json({ conversation: conv, messages });
}
