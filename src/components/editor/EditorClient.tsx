"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ImageField } from "@/components/editor/ImageField";
import { HistoryDrawer } from "@/components/editor/HistoryDrawer";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  History,
  Loader2,
  Monitor,
  Rocket,
  Smartphone,
  X,
} from "lucide-react";
import type {
  CmsManifest,
  DraftMap,
  ManifestField,
  ManifestSection,
  Site,
} from "@/types/cms";

type SaveStatus = "live" | "saving" | "saved";
type Viewport = "desktop" | "mobile";

interface EditorClientProps {
  site: Site;
  manifest: CmsManifest | null;
  manifestError: string | null;
  contentWarning: string | null;
  /** Live-Werte aus GitHub, bereits mit Drafts gemergt */
  initialValues: DraftMap;
  /** Feld-IDs, zu denen ein unveröffentlichter Draft existiert */
  draftFields: string[];
}

interface Toast {
  id: number;
  kind: "success" | "error";
  message: string;
}

export function EditorClient({
  site,
  manifest,
  manifestError,
  contentWarning,
  initialValues,
  draftFields,
}: EditorClientProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const pendingRef = useRef(0);

  const [values, setValues] = useState<DraftMap>(initialValues);
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(
    () => new Set(draftFields)
  );
  const [status, setStatus] = useState<SaveStatus>(
    draftFields.length > 0 ? "saved" : "live"
  );
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [publishing, setPublishing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Defensives Mapping: akzeptiert Array, { sections } oder { fields }
  const sections = useMemo<ManifestSection[]>(() => {
    const raw = manifest as unknown;
    const list = Array.isArray(raw)
      ? raw
      : ((raw as CmsManifest | null)?.sections ??
        (raw as { fields?: unknown[] } | null)?.fields ??
        []);
    if (!Array.isArray(list)) return [];
    // Falls flaches Feld-Array: in eine Sektion verpacken
    const looksLikeSections = list.some(
      (item) => item != null && Array.isArray((item as ManifestSection).fields)
    );
    if (looksLikeSections) return list as ManifestSection[];
    return list.length > 0
      ? [{ id: "content", title: "Inhalte", fields: list as ManifestField[] }]
      : [];
  }, [manifest]);

  // Akkordeon: erste Sektion standardmäßig geöffnet
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(sections[0] ? [sections[0].id] : [])
  );

  const pushToast = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const pushErrorToast = useCallback(
    (message: string) => pushToast("error", message),
    [pushToast]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  const toggleSection = useCallback((sectionId: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }, []);

  const saveDraft = useCallback(
    async (fieldId: string, value: string) => {
      pendingRef.current += 1;
      setStatus("saving");
      try {
        const supabase = createClient();
        const { error } = await supabase.from("drafts").upsert(
          { site_id: site.id, field_id: fieldId, value },
          { onConflict: "site_id,field_id" }
        );
        if (error) {
          pushToast("error", `Entwurf konnte nicht gespeichert werden: ${error.message}`);
        }
      } catch {
        pushToast("error", "Supabase ist nicht erreichbar. Änderung wurde nicht gespeichert.");
      } finally {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (pendingRef.current === 0) {
          setStatus((prev) => (prev === "saving" ? "saved" : prev));
        }
      }
    },
    [site.id, pushToast]
  );

  const handleChange = useCallback(
    (fieldId: string, value: string) => {
      setValues((prev) => ({ ...prev, [fieldId]: value }));
      setDirtyFields((prev) => new Set(prev).add(fieldId));

      // a) Sofortiges Live-Update an die Vorschau
      iframeRef.current?.contentWindow?.postMessage(
        { type: "CMS_FIELD_UPDATE", field: fieldId, value },
        "*"
      );

      // b) Debounced Autosave (800ms)
      const existing = timersRef.current.get(fieldId);
      if (existing) clearTimeout(existing);
      setStatus("saving");
      timersRef.current.set(
        fieldId,
        setTimeout(() => {
          timersRef.current.delete(fieldId);
          void saveDraft(fieldId, value);
        }, 800)
      );
    },
    [saveDraft]
  );

  async function handlePublish() {
    setPublishing(true);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: site.id }),
      });
      const body = (await res.json()) as { error?: string; message?: string };

      if (!res.ok) {
        pushToast("error", body.error ?? "Veröffentlichung fehlgeschlagen.");
        return;
      }

      setDirtyFields(new Set());
      setStatus("live");
      // Verlaufs-Liste sofort neu laden lassen
      setHistoryRefresh((k) => k + 1);
      pushToast(
        "success",
        body.message ?? "Änderungen wurden veröffentlicht. Die Website wird in wenigen Minuten aktualisiert."
      );
    } catch {
      pushToast("error", "Server nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      setPublishing(false);
    }
  }

  const hasDrafts = dirtyFields.size > 0;

  return (
    <div className="flex h-screen flex-col bg-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Zurück zum Dashboard</span>
          </Link>
          <div className="hidden h-5 w-px bg-zinc-200 sm:block" />
          <h1 className="truncate text-sm font-semibold text-zinc-900">
            {site.name}
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <StatusBadge status={status} hasDrafts={hasDrafts} />
          <button
            onClick={() => setHistoryOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
          >
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">Verlauf</span>
          </button>
          <button
            onClick={handlePublish}
            disabled={publishing}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {publishing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            {publishing ? "Veröffentlichen …" : "Veröffentlichen"}
          </button>
        </div>
      </header>

      {/* Split-Screen */}
      <div className="flex min-h-0 flex-1">
        {/* Linke Spalte: Formular */}
        <div className="w-full min-w-0 flex-1 overflow-y-auto border-r border-zinc-200 bg-white lg:w-[40%] lg:flex-none">
          <div className="mx-auto max-w-xl px-6 py-6">
            {manifestError && (
              <div className="mb-6 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-semibold">Manifest konnte nicht geladen werden</p>
                    <p className="mt-1 break-words">{manifestError}</p>
                  </div>
                </div>
              </div>
            )}

            {contentWarning && (
              <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="break-words">{contentWarning}</p>
                </div>
              </div>
            )}

            {sections?.map((section) => {
              const isOpen = openSections.has(section.id);
              return (
                <section
                  key={section?.id}
                  className="mb-4 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50/50"
                >
                  <button
                    type="button"
                    onClick={() => toggleSection(section.id)}
                    className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-zinc-100"
                  >
                    <span className="text-sm font-semibold text-zinc-900">
                      {section?.title}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400">
                        {section?.fields?.length ?? 0} Feld(er)
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </span>
                  </button>

                  {isOpen && (
                    <div className="space-y-4 border-t border-zinc-200 px-5 py-5">
                      {section?.fields?.map((field) => (
                        <FieldEditor
                          key={field?.id}
                          field={field}
                          value={values[field.id] ?? ""}
                          siteId={site.id}
                          onChange={(v) => handleChange(field.id, v)}
                          onError={pushErrorToast}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}

            {!manifestError && sections.length === 0 && (
              <p className="text-sm text-zinc-500">
                Das Manifest enthält keine bearbeitbaren Sektionen.
              </p>
            )}
          </div>
        </div>

        {/* Rechte Spalte: Vorschau */}
        <div className="hidden min-w-0 flex-1 flex-col lg:flex">
          <div className="flex items-center justify-end gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2">
            <button
              onClick={() => setViewport("desktop")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                viewport === "desktop"
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              <Monitor className="h-3.5 w-3.5" />
              Desktop
            </button>
            <button
              onClick={() => setViewport("mobile")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                viewport === "mobile"
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              <Smartphone className="h-3.5 w-3.5" />
              Mobil
            </button>
          </div>
          <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-zinc-200/60 p-4">
            <div
              className={`h-full overflow-hidden bg-white shadow-lg transition-all duration-300 ${
                viewport === "mobile"
                  ? "w-[375px] rounded-2xl border border-zinc-300"
                  : "w-full rounded-xl border border-zinc-200"
              }`}
            >
              <iframe
                ref={iframeRef}
                src={site.preview_url}
                title={`Vorschau: ${site.name}`}
                className="h-full w-full"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Verlauf-Drawer */}
      <HistoryDrawer
        siteId={site.id}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onError={pushErrorToast}
        onSuccess={(msg) => pushToast("success", msg)}
        refreshSignal={historyRefresh}
      />

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg ${
              toast.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {toast.kind === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span className="flex-1">{toast.message}</span>
            <button
              onClick={() =>
                setToasts((prev) => prev.filter((t) => t.id !== toast.id))
              }
              className="opacity-60 transition hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  hasDrafts,
}: {
  status: SaveStatus;
  hasDrafts: boolean;
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
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Entwurf gesichert
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Alle Änderungen live
    </span>
  );
}

function FieldEditor({
  field,
  value,
  siteId,
  onChange,
  onError,
}: {
  field: ManifestField;
  value: string;
  siteId: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}) {
  const baseClass =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";

  const counter = field.maxLength
    ? `${value.length} / ${field.maxLength} Zeichen`
    : `${value.length} Zeichen`;
  const counterTooLong = field.maxLength != null && value.length > field.maxLength;

  if (field.type === "image") {
    return (
      <ImageField
        field={field}
        value={value}
        siteId={siteId}
        onChange={onChange}
        onError={onError}
      />
    );
  }

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-zinc-700">
        {field.label}
      </label>

      {field.type === "text" && (
        <input
          type="text"
          value={value}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      )}

      {field.type === "textarea" && (
        <textarea
          value={value}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={`${baseClass} resize-y`}
        />
      )}

      <p
        className={`mt-1 text-right text-xs ${
          counterTooLong ? "font-medium text-red-600" : "text-zinc-400"
        }`}
      >
        {counter}
      </p>
    </div>
  );
}
