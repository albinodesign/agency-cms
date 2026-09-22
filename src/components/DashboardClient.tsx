"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import { CreateSiteModal } from "@/components/CreateSiteModal";
import { ArrowRight, Globe, Plus, Sparkles } from "lucide-react";
import type { Site } from "@/types/cms";

interface DashboardClientProps {
  initialSites: Site[];
  isAdmin: boolean;
  loadError: string | null;
}

export function DashboardClient({
  initialSites,
  isAdmin,
  loadError,
}: DashboardClientProps) {
  const [sites, setSites] = useState<Site[]>(initialSites);
  const [modalOpen, setModalOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  /** KI-Chat pro Website an-/ausschalten (nur Admins). */
  async function toggleAi(site: Site) {
    const enabled = !site.ai_enabled;
    setTogglingId(site.id);
    try {
      const res = await fetch("/api/admin/toggle-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: site.id, enabled }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        alert(body.error ?? "Schalter konnte nicht umgelegt werden.");
        return;
      }
      setSites((prev) => prev.map((s) => (s.id === site.id ? { ...s, ai_enabled: enabled } : s)));
    } catch {
      alert("Server nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900 text-white">
              <Globe className="h-4 w-4" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-zinc-900">
              Agency CMS
            </span>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <button
                onClick={() => setModalOpen(true)}
                className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700"
              >
                <Plus className="h-4 w-4" />
                Neue Website anlegen
              </button>
            )}
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Deine Websites
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Wähle eine Website aus, um Inhalte zu bearbeiten.
        </p>

        {loadError && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Websites konnten nicht geladen werden: {loadError}
          </div>
        )}

        {!loadError && sites.length === 0 && (
          <div className="mt-10 rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-16 text-center">
            <p className="text-sm text-zinc-500">
              Dir ist aktuell keine Website zugeordnet. Wende dich an deine
              Agentur, um Zugriff zu erhalten.
            </p>
          </div>
        )}

        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((site) => (
            <div
              key={site.id}
              className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100">
                <Globe className="h-5 w-5 text-zinc-600" />
              </div>
              <h2 className="text-base font-semibold text-zinc-900">
                {site.name}
              </h2>
              <p className="mt-1 truncate text-sm text-zinc-500">
                {site.domain ?? site.preview_url}
              </p>
              {isAdmin && (
                <button
                  onClick={() => void toggleAi(site)}
                  disabled={togglingId === site.id}
                  title={site.ai_enabled ? "KI-Chat ausschalten" : "KI-Chat freischalten"}
                  className={`mt-4 flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium transition disabled:opacity-60 ${
                    site.ai_enabled
                      ? "border-violet-300 bg-violet-50 text-violet-800"
                      : "border-zinc-200 bg-zinc-50 text-zinc-500 hover:bg-zinc-100"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" />
                    KI-Chat {site.ai_enabled ? "an" : "aus"}
                  </span>
                  <span
                    className={`relative h-5 w-9 shrink-0 rounded-full transition ${
                      site.ai_enabled ? "bg-violet-600" : "bg-zinc-300"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                        site.ai_enabled ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </span>
                </button>
              )}
              <Link
                href={`/editor/${site.id}`}
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700"
              >
                Website bearbeiten
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ))}
        </div>
      </main>

      {isAdmin && (
        <CreateSiteModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onCreated={(site) => setSites((prev) => [...prev, site])}
        />
      )}
    </div>
  );
}
