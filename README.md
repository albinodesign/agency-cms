# Agency CMS

Internes Kunden-CMS einer Webdesign-Agentur. Kunden können Texte und Bilder ihrer auf Vercel gehosteten Astro-Website selbst bearbeiten, ohne Code anzufassen.

**Stack:** Next.js 15 (App Router, TypeScript) · Tailwind CSS · Supabase (Auth + Datenbank, `@supabase/ssr`) · GitHub Contents API (`@octokit/rest`) · lucide-react

## Setup

1. Abhängigkeiten installieren:

   ```bash
   npm install
   ```

2. `.env.local.example` nach `.env.local` kopieren und ausfüllen:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...  # nur serverseitig, niemals committen/exponieren (Admin-Panel)
   GITHUB_TOKEN=...               # Fine-grained PAT mit Contents: Read & Write auf die Kunden-Repos
   ```

3. Dev-Server starten:

   ```bash
   npm run dev
   ```

## Supabase-Datenbankschema

```sql
create table sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text,
  preview_url text not null,       -- URL der Vercel-Vorschau (Iframe-Quelle)
  repo_owner text not null,        -- GitHub Owner
  repo_name text not null          -- GitHub Repo
);

create table user_sites (
  user_id uuid references auth.users(id) on delete cascade,
  site_id uuid references sites(id) on delete cascade,
  primary key (user_id, site_id)
);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references sites(id) on delete cascade,
  field_id text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  unique (site_id, field_id)
);

create table publish_history (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references sites(id) on delete cascade,
  published_by uuid references auth.users(id),
  commit_sha text,
  payload jsonb not null,   -- { "src/content/pages/home.json": { ...vollständiger Datei-Inhalt... } }
  created_at timestamptz not null default now()
);

