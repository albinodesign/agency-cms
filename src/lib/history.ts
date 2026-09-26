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
