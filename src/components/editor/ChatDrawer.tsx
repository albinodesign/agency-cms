"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Loader2, Plus, Send, Sparkles, X } from "lucide-react";
import type { DraftMap, ManifestField } from "@/types/cms";

/** Deutsche Namen für das, was die KI gerade tut. */
const TOOL_LABELS: Record<string, string> = {
  listeFelder: "schaut sich die Felder an …",
  leseDatei: "liest eine Datei …",
  schreibeInhalt: "ändert einen Inhalt …",
  schreibeCode: "ändert das Design …",
  schreibeFeldliste: "erweitert die Feldliste …",
  leseBilder: "schaut sich Bilder an …",
};

interface ChatDrawerProps {
  siteId: string;
  fields: ManifestField[];
  values: DraftMap;
  open: boolean;
  onClose: () => void;
  /** Feld-Änderung der KI ins Formular + Vorschau übernehmen (wie Tippen). */
  onFieldApplied: (fieldId: string, value: string) => void;
  /** Freie/Code-Entwürfe als "ungespeichert" markieren (für den Status-Badge). */
  onDraftTouched: (fieldId: string) => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

interface Part {
  type: string;
  text?: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
}

function newConversationId(): string {
  return crypto.randomUUID();
}

export function ChatDrawer({
  siteId,
  fields,
  values,
  open,
  onClose,
  onFieldApplied,
  onDraftTouched,
  onError,
  onSuccess,
}: ChatDrawerProps) {
  const [input, setInput] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyDone, setHistoryDone] = useState(false);
  const convRef = useRef<string | null>(null);
  const appliedRef = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  const { messages, setMessages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/ai/chat",
      body: () => {
        if (!convRef.current) convRef.current = newConversationId();
        return {
          siteId,
          conversationId: convRef.current,
          context: {
            fields: fields.map((f) => ({ id: f.id, label: f.label, type: f.type, file: f.file, path: f.path })),
            values,
          },
        };
      },
    }),
    onError: (err) => {
      onError(err.message || "Die KI antwortet gerade nicht.");
    },
  });

  const busy = status === "submitted" || status === "streaming";

  // Verlauf beim Öffnen laden (letztes Gespräch fortsetzen)
  useEffect(() => {
    if (!open || historyDone) return;
    setLoadingHistory(true);
    fetch(`/api/ai/history?siteId=${encodeURIComponent(siteId)}`)
      .then(async (res) => {
        const body = (await res.json()) as {
          conversation?: { id: string } | null;
          messages?: Array<{ role: string; text: string }>;
        };
        if (body.conversation && Array.isArray(body.messages) && body.messages.length > 0) {
          convRef.current = body.conversation.id;
          setMessages(
            body.messages.map((m, i) => ({
              id: `hist-${i}`,
              role: m.role as "user" | "assistant",
              parts: [{ type: "text", text: m.text }],
            }))
          );
        }
      })
      .catch(() => {
        // Verlauf ist Bonus – Chat geht auch ohne
      })
      .finally(() => {
        setLoadingHistory(false);
        setHistoryDone(true);
      });
  }, [open, historyDone, siteId, setMessages]);

  // KI-Feldänderungen ins Formular + Vorschau übernehmen (einmalig pro Werkzeug-Aufruf).
  // Freie und Code-Entwürfe sind nicht im Formular sichtbar – sie werden nur
  // als "ungespeichert" markiert und gehen per Veröffentlichen live.
  useEffect(() => {
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const part of (msg.parts ?? []) as Part[]) {
        if (!part.type.startsWith("tool-") || part.state !== "output-available") continue;
        const key = `${msg.id}-${part.toolCallId ?? part.type}`;
        if (appliedRef.current.has(key)) continue;
        const output = part.output as { art?: string; feldId?: string; wert?: string; datei?: string } | null;
        if (!output || typeof output !== "object") continue;
        appliedRef.current.add(key);
        if (output.art === "feld" && output.feldId && typeof output.wert === "string") {
          onFieldApplied(output.feldId, output.wert);
        } else {
          onDraftTouched(output.feldId ?? output.datei ?? part.type);
        }
      }
    }
  }, [messages, onFieldApplied, onDraftTouched]);

  // Nach unten scrollen bei neuen Nachrichten
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const handleSend = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || busy) return;
      setInput("");
      void sendMessage({ text });
    },
    [input, busy, sendMessage]
  );

  // Nach fertiger KI-Antwort einmalig Bescheid geben (nicht beim Verlauf-Laden)
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusyRef.current = true;
      return;
    }
    if (wasBusyRef.current && messages.length > 0) {
      wasBusyRef.current = false;
      const last = messages[messages.length - 1];
      if (last.role === "assistant") {
        onSuccess("KI hat Entwürfe vorbereitet – prüfe sie und drücke Veröffentlichen.");
      }
    }
  }, [busy, messages, onSuccess]);

  function startNew() {
    convRef.current = newConversationId();
    appliedRef.current = new Set();
    setMessages([]);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-zinc-900/40" onClick={onClose} aria-hidden />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-600" />
            <h2 className="text-sm font-semibold text-zinc-900">KI-Chat</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={startNew}
              title="Neues Gespräch beginnen"
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-500 transition hover:bg-zinc-100"
            >
              <Plus className="h-4 w-4" />
              Neu
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100"
              aria-label="Chat schließen"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadingHistory && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Lade Gespräch …
            </div>
          )}
          {!loadingHistory && messages.length === 0 && (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-6 py-10 text-center">
              <Sparkles className="mx-auto mb-3 h-8 w-8 text-violet-300" />
              <p className="text-sm font-medium text-zinc-700">Frag mich einfach drauflos.</p>
              <p className="mt-1 text-xs text-zinc-500">
                Z. B. &bdquo;Mach die Überschrift freundlicher&ldquo; oder &bdquo;Füge eine dritte Leistungs-Karte hinzu&ldquo;.
                Ich bereite alles als Entwurf vor – live geht es erst wenn du auf Veröffentlichen drückst.
              </p>
            </div>
          )}
          <ul className="space-y-4">
            {messages.map((msg) => (
              <li key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                    msg.role === "user"
                      ? "bg-zinc-900 text-white"
                      : "border border-zinc-200 bg-zinc-50 text-zinc-800"
                  }`}
                >
                  {((msg.parts ?? []) as Part[]).map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <p key={i} className="whitespace-pre-wrap">
                          {part.text}
                        </p>
                      );
                    }
                    if (part.type.startsWith("tool-")) {
                      const name = part.type.slice("tool-".length);
                      const label = TOOL_LABELS[name] ?? "arbeitet …";
                      return (
                        <p key={i} className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                          {part.state === "output-available" ? "✓" : <Loader2 className="h-3 w-3 animate-spin" />}
                          KI {label}
                        </p>
                      );
                    }
                    return null;
                  })}
                </div>
              </li>
            ))}
          </ul>
          {busy && (
            <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              KI arbeitet …
            </p>
          )}
          {error && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error.message}
            </p>
          )}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={handleSend} className="flex gap-2 border-t border-zinc-200 px-5 py-4">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Was soll ich ändern?"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none transition focus:border-violet-600 focus:ring-2 focus:ring-violet-600/10"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => stop()}
              className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              Stopp
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              Senden
            </button>
          )}
        </form>
      </aside>
    </div>
  );
}
