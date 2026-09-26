import type { SupabaseClient } from "@supabase/supabase-js";

export interface HistoryRow {
  site_id: string;
  published_by: string | null;
  commit_sha: string | null;
  payload: Record<string, Record<string, unknown>>;
  note?: string;
}

/**
 * Speichert einen Verlaufseintrag – mit files-Spalte (W11, schlanker Verlauf).
 * Fallbacks für alte Tabellen: Fehlt die files- oder note-Spalte (Migration
 * noch nicht ausgeführt), wird ohne sie gespeichert statt zu scheitern.
 */
export async function insertPublishHistory(
  supabase: SupabaseClient,
  row: HistoryRow,
  files: string[]
): Promise<{ error: string | null }> {
  const kandidat: Record<string, unknown> = { ...row, files };
  for (let versuch = 0; versuch < 3; versuch += 1) {
    const { error } = await supabase.from("publish_history").insert(kandidat);
    if (!error) return { error: null };
    const meldung = error.message ?? "";
    if (/files/i.test(meldung) && "files" in kandidat) {
      delete kandidat.files;
      continue;
    }
    if (/\bnote\b/i.test(meldung) && "note" in kandidat) {
      delete kandidat.note;
      continue;
    }
    console.error("publish_history insert fehlgeschlagen:", meldung);
    return { error: meldung };
  }
  console.error("publish_history insert fehlgeschlagen: alle Speichervarianten scheiterten.");
  return { error: "Alle Speichervarianten scheiterten." };
}

/** Höchstzahl Verlaufseinträge je Website (W18, Retention). */
export const MAX_HISTORY_ENTRIES = 50;

/**
 * Begrenzt den Verlauf einer Site auf die neuesten Einträge (W18).
 * Sortiert bewusst im Code (statt .order/.range), damit auch schmale
 * Datenbank-Fakes damit umgehen können. Fehler werden nur geloggt –
 * Aufräumen darf Publish/Rollback nie kippen.
 */
export async function beschraenkeVerlauf(
  supabase: SupabaseClient,
  siteId: string,
  behalten: number = MAX_HISTORY_ENTRIES
): Promise<void> {
  const { data, error } = await supabase
    .from("publish_history")
    .select("id,created_at")
    .eq("site_id", siteId);
  if (error) {
    console.error("Verlaufs-Retention lesen fehlgeschlagen:", error.message);
    return;
  }
  const sortiert = ((data ?? []) as Array<{ id: string; created_at?: string }>).sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? "")
  );
  const uebrig = sortiert.slice(behalten);
  if (uebrig.length === 0) return;
  const { error: deleteError } = await supabase
    .from("publish_history")
    .delete()
    .eq("site_id", siteId)
    .in(
      "id",
      uebrig.map((r) => r.id)
    );
  if (deleteError) {
    console.error("Verlaufs-Retention löschen fehlgeschlagen:", deleteError.message);
  }
}
