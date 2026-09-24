# AGENTS.md

## Projektübersicht

**Agency CMS** ist das interne Kunden-CMS einer Webdesign-Agentur. Kunden können damit Texte und Bilder ihrer auf Vercel gehosteten Astro-Website selbst bearbeiten, ohne Code anzufassen. Änderungen werden zunächst als Entwürfe in Supabase gespeichert und beim Veröffentlichen per GitHub Contents API als Commit in das Website-Repository geschrieben; Vercel deployed den Push anschließend automatisch.

**Stack:** Next.js 15 (App Router, TypeScript, React 19) · Tailwind CSS 4 (via `@tailwindcss/postcss`) · Supabase (Auth + Postgres + Storage, via `@supabase/ssr`) · GitHub Contents API (`@octokit/rest`) · `gray-matter` (Blog-Frontmatter) · `lucide-react` (Icons)

**Sprache:** Die gesamte Codebasis (Kommentare, Fehlermeldungen, UI-Texte, README) ist auf Deutsch verfasst. Neue Kommentare und nutzerseitige Texte ebenfalls auf Deutsch schreiben.

## Build- und Entwicklungsbefehle

```bash
npm install        # Abhängigkeiten installieren
npm run dev        # Dev-Server starten
npm run build      # Produktions-Build
npm start          # Produktions-Server
npm run lint       # ESLint (eslint-config-next, core-web-vitals + typescript)
```

Es gibt **keine Tests und kein Test-Framework** im Projekt. Qualitätssicherung erfolgt über `npm run lint` und `npm run build` (TypeScript `strict` ist aktiviert). Beide Befehle müssen nach einer Änderung fehlerfrei durchlaufen.

## Umgebungsvariablen

In `.env.local` (Vorlage: `.env.local.example`, die erforderlichen Werte stehen auch in der `README.md`):

