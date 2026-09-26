/**
 * Gemeinsame Datumsanzeige (N8): „Version vom 26.09.2026, 14:03 Uhr".
 * Eine Funktion statt zwei Kopien (BlogPanel, HistoryDrawer).
 */
export function formatVerlaufsdatum(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Version vom ${day}, ${time} Uhr`;
}

/** Kurzdatum für Listen (Blog-Übersicht). */
export function formatKurzdatum(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
