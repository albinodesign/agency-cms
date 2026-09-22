import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Schaltet den KI-Chat einer Website an/aus (nur Agentur-Admins). */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
    }

    let supabaseAdmin;
    try {
      supabaseAdmin = createAdminClient();
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Server-Konfiguration fehlt." },
        { status: 500 }
      );
    }

    const { data: adminRow } = await supabaseAdmin
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!adminRow) {
      return NextResponse.json({ error: "Keine Admin-Berechtigung." }, { status: 403 });
    }

    let body: { siteId?: string; enabled?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    if (!body.siteId || typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "siteId und enabled fehlen." }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("sites")
      .update({ ai_enabled: body.enabled })
      .eq("id", body.siteId);

    if (error) {
      return NextResponse.json(
        { error: `Schalter konnte nicht umgelegt werden: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: body.enabled
        ? "KI-Chat wurde für diese Website freigeschaltet."
        : "KI-Chat wurde für diese Website ausgeschaltet.",
      enabled: body.enabled,
    });
  } catch (err) {
    console.error("toggle-ai fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