create table admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
```

Row Level Security ist Pflicht. Die vollständigen Policies liegen versioniert im
Repository (`supabase/cms-rls-schema.sql`, ergänzt `supabase/ai-chat-schema.sql`)
und müssen einmalig im Supabase SQL-Editor ausgeführt werden: Nutzer sehen und
ändern nur Zeilen von Sites, für die sie in `user_sites` eingetragen sind. Die
`admins`-Tabelle ist nur über den Service-Role-Key lesbar (Admin-Check
serverseitig). Ohne diese Policies ist das CMS nicht mandantenfähig.

## Supabase Storage (Bild-Uploads)

Bilder aus `type: "image"`-Feldern werden clientseitig in den Bucket `cms-media` hochgeladen (Pfad: `sites/{siteId}/{timestamp}-{dateiname}`).

1. Die Policies aus `supabase/cms-rls-schema.sql` ausführen (legt Bucket +
   Regeln an). Lesen bleibt öffentlich (Bilder sind Website-Inhalte und müssen
   auch ohne Login ladbar sein). Schreiben (hochladen/ersetzen/löschen) geht
   nur authentifiziert und nur im eigenen Ordner `sites/{eigeneSiteId}/...` –
   fremde Site-Ordner werden von der Datenbank abgewiesen. Pfade außerhalb von
   `sites/{uuid}/` werden grundsätzlich abgelehnt.

## CMS-Manifest (im Kunden-Repo)

Der Editor rendert seine Felder aus `src/content/cms.manifest.json` im Website-Repo:

```json
{
  "sections": [
    {
      "id": "hero",
      "title": "Hero-Bereich",
      "fields": [
        {
          "id": "hero.title",
          "label": "Titel",
          "type": "text",
          "file": "src/content/pages/home.json",
          "path": "hero.title"
        },
        {
          "id": "hero.image",
          "label": "Hintergrundbild",
          "type": "image",
          "file": "src/content/pages/home.json",
          "path": "hero.image"
        }
      ]
    }
  ]
}
```

- `type`: `"text"` → einzeiliges Input, `"textarea"` → mehrzeilig, `"image"` → Bild-URL-Input mit Vorschau
- `file`: Zieldatei im Repo (wird beim Veröffentlichen per GitHub API aktualisiert)
- `path`: Dot-Path innerhalb der JSON-Datei
- `maxLength` (optional): Zeichenbegrenzung inkl. Zähler im Editor

## Blog-Engine

Wenn das Manifest das Blog-Feature aktiviert, erscheint im Editor ein zweiter Tab „Blog-Artikel":

```json
{
  "features": { "blog": true },
  "sections": [ ... ]
}
```

Artikel werden als Markdown-Dateien mit Frontmatter in `src/content/blog/` des Website-Repos verwaltet (API: `GET`/`POST`/`DELETE /api/blog`, Commits: `cms: save blog post [slug]` / `cms: delete blog post [slug]`). Das Frontmatter enthält `title`, `slug`, `date`, `coverImage`, `excerpt` und `draft`.

## KI-Chat (OpenRouter)

Kunden mit Freischaltung sehen im Editor einen **KI-Chat**-Knopf. Die KI bereitet
Inhalts- und Design-Änderungen als Entwürfe vor – live geht es erst per
Veröffentlichen-Knopf (mit Prüfung). Die KI committet niemals selbst.

Setup in 3 Schritten:

1. **Datenbank:** `supabase/ai-chat-schema.sql` einmalig im Supabase SQL-Editor
   ausführen (Schalter-Spalte, Gespräche, Code-Entwürfe, Kosten-Zähler inkl. Regeln).
2. **Schlüssel:** `OPENROUTER_API_KEY` vom OpenRouter-Dashboard (https://openrouter.ai/keys)
   in `.env.local` (lokal) und in Vercel → Settings → Environment Variables (live) eintragen.
   Modell wechseln = nur die Zeile `AI_MODEL` ändern (exakte ID aus OpenRouter, z. B. `meta/muse-spark-1.3-contributor`).
3. **Freischalten:** Im Dashboard pro Website-Karte den **KI-Chat**-Schalter umlegen (nur Admins).

Sicherheitsregeln der KI (in `src/lib/ai.ts`): Die KI darf im gesamten Website-Repo
arbeiten. Tabu bleiben nur `.env`-Dateien, Schlüssel/Passwörter und das Entfernen der
CMS-Vorschau-Brücke. Jede Veröffentlichung sichert Inhalte UND Code – der Verlauf stellt alles wieder her.

## Live-Vorschau auf der Astro-Website

Damit Eingaben sofort im Iframe sichtbar werden UND Klicks auf der Website
zum passenden Feld im CMS springen ("Finden"-Modus), muss die Website diese
Brücke im `<head>` des Hauptlayouts einbinden. Sie läuft nur im CMS-Iframe,
nie auf der echten Live-Seite (`window.self !== window.top`):

```html
<script is:inline>
  if (window.self !== window.top) {
    // Erlaubte CMS-Herkünfte – die Agentur trägt hier pro Projekt ein:
    // 1) die Live-CMS-Domain, 2) lokal zum Testen (sonst nichts!).
    const CMS_ORIGINS = ["https://cms.deine-agentur.de", "http://localhost:3000"];

    // true = Klick sucht das Feld im CMS ("Finden"), false = normale Links ("Surfen")
    let selectMode = true;

    // Richtung 1: CMS -> Website (Live-Vorschau beim Tippen).
    // Nur Nachrichten aus der erlaubten CMS-Herkunft annehmen – niemals
    // ohne Origin-Check (sonst könnte jede fremde Seite Texte/Bilder
    // in der Vorschau umschreiben).
    window.addEventListener("message", (event) => {
      if (!CMS_ORIGINS.includes(event.origin)) return;
      if (event.source !== window.parent) return;
      if (event.data?.type === "CMS_SELECT_MODE") {
        selectMode = event.data.enabled !== false;
        return;
      }
      if (event.data?.type !== "CMS_FIELD_UPDATE") return;
      if (typeof event.data.field !== "string" || typeof event.data.value !== "string") return;
      if (/[<>"'`]/.test(event.data.field)) return;
      // CSS.escape schützt den Selektor vor Feld-IDs mit Sonderzeichen.
      document.querySelectorAll(`[data-cms-field="${CSS.escape(event.data.field)}"]`).forEach((el) => {
        if (el.tagName === "IMG") {
          el.src = event.data.value;
          el.removeAttribute("srcset");
        } else if (el.tagName === "SOURCE") {
          el.srcset = event.data.value;
        } else {
          el.textContent = event.data.value;
        }
      });
    });

    // Richtung 2: Website -> CMS (Klick auf Text meldet das Feld).
    // Es werden nur Feld-IDs (z. B. "hero.title") geschickt, keine Inhalte.
    // Als Ziel die Herkunft der einbettenden Seite aus document.referrer
    // ableiten – niemals "*" (sonst leaken Feld-IDs an beliebige Parents,
    // falls die Seite fremd eingebettet wird).
    function cmsTargetOrigin() {
      try {
        const ref = new URL(document.referrer);
        if (CMS_ORIGINS.includes(ref.origin)) return ref.origin;
      } catch {
        /* kein Referrer – nichts senden */
      }
      return null;
    }
    document.addEventListener(
      "click",
      (event) => {
        if (!selectMode) return;
        const el = event.target.closest("[data-cms-field]");
        if (!el) return;
        const target = cmsTargetOrigin();
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        document
          .querySelectorAll(".cms-selected")
          .forEach((n) => n.classList.remove("cms-selected"));
        el.classList.add("cms-selected");
        window.parent.postMessage(
          { type: "CMS_FIELD_SELECT", field: el.getAttribute("data-cms-field") },
          target
        );
      },
      true
    );

    // Blauer Rahmen beim Drüberfahren, damit Kunden sehen was klickbar ist
    const style = document.createElement("style");
    style.textContent = `
      [data-cms-field]:hover { outline: 2px solid #2563eb; outline-offset: 2px; cursor: pointer; }
      .cms-selected { outline: 2px solid #2563eb !important; outline-offset: 2px; }
    `;
    document.head.appendChild(style);
  }
</script>
```

Voraussetzung: Jedes editierbare Element trägt `data-cms-field="[feld-id]"`
(genau die ID aus dem Manifest), jede Sektion `data-cms-section="[sektion-id]"`.
Beide Seiten prüfen Herkunft UND Quelle: Die Website nimmt nur Nachrichten aus
`CMS_ORIGINS` vom einbettenden Parent an, das CMS nur Nachrichten aus der
hinterlegten Vorschau-Adresse vom eingebetteten Iframe (bei ungültiger Adresse
ist der Empfang deaktiviert). `postMessage("*")` wird nirgends verwendet.

## Publish-Flow

`POST /api/publish` (sessiongeschützt) liest alle Entwürfe einer Site, gruppiert sie nach Zieldatei, aktualisiert die JSON-Dateien über die GitHub Contents API und committet mit `cms: update content by client` auf `main`. Danach wird ein Snapshot in `publish_history` gespeichert und die publizierten Entwürfe aus `drafts` gelöscht. Vercel deployed den Push automatisch.
