-- ============================================================
-- KI-Chat Erweiterung für das Agency CMS
-- Einmalig im Supabase SQL-Editor ausführen (Region egal, dauert Sekunden)
-- ============================================================

-- 1) Schalter pro Website: true = Kunde sieht den KI-Chat
alter table sites add column if not exists ai_enabled boolean not null default false;

-- 2) Gespräche (eins pro Kunde und Thema, Verlauf bleibt erhalten)
create table if not exists ai_conversations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references sites(id) on delete cascade not null,
  created_by uuid references auth.users(id) on delete set null,
  title text not null default 'Neues Gespräch',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) Nachrichten (Text + Werkzeug-Ergebnisse als JSON, inkl. Token-Zähler)
create table if not exists ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references ai_conversations(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  created_at timestamptz not null default now()
);

-- 4) Code-Entwürfe (Datei-Änderungen der KI, gehen erst per Veröffentlichen live)
create table if not exists code_drafts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references sites(id) on delete cascade not null,
  file_path text not null,
  content text not null,
  updated_at timestamptz not null default now(),
  unique (site_id, file_path)
);

-- 5) Kosten-Zähler pro Website und Monat (kein Limit, nur Übersicht)
create table if not exists ai_usage (
  site_id uuid references sites(id) on delete cascade not null,
  month text not null,
  messages integer not null default 0,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (site_id, month)
);

-- ============================================================
-- Zugriffsregeln: Nur Mitglieder der jeweiligen Website
-- (gleiches Muster wie bei der drafts-Tabelle)
-- ============================================================
alter table ai_conversations enable row level security;
alter table ai_messages enable row level security;
alter table code_drafts enable row level security;
alter table ai_usage enable row level security;

-- Gespräche: Mitglieder dürfen alles (lesen, anlegen, umbenennen, löschen)
create policy "Mitglieder verwalten Gespräche"
  on ai_conversations for all to authenticated
  using (exists (select 1 from user_sites where user_sites.site_id = ai_conversations.site_id and user_sites.user_id = auth.uid()))
  with check (exists (select 1 from user_sites where user_sites.site_id = ai_conversations.site_id and user_sites.user_id = auth.uid()));

-- Nachrichten: Mitglieder der Website des Gesprächs dürfen alles
create policy "Mitglieder verwalten Nachrichten"
  on ai_messages for all to authenticated
  using (exists (
    select 1 from ai_conversations
    join user_sites on user_sites.site_id = ai_conversations.site_id
    where ai_conversations.id = ai_messages.conversation_id and user_sites.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from ai_conversations
    join user_sites on user_sites.site_id = ai_conversations.site_id
    where ai_conversations.id = ai_messages.conversation_id and user_sites.user_id = auth.uid()
  ));

-- Code-Entwürfe: wie drafts, Mitglieder der Website dürfen alles
create policy "Mitglieder verwalten Code-Entwürfe"
  on code_drafts for all to authenticated
  using (exists (select 1 from user_sites where user_sites.site_id = code_drafts.site_id and user_sites.user_id = auth.uid()))
  with check (exists (select 1 from user_sites where user_sites.site_id = code_drafts.site_id and user_sites.user_id = auth.uid()));

-- Kosten-Zähler: Mitglieder dürfen lesen (schreiben übernimmt die Chat-Schnittstelle)
create policy "Mitglieder lesen Kosten-Zähler"
  on ai_usage for select to authenticated
  using (exists (select 1 from user_sites where user_sites.site_id = ai_usage.site_id and user_sites.user_id = auth.uid()));

create policy "Mitglieder schreiben Kosten-Zähler"
  on ai_usage for insert to authenticated
  with check (exists (select 1 from user_sites where user_sites.site_id = ai_usage.site_id and user_sites.user_id = auth.uid()));

create policy "Mitglieder aktualisieren Kosten-Zähler"
  on ai_usage for update to authenticated
  using (exists (select 1 from user_sites where user_sites.site_id = ai_usage.site_id and user_sites.user_id = auth.uid()));
