import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";

/** Schaltet den KI-Chat einer Website an/aus (nur Agentur-Admins). */
export async function POST(request: Request) {
  try {
    // Admin-Prüfung (zentral: Session + admins-Tabelle, src/lib/auth.ts)
    const access = await requireAdmin();
    if (!access.ok) return access.error;
    const { supabaseAdmin } = access;

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
      console.error("toggle-ai fehlgeschlagen:", error.message);
      return NextResponse.json(
        { error: "Schalter konnte nicht umgelegt werden. Details stehen im Server-Protokoll." },
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
