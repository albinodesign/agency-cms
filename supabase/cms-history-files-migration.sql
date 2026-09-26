-- ============================================================
-- Agency CMS: Dateiliste pro Verlaufseintrag (W11, Performance)
-- Einmalig im Supabase SQL-Editor ausführen (dauert Sekunden).
--
-- Problem: Der Verlauf lud bisher volle payload-JSONBs aller Versionen,
-- nur um Dateinamen anzuzeigen. Mit der files-Spalte lädt der Editor nur
-- noch Metadaten (id, Zeit, Notiz, Version, Dateien) – der schwere Payload
-- bleibt in der Datenbank, bis eine Version wirklich zurückgerollt wird.
-- ============================================================

alter table publish_history
  add column if not exists files text[] not null default '{}';

-- Notiz-Spalte (z. B. "Rollback"): alte Tabellen kennen sie ggf. noch nicht.
-- Ohne sie scheitert das Laden des Verlaufs ("column publish_history.note
-- does not exist"); der Editor lädt ersatzweise ohne sie.
alter table publish_history
  add column if not exists note text;

-- Bestehende Einträge nachpflegen (Dateinamen aus dem Payload ableiten)
update publish_history
set files = (
  select coalesce(array_agg(k), '{}')
  from jsonb_object_keys(payload) as k
)
where files = '{}';
