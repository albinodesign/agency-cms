-- ============================================================
-- Agency CMS: Zugriffstrennung (Mandantentrennung) + Storage-Regeln
-- Einmalig im Supabase SQL-Editor ausführen (dauert Sekunden).
-- Ergänzt supabase/ai-chat-schema.sql (KI-Tabellen) um die Kern-Tabellen.
--
-- Prinzip: Ein eingeloggter Nutzer sieht und ändert nur Zeilen von Sites,
-- für die er in user_sites eingetragen ist. Alles andere bleibt unsichtbar.
-- Admins arbeiten über den Service-Role-Key und umgehen RLS bewusst
-- (nur in src/app/api/admin/*, niemals im Browser).
-- ============================================================

-- ---------- 1) Row Level Security aktivieren ----------
alter table sites enable row level security;
alter table user_sites enable row level security;
alter table drafts enable row level security;
alter table publish_history enable row level security;
alter table admins enable row level security;
-- Hinweis: Für admins gibt es bewusst KEINE Policy für angemeldete Nutzer:
-- Die Tabelle ist nur über den Service-Role-Key lesbar (Admin-Check serverseitig).

-- ---------- 2) Alte CMS-Policies aufräumen (idempotent) ----------
drop policy if exists "Mitglieder lesen eigene Websites" on sites;
drop policy if exists "Mitglieder sehen eigene Zuordnungen" on user_sites;
drop policy if exists "Mitglieder verwalten Entwürfe" on drafts;
drop policy if exists "Mitglieder lesen Verlauf" on publish_history;
drop policy if exists "Mitglieder schreiben Verlauf" on publish_history;

-- ---------- 3) sites: Mitglieder dürfen ihre Sites lesen ----------
-- (Anlegen/Ändern/Löschen nur per Admin-API mit Service Role.)
create policy "Mitglieder lesen eigene Websites"
  on sites for select to authenticated
  using (exists (
    select 1 from user_sites
    where user_sites.site_id = sites.id
      and user_sites.user_id = auth.uid()
  ));

-- ---------- 4) user_sites: jeder sieht nur seine eigenen Zeilen ----------
create policy "Mitglieder sehen eigene Zuordnungen"
  on user_sites for select to authenticated
  using (user_sites.user_id = auth.uid());

-- ---------- 5) drafts: Mitglieder verwalten Entwürfe ihrer Sites ----------
-- (Deckt den Editor-Direktzugriff ab: Autosave-Upsert, Undo-Löschen,
--  Diff-Anzeige sowie die Publish-/Rollback-Routen.)
create policy "Mitglieder verwalten Entwürfe"
  on drafts for all to authenticated
  using (exists (
    select 1 from user_sites
    where user_sites.site_id = drafts.site_id
      and user_sites.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from user_sites
    where user_sites.site_id = drafts.site_id
      and user_sites.user_id = auth.uid()
  ));

-- ---------- 6) publish_history: Verlauf lesen + schreiben für Mitglieder ----------
-- (Lesen: HistoryDrawer. Schreiben: Publish- und Rollback-Routen legen
--  Snapshots serverseitig mit der Nutzer-Session an.)
create policy "Mitglieder lesen Verlauf"
  on publish_history for select to authenticated
  using (exists (
    select 1 from user_sites
    where user_sites.site_id = publish_history.site_id
      and user_sites.user_id = auth.uid()
  ));

create policy "Mitglieder schreiben Verlauf"
  on publish_history for insert to authenticated
  with check (exists (
    select 1 from user_sites
    where user_sites.site_id = publish_history.site_id
      and user_sites.user_id = auth.uid()
  ));

-- ============================================================
-- 7) Storage-Bucket cms-media: Schreiben nur im eigenen Site-Ordner
-- Lesen bleibt öffentlich (Bilder sind Website-Inhalte und müssen auch
-- ohne Login ladbar sein – sonst zeigt die Astro-Website keine Bilder).
-- Schreiben (hochladen/ersetzen/löschen) geht nur unter
-- sites/{eigeneSiteId}/... und nur für Mitglieder dieser Site.
-- Der Pfad-Anteil wird ausnahme-sicher als UUID gelesen: Unförmige
-- Pfade ergeben NULL und fallen damit durch jede Prüfung.
-- ============================================================

-- Bucket sicherstellen (public, damit Websites Bilder ohne Login laden)
insert into storage.buckets (id, name, public)
values ('cms-media', 'cms-media', true)
on conflict (id) do update set public = true;

-- Hilfsfunktion: Site-ID aus einem Storage-Pfad lesen (NULL bei Missbrauch)
create or replace function public.cms_site_id_from_path(p_name text)
returns uuid
language plpgsql
stable
as $$
declare
  v uuid;
begin
  if p_name is null or p_name not like 'sites/%' then
    return null;
  end if;
  begin
    v := split_part(p_name, '/', 2)::uuid;
  exception when others then
    return null;
  end;
  return v;
end;
$$;

-- Hilfsfunktion: Ist der Anrufer Mitglied dieser Site?
create or replace function public.is_site_member(p_site_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.user_sites
    where site_id = p_site_id
      and user_id = auth.uid()
  );
$$;

-- Alte CMS-Storage-Policies aufräumen (idempotent)
drop policy if exists "authenticated users can upload cms-media" on storage.objects;
drop policy if exists "public read cms-media" on storage.objects;
drop policy if exists "Mitglieder laden in eigenen Site-Ordner hoch" on storage.objects;
drop policy if exists "Mitglieder ersetzen im eigenen Site-Ordner" on storage.objects;
drop policy if exists "Mitglieder löschen im eigenen Site-Ordner" on storage.objects;
drop policy if exists "Oeffentliches Lesen cms-media" on storage.objects;

-- Öffentliches Lesen (Website-Bilder, kein Login nötig)
create policy "Oeffentliches Lesen cms-media"
  on storage.objects for select to public
  using (bucket_id = 'cms-media');

-- Hochladen: nur authentifiziert, nur eigener Site-Ordner
create policy "Mitglieder laden in eigenen Site-Ordner hoch"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'cms-media'
    and public.cms_site_id_from_path(name) is not null
    and public.is_site_member(public.cms_site_id_from_path(name))
  );

-- Ersetzen/Aktualisieren: nur im eigenen Site-Ordner
create policy "Mitglieder ersetzen im eigenen Site-Ordner"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'cms-media'
    and public.cms_site_id_from_path(name) is not null
    and public.is_site_member(public.cms_site_id_from_path(name))
  )
  with check (
    bucket_id = 'cms-media'
    and public.cms_site_id_from_path(name) is not null
    and public.is_site_member(public.cms_site_id_from_path(name))
  );

-- Löschen: nur im eigenen Site-Ordner
create policy "Mitglieder löschen im eigenen Site-Ordner"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'cms-media'
    and public.cms_site_id_from_path(name) is not null
    and public.is_site_member(public.cms_site_id_from_path(name))
  );

-- ============================================================
-- Prüfhinweise (manuell im SQL-Editor, mit zwei Test-Accounts):
-- 1. Als Kunde A (nur Site A): select * from drafts → nur Site-A-Zeilen.
-- 2. Als Kunde A: select * from sites → nur Site A.
-- 3. Als Kunde A: insert into storage.objects ... mit name 'sites/<Site-B-UUID>/x.png'
--    → muss mit RLS-Verletzung scheitern.
-- 4. Produktive Instanz: Abnahme auf der echten Supabase-Instanz bleibt OFFEN,
--    solange kein Zugriff besteht (siehe Phasenbericht).
-- ============================================================
