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
   OPENROUTER_API_KEY=...         # nur für den KI-Chat (https://openrouter.ai/keys)
   AI_MODEL=...                   # exakte Modell-ID aus OpenRouter, z. B. meta/muse-spark-1.3-contributor
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
  created_at timestamptz not null default now(),
  note text,                -- z. B. "Rollback" (Spalte ggf. nachrüsten)
  files text[] not null default '{}'  -- Dateiliste für schlankes Laden (Nachrüst-Skript beachten)
);

create table admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- Erweitert um: sites.ai_enabled (KI-Chat-Schalter), code_drafts,
-- ai_conversations/ai_messages/ai_usage (siehe supabase/ai-chat-schema.sql).
-- Hinweis: sites.domain existiert je nach Stand ggf. nicht (optional).
```

Ausführ-Reihenfolge im Supabase SQL-Editor:

1. Tabellen oben anlegen (falls noch nicht vorhanden).
2. `supabase/ai-chat-schema.sql` (KI-Tabellen + deren Policies).
3. `supabase/cms-rls-schema.sql` (Mandanten-Trennung + Storage-Regeln – Pflicht für mehrere Kunden).
4. `supabase/cms-history-files-migration.sql` (files-Spalte für schnellen Verlauf inkl. Nachpflege).

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

- `type`: `"text"` → einzeilig, `"textarea"` → mehrzeilig, `"image"` → Bild-Upload mit Vorschau, `"number"` → Zahl, `"email"`, `"phone"`, `"url"`, `"date"` (JJJJ-MM-TT), `"boolean"` → An/Aus-Schalter. Unbekannte Typen werden als `"text"` gedeutet und im Editor als Hinweis angezeigt.
- `file`: Zieldatei im Repo (wird beim Veröffentlichen per GitHub API aktualisiert; erlaubt: `src/content/site.json` und JSON-Dateien unter `src/content/pages/`)
- `path`: Dot-Path innerhalb der JSON-Datei
- `maxLength` (optional): Zeichenbegrenzung inkl. Zähler im Editor (Überlänge wird live rot markiert, Publish hält die Datei zurück)
- `placeholder` (optional): Beispieltext im leeren Feld

**Dynamische Listen** (optional, `listenmodelle` auf oberster Manifest-Ebene):
Nur ausdrücklich modellierte Listen dürfen per Entwurf am Ende wachsen –
alle anderen Listen sind fest. Beispiel (Referenzen-Seite mit Titel + Sternen):

```json
{
  "sections": [ ... ],
  "listenmodelle": [
    {
      "datei": "src/content/pages/referenzen.json",
      "pfad": "items",
      "felder": { "titel": "text", "text": "text", "sterne": "number" }
    }
  ]
}
```

Regeln: `datei` wie bei Feldern (nur `site.json`/`pages/*.json`), `pfad` als
Punkt-Pfad ohne Index, 1–20 Felder mit gültigen Typen. Neue Elemente brauchen
alle Felder typgerecht und keine fremden Schlüssel. Fehlerhafte Modelle lehnt
das Veröffentlichen als Ganzes ab (Entwürfe bleiben). Eingebaut ist immer das
FAQ-Modell (`faq.json`, `items` mit `frage` + `antwort`).

## Blog-Engine

Wenn das Manifest das Blog-Feature aktiviert, erscheint im Editor ein zweiter Tab „Blog-Artikel":

```json
{
  "features": { "blog": true },
  "sections": [ ... ]
}
```

Artikel werden als Markdown-Dateien mit Frontmatter in `src/content/blog/` des Website-Repos verwaltet (API: `GET`/`POST`/`DELETE /api/blog`, Commits: `cms: save blog post [slug]` / `cms: delete blog post [slug]`). Das Frontmatter enthält `title`, `slug`, `date`, `coverImage`, `coverImageAlt` (fällt auf den Titel zurück), `excerpt` und `draft`. Grenzen: Titel max. 200, Excerpt max. 500, Alt-Text max. 200, Inhalt max. 100.000 Zeichen; Cover nur http(s) oder interner `/`-Pfad. Bei Versionskonflikt wird einmal mit frischem Stand neu versucht.

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

## Betrieb: CI, Verlauf, Backup

- **CI:** Bei jedem Push/PR läuft `.github/workflows/ci.yml` (Lint + Build + alle Tests). Ohne grünes CI nichts mergen.
- **Verlauf:** Pro Website werden die neuesten 50 Versionen aufgehoben (ältere löscht das System nach Publish/Rollback automatisch). Der Verlauf lädt nur Metadaten; Inhalte kommen erst beim Zurückrollen.
- **Backup:** Der Knopf „Meine Website (.zip)" lädt eine **reine Download-Kopie** herunter (Mitnahme, kein Lock-in). Zurückgespielt wird daraus nichts – ältere Stände stellt der **Verlauf** wieder her.

## Publish-Flow

`POST /api/publish` (session- und zugriffsgeschützt) liest alle Entwürfe einer Site, baut den Kandidaten (Live + Voll-Datei-Entwürfe + Feldänderungen) und prüft ihn **je angefasster Datei** (Teilveröffentlichung statt Alles-oder-nichts): Jede saubere Datei wird einzeln auf `main` committet (`cms: update content by client`, bei Versionskonflikt einmal mit frischem Stand neu versucht), blockierte Dateien bleiben als Entwurf erhalten und werden je Datei mit Grund in `blocked` genannt (fehlgeschlagene Commits in `failed`, `partial: true` bei Teil-Erfolg). Die Antwort nennt `publishedFieldIds`, damit der Editor genau diese Felder als live markiert. Danach Snapshot in `publish_history` (nur Veröffentlichtes, plus Dateiliste) und Löschen nur committeter Entwürfe. Rein fehlerhafte Sätze: 400 ohne Writes. Vercel deployed den Push automatisch; der Editor zeigt danach den echten Aufbau-Status (GitHub-Check, alle 10 s, max. 3 Min.).
