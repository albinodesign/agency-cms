import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Löscht eine Website samt aller CMS-Daten (nur Agentur-Admins). */
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

    let body: { siteId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    if (!body.siteId || typeof body.siteId !== "string") {
      return NextResponse.json({ error: "siteId fehlt." }, { status: 400 });
    }

    const { data: site } = await supabaseAdmin
      .from("sites")
      .select("id,name")
      .eq("id", body.siteId)
      .maybeSingle();

    if (!site) {
      return NextResponse.json({ error: "Website nicht gefunden." }, { status: 404 });
    }

    // Zugehörige CMS-Daten (Entwürfe, Verlauf, Zuordnungen, KI-Daten) werden
    // per on-delete-cascade in der Datenbank mit gelöscht. Das GitHub-Repo
    // und der Kunden-Login bleiben bewusst bestehen.
    const { error: deleteError } = await supabaseAdmin
      .from("sites")
      .delete()
      .eq("id", body.siteId);

    if (deleteError) {
      return NextResponse.json(
        { error: `Website konnte nicht gelöscht werden: ${deleteError.message}` },
        { status: 500 }
      );
    }

    console.log(`Admin ${user.id} hat Website "${site.name}" (${site.id}) gelöscht.`);

    return NextResponse.json({
      message: `Website "${site.name}" wurde mit allen CMS-Daten gelöscht.`,
    });
  } catch (err) {
    console.error("delete-site fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
