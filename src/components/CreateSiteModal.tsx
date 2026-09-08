"use client";

import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import type { Site } from "@/types/cms";

const DEFAULT_REPO_OWNER = "albinodesign";

function generatePassword(length = 12): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (n) => chars[n % chars.length]).join("");
}

interface CreateSiteModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (site: Site) => void;
}

interface CreatedResult {
  site: Site;
  credentials: { email: string; password: string };
}

export function CreateSiteModal({ open, onClose, onCreated }: CreateSiteModalProps) {
  const [name, setName] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoOwner, setRepoOwner] = useState(DEFAULT_REPO_OWNER);
  const [previewUrl, setPreviewUrl] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPassword, setCustomerPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Beim Öffnen: frisches Passwort generieren, Formular zurücksetzen
  useEffect(() => {
    if (open) {
      setName("");
      setRepoName("");
      setRepoOwner(DEFAULT_REPO_OWNER);
      setPreviewUrl("");
      setCustomerEmail("");
      setCustomerPassword(generatePassword());
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
          customerPassword,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        site?: Site;
        credentials?: { email: string; password: string };
      };

      if (!res.ok || !body.site || !body.credentials) {
        setError(body.error ?? "Website konnte nicht angelegt werden.");
        return;
      }

      setResult({ site: body.site, credentials: body.credentials });
      onCreated(body.site);
    } catch {
      setError("Server nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    const text = `Zugang zum Website-CMS\nE-Mail: ${result.credentials.email}\nPasswort: ${result.credentials.password}`;
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
                Zugangsdaten für den Kunden
              </p>
              <p className="mt-2">
                <span className="text-zinc-500">E-Mail:</span>{" "}
                <span className="font-medium text-zinc-900">
                  {result.credentials.email}
                </span>
              </p>
              <p className="mt-1">
                <span className="text-zinc-500">Passwort:</span>{" "}
                <code className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-zinc-900">
                  {result.credentials.password}
                </code>
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
                {copied ? "Kopiert!" : "Zugangsdaten kopieren"}
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
              className={`${inputClass} mb-4`}
            />

            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Kunden-Passwort
            </label>
            <div className="mb-6 flex gap-2">
              <input
                type="text"
                required
                minLength={8}
                value={customerPassword}
                onChange={(e) => setCustomerPassword(e.target.value)}
                className={`${inputClass} font-mono`}
              />
              <button
                type="button"
                onClick={() => setCustomerPassword(generatePassword())}
                title="Neues Passwort generieren"
                className="shrink-0 rounded-lg border border-zinc-300 px-3 text-zinc-600 transition hover:bg-zinc-100"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>

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
