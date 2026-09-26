import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";

/** Löscht eine Website samt aller CMS-Daten (nur Agentur-Admins). */
export async function POST(request: Request) {
  try {
    // Admin-Prüfung (zentral: Session + admins-Tabelle, src/lib/auth.ts).
    // Hinweis: DB-Fehler bei der Prüfung geben jetzt 500 statt 403,
    // damit Konfigurationsfehler nicht als „kein Admin" getarnt sind.
    const access = await requireAdmin();
    if (!access.ok) return access.error;
    const { supabaseAdmin, user } = access;

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
