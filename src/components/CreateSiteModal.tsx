"use client";

import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  X,
} from "lucide-react";
import type { Site } from "@/types/cms";

const DEFAULT_REPO_OWNER = "albinodesign";

interface CreateSiteModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (site: Site) => void;
}

interface CreatedResult {
  site: Site;
  einladung: { email: string; link: string };
}

export function CreateSiteModal({ open, onClose, onCreated }: CreateSiteModalProps) {
  const [name, setName] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoOwner, setRepoOwner] = useState(DEFAULT_REPO_OWNER);
  const [previewUrl, setPreviewUrl] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Beim Öffnen: Formular zurücksetzen (N5: kein Passwort mehr – Einladungs-Link)
  useEffect(() => {
    if (open) {
      setName("");
      setRepoName("");
      setRepoOwner(DEFAULT_REPO_OWNER);
      setPreviewUrl("");
      setCustomerEmail("");
      setError(null);
      setResult(null);
      setCopied(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/admin/create-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          repoName,
          repoOwner,
          previewUrl,
          customerEmail,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        site?: Site;
        einladung?: { email: string; link: string };
      };

      if (!res.ok || !body.site || !body.einladung) {
        setError(body.error ?? "Website konnte nicht angelegt werden.");
        return;
      }

      setResult({ site: body.site, einladung: body.einladung });
      onCreated(body.site);
    } catch {
      setError("Server nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    const text = `Zugang zum Website-CMS\nE-Mail: ${result.einladung.email}\nEinladungs-Link (einmalig weitergeben, läuft ab):\n${result.einladung.link}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Kopieren in die Zwischenablage fehlgeschlagen.");
    }
  }

  if (!open) return null;

  const inputClass =
    "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-zinc-900/40"
        onClick={onClose}
        aria-hidden
      />

      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">
            Neue Website anlegen
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100"
            aria-label="Schließen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          /* Erfolgs-Box mit Zugangsdaten */
          <div>
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">Website erfolgreich angelegt!</p>
                <p className="mt-1">
                  &bdquo;{result.site.name}&ldquo; wurde erstellt und dem Kunden zugeordnet.
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Einladung für den Kunden
              </p>
              <p className="mt-2">
                <span className="text-zinc-500">E-Mail:</span>{" "}
                <span className="font-medium text-zinc-900">
                  {result.einladung.email}
                </span>
              </p>
              <p className="mt-2 break-all">
                <span className="text-zinc-500">Einladungs-Link:</span>{" "}
                <span className="font-mono text-xs text-zinc-900">
                  {result.einladung.link}
                </span>
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                Einmalig an den Kunden weitergeben (z. B. per E-Mail) – der Link läuft ab.
                Der Kunde vergibt sein Passwort selbst, es steht nirgends im Klartext.
              </p>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={handleCopy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700"
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copied ? "Kopiert!" : "Einladung kopieren"}
              </button>
              <button
                onClick={onClose}
                className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
              >
                Fertig
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Website-Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Malerbetrieb Schmidt"
              className={`${inputClass} mb-4`}
            />

            <div className="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700">
                  GitHub Repository
                </label>
                <input
                  type="text"
                  required
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder="schmidt-maler"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700">
                  GitHub Owner
                </label>
                <input
                  type="text"
                  required
                  value={repoOwner}
                  onChange={(e) => setRepoOwner(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Preview / Vercel URL
            </label>
            <input
              type="url"
              required
              value={previewUrl}
              onChange={(e) => setPreviewUrl(e.target.value)}
              placeholder="https://schmidt-maler.vercel.app"
              className={`${inputClass} mb-4`}
            />

            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Kunden-E-Mail
            </label>
            <input
              type="email"
              required
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="kunde@schmidt-maler.de"
              className={`${inputClass} mb-2`}
            />
            <p className="mb-6 text-xs text-zinc-500">
              Der Kunde erhält einen Einladungs-Link und vergibt sein Passwort selbst.
            </p>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Wird erstellt …" : "Website & Kunde erstellen"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
