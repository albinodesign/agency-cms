"use client";

import { RotateCcw } from "lucide-react";

/** Unaufdringlicher Zurücksetzen-Knopf pro Feld (Undo auf Live-Stand). */
export function UndoButton({ onUndo }: { onUndo: () => void }) {
  return (
    <button
      type="button"
      onClick={onUndo}
      title="Auf Live-Stand zurücksetzen"
      className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
    >
      <RotateCcw className="h-3.5 w-3.5" />
    </button>
  );
}
