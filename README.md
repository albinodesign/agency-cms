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

Row Level Security aktivieren; Policy-Idee: Nutzer dürfen nur Zeilen sehen/ändern, deren `site_id` in `user_sites` dem eigenen `auth.uid()` zugeordnet ist.

## Supabase Storage (Bild-Uploads)

Bilder aus `type: "image"`-Feldern werden clientseitig in den Bucket `cms-media` hochgeladen (Pfad: `sites/{siteId}/{timestamp}-{dateiname}`).

1. Bucket `cms-media` anlegen und als **public** markieren.
2. Storage-Policy: authentifizierte Nutzer dürfen hochladen/lesen, z. B.:

   ```sql
   create policy "authenticated users can upload cms-media"
   on storage.objects for insert to authenticated
   with check (bucket_id = 'cms-media');

   create policy "public read cms-media"
   on storage.objects for select to public
   using (bucket_id = 'cms-media');
   ```

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

## Live-Vorschau auf der Astro-Website

Damit Eingaben sofort im Iframe sichtbar werden, muss die Website auf `postMessage`-Events hören:

```js
window.addEventListener("message", (event) => {
  const { type, field, value } = event.data ?? {};
  if (type !== "CMS_FIELD_UPDATE") return;
  document.querySelectorAll(`[data-cms-field="${field}"]`).forEach((el) => {
    if (el.tagName === "IMG") el.src = value;
    else el.textContent = value;
  });
});
```

## Publish-Flow

`POST /api/publish` (sessiongeschützt) liest alle Entwürfe einer Site, gruppiert sie nach Zieldatei, aktualisiert die JSON-Dateien über die GitHub Contents API und committet mit `cms: update content by client` auf `main`. Danach wird ein Snapshot in `publish_history` gespeichert und die publizierten Entwürfe aus `drafts` gelöscht. Vercel deployed den Push automatisch.
