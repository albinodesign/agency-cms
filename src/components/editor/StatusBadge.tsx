"use client";

import { CheckCircle2, Eye, Loader2 } from "lucide-react";

/** Speicherzustand des Editors (Ampel oben rechts). */
export type SaveStatus = "live" | "saving" | "saved";

export function StatusBadge({
  status,
  hasDrafts,
  draftCount,
  onOpenDiff,
}: {
  status: SaveStatus;
  hasDrafts: boolean;
  draftCount: number;
  /** Wenn gesetzt: Badge ist anklickbar und öffnet den Diff-Inspektor */
  onOpenDiff?: () => void;
}) {
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Speichern …
      </span>
    );
  }
  if (status === "saved" || hasDrafts) {
    const label = `Entwurf gesichert (${draftCount} ungespeicherte Änderung${draftCount === 1 ? "" : "en"})`;
    if (onOpenDiff) {
      return (
        <button
          onClick={onOpenDiff}
          title="Ausstehende Änderungen prüfen"
          className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          {label}
          <Eye className="h-3.5 w-3.5" />
        </button>
      );
    }
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        {label}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600">
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
      Bereit – Keine ungespeicherten Änderungen
    </span>
  );
}
