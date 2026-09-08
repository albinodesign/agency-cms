"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { History, Loader2, RotateCcw, X } from "lucide-react";
import type { PublishHistoryEntry } from "@/types/cms";

interface HistoryDrawerProps {
  siteId: string;
  open: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

export function HistoryDrawer({
  siteId,
  open,
  onClose,
  onError,
}: HistoryDrawerProps) {
  const [entries, setEntries] = useState<PublishHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("publish_history")
        .select("*")
        .eq("site_id", siteId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) {
        onError(`Verlauf konnte nicht geladen werden: ${error.message}`);
        return;
      }
      setEntries((data ?? []) as PublishHistoryEntry[]);
    } catch {
      onError("Verlauf konnte nicht geladen werden: Supabase nicht erreichbar.");
    } finally {
      setLoading(false);
    }
  }, [siteId, onError]);

  useEffect(() => {
    if (open) void loadHistory();
  }, [open, loadHistory]);

  async function handleRestore(entry: PublishHistoryEntry) {
    const confirmed = window.confirm(
      "Diese Version wirklich wiederherstellen? Der aktuelle Stand wird überschrieben und sofort veröffentlicht."
    );
    if (!confirmed) return;

    setRestoringId(entry.id);
    try {
      const res = await fetch("/api/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, historyId: entry.id }),
      });
      const body = (await res.json()) as { error?: string };

      if (!res.ok) {
        onError(body.error ?? "Wiederherstellung fehlgeschlagen.");
        return;
      }

      // Editor-Stand zurücksetzen: Seite neu laden, damit Live-Werte frisch kommen
      window.location.reload();
    } catch {
      onError("Server nicht erreichbar. Bitte später erneut versuchen.");
      setRestoringId(null);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-zinc-900/40"
        onClick={onClose}
        aria-hidden
      />

      {/* Drawer */}
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold text-zinc-900">
              Versions-Verlauf
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100"
            aria-label="Verlauf schließen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Lade Verlauf …
            </div>
          )}

          {!loading && entries.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">
              Noch keine Veröffentlichungen vorhanden.
            </p>
          )}

          <ul className="space-y-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4"
              >
                <p className="text-sm font-medium text-zinc-900">
                  {new Date(entry.created_at).toLocaleString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  Uhr
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {entry.user_email ?? entry.user_id} ·{" "}
                  {Object.keys(entry.snapshot ?? {}).length} Feld(er)
                </p>
                <button
                  onClick={() => handleRestore(entry)}
                  disabled={restoringId !== null}
                  className="mt-3 flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60"
                >
                  {restoringId === entry.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Diese Version wiederherstellen
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