- `NEXT_PUBLIC_SUPABASE_URL` – Supabase-Projekt-URL (ohne API-Pfade wie `/rest/v1`; `src/lib/supabase/config.ts` normalisiert diese, inkl. Entfernung angehängter `/rest|auth|storage|realtime/v1`-Pfade)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` – öffentlicher Anon-Key
- `SUPABASE_SERVICE_ROLE_KEY` – **nur serverseitig**, umgeht RLS komplett (Admin-Client in `src/lib/supabase/admin.ts`, nur in `src/app/api/admin/` verwenden)
- `GITHUB_TOKEN` – Fine-grained PAT mit `Contents: Read & Write` auf die Kunden-Repos

## Architektur

### Datenfluss (Publish-Flow)

1. Der Editor (`/editor/[siteId]`, Server Component in `src/app/editor/[siteId]/page.tsx`, mit `export const dynamic = "force-dynamic"`) lädt serverseitig das CMS-Manifest und die referenzierten Content-Dateien per GitHub API aus dem Website-Repo (strikt nur `.json`-Dateien, niemals Markdown) sowie die Entwürfe aus Supabase; Entwürfe überschreiben Live-Werte.
2. Eingaben im Editor (`src/components/editor/EditorClient.tsx`) werden clientseitig mit 800-ms-Debounce pro Feld direkt per Supabase-Client in die Tabelle `drafts` geupsertet (`onConflict: "site_id,field_id"`, RLS-geschützt, kein eigener API-Route dafür) und sofort per `postMessage` (`{ type: "CMS_FIELD_UPDATE", field, value }`) an die Vorschau-Iframe geschickt – als targetOrigin wird der konkrete Origin von `site.preview_url` verwendet (nie `"*"`).
3. `POST /api/publish` lädt Live-Manifest und Entwürfe vom Server (`getManifestRaw`; ein Manifest-Entwurf im Satz ersetzt die Live-Definition), baut daraus den vollständigen Kandidaten (Live + Voll-Datei-Entwürfe + alle Feldänderungen mit einheitlicher Typ-Auflösung) und prüft erst DIESEN streng (`src/lib/content-guard.ts` + Batch-Regeln): effektives Manifest (IDs, Typen, Duplikate, erlaubte Dateien `src/content/site.json` + `src/content/pages/*.json`, sämtliche Feldziele im neuen Stand), Werte je deklariertem Typ (Aliase erben Typ/Länge), Banner-Dreifaltigkeit, Listen-Vollständigkeit (neue Elemente brauchen alle Pflichtschlüssel der Geschwister in typgerechter Form, keine fremden Schlüssel). Sichere Pfade (`src/lib/json-path.ts`). Commits mit `cms: update content by client` auf `main`, Snapshot in `publish_history`, danach Löschen nur exakt publizierter Entwurfs-IDs plus wertgeprüftes Aufräumen gleichwertiger Aliase. Jeder Fehler bricht den Satz mit 400 ab (Fail-Closed, keine Teilspeicherung, Entwürfe bleiben); Unbekanntes bleibt Entwurf und wird offengelegt.
4. `POST /api/rollback` stellt eine frühere Version wieder her – ausschließlich über `historyId` (Payload wird serverseitig aus `publish_history` geladen; ein mitgeschickter `body.payload` wird nicht akzeptiert). Die Dateipfade im Payload sind gewhitelistet: Nur `.json`-Dateien unter `src/content/` dürfen überschrieben werden (Commit `cms: rollback to historical version`). Danach werden **alle** offenen Entwürfe der Site gelöscht und der Rollback als neuer Verlaufseintrag dokumentiert (mit `note: "Rollback"`, Fallback ohne `note`-Spalte).

### CMS-Manifest

Der Editor rendert seine Felder aus `src/content/cms.manifest.json` im jeweiligen Website-Repo. Felder haben `id`, `label`, `type` (`text` | `textarea` | `image` | `number` | `email` | `phone` | `url` | `date` | `boolean`), `file` (nur `src/content/site.json` oder `src/content/pages/*.json` als normales Inhaltsziel) und `path` (sicherer Pfad, inkl. Listen-Schreibweisen `items[0].x`/`items.0.x`), optional `placeholder` und `maxLength`. `features.blog: true` (oder `{ blog: { enabled: true } }`) aktiviert den Blog-Tab. `normalizeManifest` in `src/lib/github.ts` akzeptiert toleranterweise mehrere Formate (Array von Sektionen/Feldern, `{ sections }`, `{ fields }`); Sektionen ohne gültige Felder fallen weg. Toleranzen im Detail: Sektions-ID `id || section || section-N`, Sektions-Titel `label || title || sectionLabel || id || section || Sektion N`, Feld-Label `label || title || id`; Felder mit unbekanntem `type` werden als `text` übernommen statt verworfen, Pflichtangaben ohne `id`/`file`/`path` werden herausgefiltert.

Im Editor gruppiert `detectPageLabel` (`src/components/editor/EditorClient.tsx`) die Sektionen per Schlüsselwort-Heuristik (ID/Titel, sonst Dateiname im `file`-Pfad) zu Seiten-Tabs (z. B. Startseite, Leistungen, Kontakt, Firmendaten); innerhalb einer Seite bleiben die Sektionen Akkordeons, die Suche durchsucht seitenübergreifend alle Felder. Nach dem Veröffentlichen zeigt der Editor 45 s lang eine blaue Deployment-Box mit Fortschrittsbalken und lädt danach die Vorschau automatisch neu.

### Blog-Engine

`GET`/`POST`/`DELETE /api/blog` verwaltet Markdown-Dateien mit Frontmatter (`title`, `slug`, `date`, `coverImage`, `coverImageAlt`, `excerpt`, `draft`) in `src/content/blog/` des Website-Repos (Commits: `cms: save/delete blog post [slug]`). `coverImageAlt` ist optional und fällt serverseitig auf den Titel zurück. Slugs werden mit `src/lib/slugify.ts` erzeugt (inkl. Umlaut-Umwandlung ä→ae usw., max. 80 Zeichen). Alle Pfad-Parameter (GET `path`, DELETE `path`, POST-Zieldatei) werden strikt gegen das Regex `/^src\/content\/blog\/[a-z0-9-]+\.md$/` geprüft; Pfade mit `..` oder anderen Zeichen werden mit 400 abgelehnt.

### Code-Organisation

```
src/
├── middleware.ts            # Next.js Middleware: Session-Schutz für /dashboard/** und /editor/**
├── app/
│   ├── page.tsx             # Startseite
│   ├── login/               # Login (Supabase Auth)
│   ├── dashboard/           # Übersicht der dem Nutzer zugeordneten Websites
│   ├── editor/[siteId]/     # Editor (Server Component lädt Daten, Client rendert; loading.tsx)
│   ├── globals.css          # Tailwind-Styles
│   └── api/
│       ├── publish/         # Entwürfe -> GitHub-Commits + publish_history
│       ├── rollback/        # Wiederherstellung aus publish_history
│       ├── blog/            # Blog-Artikel CRUD (Markdown im Repo)
│       └── admin/create-site/  # Site + Kunden-Nutzer anlegen (nur Admins, Service Role)
├── components/
│   ├── editor/              # EditorClient, ImageField, HistoryDrawer, BlogPanel, BlogEditorModal
│   ├── DashboardClient.tsx, CreateSiteModal.tsx, LogoutButton.tsx
├── lib/
│   ├── github.ts            # Octokit-Factory, Manifest laden/normalisieren, Repo-Dateien lesen (Base64 → UTF-8)
│   ├── json-path.ts         # getByPath/setByPath (Dot-Paths, setByPath legt fehlende Ebenen an)
│   ├── slugify.ts           # Slug-Erzeugung für Blog-Artikel
│   └── supabase/            # server.ts, client.ts, middleware.ts, admin.ts, config.ts
└── types/cms.ts             # Zentrale Typen (Manifest, Blog, Site, Draft, PublishHistoryEntry, DraftMap)
```

Path-Alias: `@/*` → `src/*` (in `tsconfig.json`).

### Supabase-Datenbankschema

Tabellen: `sites` (u. a. `preview_url`, `repo_owner`, `repo_name`), `user_sites` (Zuordnung Nutzer ↔ Site), `drafts` (unveröffentlichte Feldwerte, `unique (site_id, field_id)`), `publish_history` (Snapshots als JSONB-Payload, optional `note`-Spalte), `admins`. Row Level Security ist aktiviert; Nutzer dürfen nur Zeilen ihrer zugeordneten `site_id` sehen/ändern. Bilder aus `type: "image"`-Feldern werden clientseitig in den öffentlichen Storage-Bucket `cms-media` hochgeladen (Pfad: `sites/{siteId}/{timestamp}-{dateiname}`). Das vollständige SQL-Schema inkl. Storage-Policies steht in der `README.md`.

## Konventionen und Sicherheitsrichtlinien

- **Zugriffsprüfung in jeder API-Route und geschützten Seite:** Session prüfen (`supabase.auth.getUser()`), dann Mitgliedschaft in `user_sites` für die angefragte `site_id`. Ohne Zuordnung: 401/403 bzw. `notFound()`. Dieses Muster bei neuen Endpunkten beibehalten (Referenz: `authorize()` in `src/app/api/blog/route.ts`).
- **Service-Role-Key niemals clientseitig** verwenden; `createAdminClient()` nur in Admin-API-Routen und immer nach einem Admin-Check gegen die `admins`-Tabelle.
- Fehlermeldungen an den Client auf Deutsch, mit passenden HTTP-Statuscodes; GitHub-Fehler werden in `publish`/`blog` als 502 weitergegeben, in `rollback` als 500.
- Server Components laden Daten (Supabase + GitHub), interaktive Teile sind Client Components (`"use client"`).
- GitHub-Operationen laufen ausschließlich gegen den Branch `main`; Datei-Updates immer mit der zuvor gelesenen `sha` (optimistische Nebenläufigkeit der Contents API).
- Formatierung beim Zurückschreiben von JSON-Dateien: `JSON.stringify(json, null, 2)`.
- Die Live-Vorschau erfordert, dass die Astro-Website auf `postMessage`-Events vom Typ `CMS_FIELD_UPDATE` hört und Elemente mit `data-cms-field`-Attributen aktualisiert (Beispiel-Code in der `README.md`).
