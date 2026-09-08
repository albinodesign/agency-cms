import { Loader2 } from "lucide-react";

export default function EditorLoading() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-zinc-100">
      <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      <p className="text-sm font-medium text-zinc-500">
        Lade Website-Inhalte …
      </p>
    </div>
  );
}
