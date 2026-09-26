import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import type { Site } from "@/types/cms";

interface CreateSiteBody {
  name?: string;
  repoName?: string;
  repoOwner?: string;
  previewUrl?: string;
  customerEmail?: string;
}

export async function POST(request: Request) {
  try {
    // Admin-Prüfung (zentral: Session + admins-Tabelle, src/lib/auth.ts)
    const access = await requireAdmin();
    if (!access.ok) return access.error;
    const { supabaseAdmin, user } = access;

    // 3. Eingaben validieren
    let body: CreateSiteBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    const { name, repoName, repoOwner, previewUrl, customerEmail } = body;

    if (!name?.trim() || !repoName?.trim() || !repoOwner?.trim() || !previewUrl?.trim()) {
      return NextResponse.json(
        { error: "Name, Repository, Owner und Preview-URL sind Pflichtfelder." },
        { status: 400 }
      );
    }
    // Formatprüfung: Nur sichere Zeichen persistieren – freie Strings aus dem
    // Admin-Formular dürfen weder Pfad-Tricks noch Skript-URLs in die
    // Datenbank bringen (die Vorschau-URL landet später im Iframe/postMessage).
    const owner = repoOwner.trim();
    const repo = repoName.trim();
    const preview = previewUrl.trim();
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?$/.test(owner)) {
      return NextResponse.json(
        { error: "Der GitHub-Owner enthält ungültige Zeichen (erlaubt: Buchstaben, Zahlen, Bindestrich)." },
        { status: 400 }
      );
    }
    if (repo.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(repo) || repo.includes("..")) {
      return NextResponse.json(
        { error: "Der Repository-Name enthält ungültige Zeichen (erlaubt: Buchstaben, Zahlen, Punkt, Unter- und Bindestrich)." },
        { status: 400 }
      );
    }
    if (name.trim().length > 200) {
      return NextResponse.json(
        { error: "Der Website-Name ist zu lang (max. 200 Zeichen)." },
        { status: 400 }
      );
    }
    let previewUrlChecked: URL;
    try {
      previewUrlChecked = new URL(preview);
    } catch {
      return NextResponse.json(
        { error: "Die Vorschau-URL ist keine gültige URL (z. B. https://meine-website.vercel.app)." },
        { status: 400 }
      );
    }
    const isLocalhost =
      previewUrlChecked.hostname === "localhost" || previewUrlChecked.hostname === "127.0.0.1";
    if (
      (previewUrlChecked.protocol !== "https:" && !(previewUrlChecked.protocol === "http:" && isLocalhost)) ||
      !previewUrlChecked.hostname
    ) {
      return NextResponse.json(
        { error: "Die Vorschau-URL muss mit https:// beginnen (lokal ist http://localhost erlaubt)." },
        { status: 400 }
      );
    }
    if (!customerEmail?.trim()) {
      return NextResponse.json(
        { error: "Die Kunden-E-Mail fehlt." },
        { status: 400 }
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail.trim())) {
      return NextResponse.json(
        { error: "Die Kunden-E-Mail sieht ungültig aus." },
        { status: 400 }
      );
    }

    // 4. Kunden-Nutzer anlegen (oder bestehenden verwenden).
    // N5: Kein Passwort mehr – der Kunde erhält einen Einladungs-Link und
    // vergibt sein Passwort selbst. So steht nie ein Klartext-Passwort im
    // Browser, in Logs oder in der Zwischenablage.
    const email = customerEmail.trim().toLowerCase();
    let customerId: string;

    const { data: created, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
      });

    if (createError) {
      const alreadyExists =
        createError.message.toLowerCase().includes("already") ||
        createError.message.toLowerCase().includes("exist");

      if (!alreadyExists) {
        console.error("create-site: Kunden-Nutzer anlegen fehlgeschlagen:", createError.message);
        return NextResponse.json(
          { error: "Kunden-Nutzer konnte nicht angelegt werden. Details stehen im Server-Protokoll." },
          { status: 500 }
        );
      }

      // Nutzer existiert bereits -> ID per E-Mail suchen
      const { data: list, error: listError } =
        await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });

      if (listError) {
        console.error("create-site: Nutzer suchen fehlgeschlagen:", listError.message);
        return NextResponse.json(
          { error: "Bestehender Nutzer konnte nicht gesucht werden. Details stehen im Server-Protokoll." },
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

    // 4b. Einladungs-Link erzeugen (Magic-Link, läuft ab, einmaliger Einstieg)
    const { data: einladungsDaten, error: einladungsFehler } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    const inviteLink = (einladungsDaten as { properties?: { action_link?: string } } | null)?.properties?.action_link;
    if (einladungsFehler || !inviteLink) {
      console.error("create-site: Einladungs-Link fehlgeschlagen:", einladungsFehler?.message);
      return NextResponse.json(
        { error: "Nutzer wurde angelegt, aber der Einladungs-Link konnte nicht erzeugt werden. Details stehen im Server-Protokoll." },
        { status: 500 }
      );
    }

    // 5. Website anlegen (nur geprüfte Werte – siehe Formatprüfung oben)
    const { data: site, error: siteError } = await supabaseAdmin
      .from("sites")
      .insert({
        name: name.trim().slice(0, 200),
        repo_owner: owner,
        repo_name: repo,
        preview_url: previewUrlChecked.toString(),
      })
      .select()
      .single();

    if (siteError || !site) {
      console.error("create-site: Website anlegen fehlgeschlagen:", siteError?.message);
      return NextResponse.json(
        { error: "Website konnte nicht angelegt werden. Details stehen im Server-Protokoll." },
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
      console.error("create-site: Zuordnung fehlgeschlagen:", linkError.message);
      return NextResponse.json(
        {
          error: "Website wurde angelegt, aber die Zuordnung ist fehlgeschlagen. Details stehen im Server-Protokoll.",
        },
        { status: 500 }
      );
    }

    console.log(
      `Admin ${user.id} hat Website "${site.name}" (${site.id}) angelegt und Kunde ${email} verknüpft.`
    );

    return NextResponse.json({
      site: site as Site,
      einladung: { email, link: inviteLink },
    });
  } catch (err) {
    console.error("create-site fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
