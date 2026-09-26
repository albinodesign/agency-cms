import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Site } from "@/types/cms";
import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Zentrale Zugriffsprüfung für alle API-Routen (W4).
 *
 * Muster: Session prüfen, dann Mitgliedschaft in user_sites, dann Site laden.
 * Jede neue API-Route nutzt diese Funktion, damit keine Route versehentlich
 * ohne Prüfung entsteht. Meldungen/Statuscodes sind überall identisch.
 */
export type SiteAccess =
  | { ok: true; supabase: SupabaseClient; user: User; site: Site }
  | { ok: false; error: NextResponse };

export async function requireSiteAccess(siteId: string | null | undefined): Promise<SiteAccess> {
  if (!siteId || typeof siteId !== "string") {
    return { ok: false, error: NextResponse.json({ error: "siteId fehlt." }, { status: 400 }) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 }) };
  }

  const { data: assignment } = await supabase
    .from("user_sites")
    .select("site_id")
    .eq("user_id", user.id)
    .eq("site_id", siteId)
    .maybeSingle();

  if (!assignment) {
    return {
      ok: false,
      error: NextResponse.json({ error: "Kein Zugriff auf diese Website." }, { status: 403 }),
    };
  }

  const { data: site, error: siteError } = await supabase
    .from("sites")
    .select("*")
    .eq("id", siteId)
    .single();

  if (siteError || !site) {
    return {
      ok: false,
      error: NextResponse.json({ error: "Website nicht gefunden." }, { status: 404 }),
    };
  }

  return { ok: true, supabase, user, site: site as Site };
}

/**
 * Zentrale Admin-Prüfung für src/app/api/admin/* (W4).
 * Der Service-Role-Client umgeht RLS bewusst und entsteht erst NACH
 * erfolgreicher Session- und Admin-Prüfung – niemals im Browser.
 */
export type AdminAccess =
  | { ok: true; supabase: SupabaseClient; supabaseAdmin: SupabaseClient; user: User }
  | { ok: false; error: NextResponse };

export async function requireAdmin(): Promise<AdminAccess> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 }) };
  }

  let supabaseAdmin: SupabaseClient;
  try {
    supabaseAdmin = createAdminClient();
  } catch (err) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: err instanceof Error ? err.message : "Server-Konfiguration fehlt." },
        { status: 500 }
      ),
    };
  }

  const { data: adminRow, error: adminError } = await supabaseAdmin
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: `Admin-Prüfung fehlgeschlagen: ${adminError.message}` },
        { status: 500 }
      ),
    };
  }
  if (!adminRow) {
    return {
      ok: false,
      error: NextResponse.json({ error: "Keine Admin-Berechtigung." }, { status: 403 }),
    };
  }

  return { ok: true, supabase, supabaseAdmin, user };
}
