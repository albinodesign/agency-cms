import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Site } from "@/types/cms";

interface CreateSiteBody {
  name?: string;
  repoName?: string;
  repoOwner?: string;
  previewUrl?: string;
  customerEmail?: string;
  customerPassword?: string;
}

export async function POST(request: Request) {
  try {
    // 1. Anfragenden Nutzer über die Session ermitteln
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
    }

    // 2. Admin-Check (via Service Role, umgeht RLS)
    let supabaseAdmin;
    try {
      supabaseAdmin = createAdminClient();
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Server-Konfiguration fehlt." },
        { status: 500 }
      );
    }

    const { data: adminRow, error: adminError } = await supabaseAdmin
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      return NextResponse.json(
        { error: `Admin-Prüfung fehlgeschlagen: ${adminError.message}` },
        { status: 500 }
      );
    }
    if (!adminRow) {
      return NextResponse.json(
        { error: "Keine Admin-Berechtigung." },
        { status: 403 }
      );
    }

    // 3. Eingaben validieren
    let body: CreateSiteBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    const { name, repoName, repoOwner, previewUrl, customerEmail, customerPassword } = body;

    if (!name?.trim() || !repoName?.trim() || !repoOwner?.trim() || !previewUrl?.trim()) {
      return NextResponse.json(
        { error: "Name, Repository, Owner und Preview-URL sind Pflichtfelder." },
        { status: 400 }
      );
    }
    if (!customerEmail?.trim() || !customerPassword || customerPassword.length < 8) {
      return NextResponse.json(
        { error: "Kunden-E-Mail und ein Passwort mit mindestens 8 Zeichen sind erforderlich." },
        { status: 400 }
      );
    }

    // 4. Kunden-Nutzer anlegen (oder bestehenden verwenden)
    const email = customerEmail.trim().toLowerCase();
    let customerId: string;

    const { data: created, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password: customerPassword,
        email_confirm: true,
      });

    if (createError) {
      const alreadyExists =
        createError.message.toLowerCase().includes("already") ||
        createError.message.toLowerCase().includes("exist");

      if (!alreadyExists) {
        return NextResponse.json(
          { error: `Kunden-Nutzer konnte nicht angelegt werden: ${createError.message}` },
          { status: 500 }
        );
      }

      // Nutzer existiert bereits -> ID per E-Mail suchen
      const { data: list, error: listError } =
        await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });

      if (listError) {
        return NextResponse.json(
          { error: `Bestehender Nutzer konnte nicht gesucht werden: ${listError.message}` },
          { status: 500 }
        );
      }

      const existing = list.users.find(
        (u) => u.email?.toLowerCase() === email
      );
      if (!existing) {
        return NextResponse.json(
          { error: "Nutzer existiert laut Auth, wurde aber nicht gefunden." },
          { status: 500 }
        );
      }
      customerId = existing.id;
    } else {
      customerId = created.user.id;
    }

    // 5. Website anlegen
    const { data: site, error: siteError } = await supabaseAdmin
      .from("sites")
      .insert({
        name: name.trim(),
        repo_owner: repoOwner.trim(),
        repo_name: repoName.trim(),
        preview_url: previewUrl.trim(),
      })
      .select()
      .single();

    if (siteError || !site) {
      return NextResponse.json(
        { error: `Website konnte nicht angelegt werden: ${siteError?.message ?? "Unbekannter Fehler"}` },
        { status: 500 }
      );
    }

    // 6. Verknüpfungen anlegen: Kunde UND Admin
    const { error: linkError } = await supabaseAdmin.from("user_sites").upsert(
      [
        { user_id: customerId, site_id: site.id },
        { user_id: user.id, site_id: site.id },
      ],
      { onConflict: "user_id,site_id" }
    );

    if (linkError) {
      return NextResponse.json(
        {
          error: `Website wurde angelegt, aber die Zuordnung ist fehlgeschlagen: ${linkError.message}`,
        },
        { status: 500 }
      );
    }

    console.log(
      `Admin ${user.id} hat Website "${site.name}" (${site.id}) angelegt und Kunde ${email} verknüpft.`
    );

    return NextResponse.json({
      site: site as Site,
      credentials: { email, password: customerPassword },
    });
  } catch (err) {
    console.error("create-site fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
