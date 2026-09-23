"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ImageField } from "@/components/editor/ImageField";
import { HistoryDrawer } from "@/components/editor/HistoryDrawer";
import { ChatDrawer } from "@/components/editor/ChatDrawer";
import { BlogPanel } from "@/components/editor/BlogPanel";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Eye,
  FileText,
  History,
  Loader2,
  Monitor,
  Newspaper,
  Rocket,
  RotateCcw,
  Search,
  Smartphone,
  Sparkles,
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
  /** Reine Live-Werte aus GitHub (ohne Drafts) – für Undo + Diff-Vergleich */
  liveValues: DraftMap;
  /** Feld-IDs, zu denen ein unveröffentlichter Draft existiert */
  draftFields: string[];
}

interface Toast {
  id: number;
  kind: "success" | "error";
  message: string;
}

interface PageGroup {
  id: string;
  label: string;
  sections: ManifestSection[];
}

type DeployState = "idle" | "sending" | "building" | "done";

/** Bekannte Seiten-Präfixe (Sektions-ID/Titel oder Dateiname) -> Tab-Label */
const PAGE_KEYWORDS: [RegExp, string][] = [
  [/home|startseite|index/i, "Startseite"],
  [/about|über|ueber/i, "Über uns"],
  [/service|leistung/i, "Leistungen"],
  [/contact|kontakt/i, "Kontakt"],
  [/blog/i, "Blog"],
  [/site|global|firma|footer|header|settings/i, "Firmendaten"],
];

/** Ermittelt die Seite einer Sektion: erst ID/Titel, sonst Dateipfad der Felder. */
function detectPageLabel(section: ManifestSection): string {
  const haystack = `${section.id} ${section.title}`;
  for (const [pattern, label] of PAGE_KEYWORDS) {
    if (pattern.test(haystack)) return label;
  }
  // Fallback: Seite aus dem file-Pfad ableiten (z. B. pages/home.json -> Startseite)
  const file = section.fields[0]?.file ?? "";
  const base = file.split("/").pop()?.replace(/\.json$/i, "") ?? "";
  if (base) {
    for (const [pattern, label] of PAGE_KEYWORDS) {
      if (pattern.test(base)) return label;
    }
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  return "Weitere";
}

export function EditorClient({
  site,
  manifest,
  manifestError,
  contentWarning,
  initialValues,
  liveValues: initialLiveValues,
  draftFields,
}: EditorClientProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const pendingRef = useRef(0);

  // Konkreter Origin der Vorschau-Website für postMessage (statt "*")
  const previewOrigin = useMemo(() => {
    try {
      return new URL(site.preview_url).origin;
    } catch {
      return null;
    }
  }, [site.preview_url]);

  const [values, setValues] = useState<DraftMap>(initialValues);
  // Reine Live-Werte (ohne Drafts) – Vergleichsbasis für Undo + Diff.
  // Nach erfolgreichem Publish werden sie auf den neuen Stand gesetzt.
  const [liveMap, setLiveMap] = useState<DraftMap>(initialLiveValues);
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(
    () => new Set(draftFields)
  );
  const [status, setStatus] = useState<SaveStatus>(
    draftFields.length > 0 ? "saved" : "live"
  );
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [publishing, setPublishing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [codeDraftFiles, setCodeDraftFiles] = useState<string[]>([]);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [activeTab, setActiveTab] = useState<"content" | "blog">("content");
  const [searchQuery, setSearchQuery] = useState("");
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [deployState, setDeployState] = useState<DeployState>("idle");
  // Handy-Ansicht: zwischen Formular und Vorschau umschalten (am PC immer Split-Screen)
  const [mobileView, setMobileView] = useState<"form" | "preview">("form");
  // Klick-Modus: true = Klick in der Vorschau sucht das Feld ("Finden"),
  // false = Klicks gehen normal auf Links ("Surfen")
  const [selectMode, setSelectMode] = useState(true);
  // Zuletzt angeklicktes Feld (wird kurz gelb markiert)
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const selectFlashRef = useRef<number | null>(null);
  // Timer für die Bau-Phase nach dem Veröffentlichen (wird beim Verlassen gelöscht)
  const deployTimerRef = useRef<number | null>(null);

  // Blog-Feature aktiviert? (features.blog === true oder features.blog.enabled === true)
  const blogEnabled = useMemo(() => {
    const blog = (manifest as CmsManifest | null)?.features?.blog;
    return blog === true || (typeof blog === "object" && blog?.enabled === true);
  }, [manifest]);

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

  // Suche: Sektionen/Felder filtern (Label, Key oder Sektions-Titel)
  const filteredSections = useMemo<ManifestSection[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sections;
    return sections
      .map((section) => {
        const sectionMatches = section.title.toLowerCase().includes(query);
        const fields = sectionMatches
          ? section.fields
          : (section.fields ?? []).filter(
              (f) =>
                f.label.toLowerCase().includes(query) ||
                f.id.toLowerCase().includes(query)
            );
        return { ...section, fields };
      })
      .filter((s) => s.fields.length > 0);
  }, [sections, searchQuery]);

  // Sektionen nach Seiten gruppieren (Startseite, Leistungen, Kontakt, Firmendaten …)
  const pages = useMemo<PageGroup[]>(() => {
    const map = new Map<string, PageGroup>();
    for (const section of sections) {
      const label = detectPageLabel(section);
      const existing = map.get(label);
      if (existing) {
        existing.sections.push(section);
      } else {
        map.set(label, { id: label.toLowerCase(), label, sections: [section] });
      }
    }
    return [...map.values()];
  }, [sections]);

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0] ?? null;
  const isSearching = searchQuery.trim() !== "";

  // Bei aktiver Suche über alle Seiten hinweg anzeigen, sonst nur die aktive Seite
  const visibleSections = useMemo<ManifestSection[]>(
    () => (isSearching ? filteredSections : (activePage?.sections ?? [])),
    [isSearching, filteredSections, activePage]
  );

  const selectPage = useCallback((page: PageGroup) => {
    setActivePageId(page.id);
    setSearchQuery("");
    // Erste Sektion der gewählten Seite aufklappen
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (page.sections[0]) next.add(page.sections[0].id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setOpenSections(new Set(visibleSections.map((s) => s.id)));
  }, [visibleSections]);

  const collapseAll = useCallback(() => {
    setOpenSections(new Set());
  }, []);

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
      if (selectFlashRef.current) window.clearTimeout(selectFlashRef.current);
      if (deployTimerRef.current) window.clearTimeout(deployTimerRef.current);
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

      // a) Sofortiges Live-Update an die Vorschau (nur an den konkreten Origin)
      if (previewOrigin) {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "CMS_FIELD_UPDATE", field: fieldId, value },
          previewOrigin
        );
      }

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
    [saveDraft, previewOrigin]
  );

  async function handlePublish() {
    setPublishing(true);
    // Phase 1: Übertragen läuft (Anfrage an den Server)
    setDeployState("sending");
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: site.id }),
      });
      const body = (await res.json()) as { error?: string; message?: string };

      if (!res.ok) {
        setDeployState("idle");
        pushToast("error", body.error ?? "Veröffentlichung fehlgeschlagen.");
        return;
      }

      setDirtyFields(new Set());
      setStatus("live");
      // Live-Vergleich auf den neuen Stand setzen (Undo/Diff danach wieder korrekt)
      setLiveMap({ ...values });
      // Verlaufs-Liste sofort neu laden lassen
      setHistoryRefresh((k) => k + 1);
      // Phase 2: Website wird neu aufgebaut (ca. 45–60 Sek.), danach Phase 3:
      // Fertig-Meldung + Vorschau automatisch neu laden
      setDeployState("building");
      if (deployTimerRef.current) window.clearTimeout(deployTimerRef.current);
      deployTimerRef.current = window.setTimeout(() => {
        setDeployState("done");
        if (iframeRef.current) {
          iframeRef.current.src = iframeRef.current.src;
        }
      }, 50_000);
      pushToast(
        "success",
        body.message ?? "Änderungen wurden übertragen. Die Website wird jetzt neu aufgebaut."
      );
    } catch {
      setDeployState("idle");
      pushToast("error", "Server nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      setPublishing(false);
    }
  }

  // Alle Felder flach für den KI-Chat (Kontext + Übernahme)
  const allFields = useMemo(
    () => sections.flatMap((s) => s.fields ?? []),
    [sections]
  );

  /** Geänderte Formular-Felder für den Diff-Inspektor (Live vs. Entwurf). */
  const changedFields = useMemo(
    () => allFields.filter((f) => (values[f.id] ?? "") !== (liveMap[f.id] ?? "")),
    [allFields, values, liveMap]
  );

  /** Freie Entwürfe (z. B. Banner) für den Diff-Inspektor. */
  const changedFreeDrafts = useMemo(
    () =>
      [...dirtyFields]
        .filter((id) => id.startsWith("json:"))
        .map((id) => {
          const rest = id.slice("json:".length);
          const sep = rest.indexOf(":");
          return {
            id,
            label: sep >= 0 ? rest.slice(sep + 1) : rest,
            oldValue: liveMap[id] ?? "",
            newValue: values[id],
          };
        }),
    [dirtyFields, liveMap, values]
  );

  const hasDrafts = dirtyFields.size > 0;

  /** Öffnet die echte Live-Website in einem neuen Tab. */
  const openLiveSite = useCallback(() => {
    window.open(site.preview_url, "_blank", "noopener");
  }, [site.preview_url]);

  /** Markiert einen KI-Entwurf als ungespeichert (Badge oben), ohne ins Formular zu schreiben. */
  const touchDraft = useCallback((fieldId: string) => {
    setDirtyFields((prev) => new Set(prev).add(fieldId));
    setStatus("saved");
  }, []);

  /** Lädt das komplette Website-Repo als .zip herunter (1-Klick-Backup). */
  async function handleBackup() {
    if (backupLoading) return;
    setBackupLoading(true);
    try {
      const res = await fetch(`/api/site/${site.id}/download-backup`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        pushToast("error", body?.error ?? "Backup konnte nicht erstellt werden.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${site.repo_name}-backup.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      pushToast("success", "Backup wurde heruntergeladen.");
    } catch {
      pushToast("error", "Server nicht erreichbar. Backup konnte nicht erstellt werden.");
    } finally {
      setBackupLoading(false);
    }
  }

  /** Setzt ein einzelnes Feld auf den Live-Stand zurück (Undo pro Feld). */
  const handleFieldUndo = useCallback(
    async (fieldId: string) => {
      const liveValue = liveMap[fieldId] ?? "";
      setValues((prev) => ({ ...prev, [fieldId]: liveValue }));
      setDirtyFields((prev) => {
        const next = new Set(prev);
        next.delete(fieldId);
        return next;
      });
      // Vorschau springt sofort auf den Live-Stand zurück
      if (previewOrigin) {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "CMS_FIELD_UPDATE", field: fieldId, value: liveValue },
          previewOrigin
        );
      }
      try {
        const supabase = createClient();
        await supabase.from("drafts").delete().eq("site_id", site.id).eq("field_id", fieldId);
      } catch {
        pushToast("error", "Entwurf konnte nicht aus der Datenbank gelöscht werden – bitte Seite neu laden.");
      }
    },
    [liveMap, previewOrigin, site.id, pushToast]
  );

  /** Öffnet den Diff-Inspektor und lädt zusätzlich offene Datei-Entwürfe. */
  const openDiff = useCallback(async () => {
    setDiffOpen(true);
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("code_drafts")
        .select("file_path")
        .eq("site_id", site.id);
      setCodeDraftFiles(((data ?? []) as Array<{ file_path: string }>).map((r) => r.file_path));
    } catch {
      setCodeDraftFiles([]);
    }
  }, [site.id]);

  // KI-Entwürfe wurden serverseitig bereits in drafts geupsertet.
  // Hier nur lokalen State & Live-Iframe aktualisieren (kein erneuter DB-Timer!).
  const handleAiFieldApplied = useCallback(
    (fieldId: string, value: string) => {
      setValues((prev) => ({ ...prev, [fieldId]: value }));
      setDirtyFields((prev) => new Set(prev).add(fieldId));
      setStatus("saved");

      if (previewOrigin) {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "CMS_FIELD_UPDATE", field: fieldId, value },
          previewOrigin
        );
      }
    },
    [previewOrigin]
  );

  /** Meldet der Vorschau ob Klicks Felder suchen (Finden) oder normal funktionieren (Surfen). */
  const sendSelectMode = useCallback(
    (enabled: boolean) => {
      if (previewOrigin) {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "CMS_SELECT_MODE", enabled },
          previewOrigin
        );
      }
    },
    [previewOrigin]
  );

  const toggleSelectMode = useCallback(
    (enabled: boolean) => {
      setSelectMode(enabled);
      sendSelectMode(enabled);
    },
    [sendSelectMode]
  );

  // Hört auf Klicks aus der Vorschau: Die Website schickt CMS_FIELD_SELECT
  // mit der Feld-ID, das CMS springt dann zum passenden Formularfeld.
  useEffect(() => {
    function onPreviewMessage(event: MessageEvent) {
      // Sicherheitscheck: nur Nachrichten aus der eigenen Vorschau annehmen
      if (previewOrigin && event.origin !== previewOrigin) return;
      const data = event.data as { type?: unknown; field?: unknown } | null;
      if (!data || data.type !== "CMS_FIELD_SELECT" || typeof data.field !== "string") {
        return;
      }
      const fieldId = data.field;

      // Feld im Manifest suchen (Seite + Sektion merken)
      let foundSection: ManifestSection | null = null;
      let foundPage: PageGroup | null = null;
      for (const page of pages) {
        for (const section of page.sections) {
          if ((section.fields ?? []).some((f) => f.id === fieldId)) {
            foundSection = section;
            foundPage = page;
            break;
          }
        }
        if (foundSection) break;
      }
      if (!foundSection || !foundPage) {
        pushToast("error", `Dieses Element ("${fieldId}") gibt es im Formular nicht.`);
        return;
      }

      // Formular an die richtige Stelle bringen: Reiter, Seite, aufklappen …
      setActiveTab("content");
      setSearchQuery("");
      setActivePageId(foundPage.id);
      const sectionId = foundSection.id;
      setOpenSections((prev) => new Set(prev).add(sectionId));
      // … dann hinscrollen und kurz gelb markieren
      window.setTimeout(() => {
        document
          .getElementById(`cms-field-${fieldId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
      setSelectedFieldId(fieldId);
      if (selectFlashRef.current) window.clearTimeout(selectFlashRef.current);
      selectFlashRef.current = window.setTimeout(() => setSelectedFieldId(null), 2200);
    }
    window.addEventListener("message", onPreviewMessage);
    return () => window.removeEventListener("message", onPreviewMessage);
  }, [previewOrigin, pages, pushToast]);

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
          <StatusBadge
            status={status}
            hasDrafts={hasDrafts}
            draftCount={dirtyFields.size}
            onOpenDiff={hasDrafts ? () => void openDiff() : undefined}
          />
          {site.ai_enabled && (
            <button
              onClick={() => setChatOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-violet-500"
            >
              <Sparkles className="h-4 w-4" />
              <span className="hidden sm:inline">KI-Chat</span>
            </button>
          )}
          <button
            onClick={() => setHistoryOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
          >
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">Verlauf</span>
          </button>
          <button
            onClick={() => void handleBackup()}
            disabled={backupLoading}
            title="Komplette Website als .zip herunterladen"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60"
          >
            {backupLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Backup (.zip)</span>
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

      {/* Handy-Umschalter: Bearbeiten <-> Vorschau (am PC immer beides nebeneinander) */}
      <div className="flex gap-1 border-b border-zinc-200 bg-white p-2 lg:hidden">
        <button
          onClick={() => setMobileView("form")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
            mobileView === "form"
              ? "bg-zinc-900 text-white"
              : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          <FileText className="h-4 w-4" />
          Bearbeiten
        </button>
        <button
          onClick={() => setMobileView("preview")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
            mobileView === "preview"
              ? "bg-zinc-900 text-white"
              : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          <Monitor className="h-4 w-4" />
          Vorschau
        </button>
      </div>

      {/* Split-Screen */}
      <div className="flex min-h-0 flex-1">
        {/* Linke Spalte: Formular */}
        <div
          className={`w-full min-w-0 flex-1 overflow-y-auto border-r border-zinc-200 bg-white lg:block lg:w-[40%] lg:flex-none ${
            mobileView === "form" ? "block" : "hidden"
          }`}
        >
          <div className="mx-auto max-w-xl px-6 py-6">
            {deployState !== "idle" && (
              <div
                className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
                  deployState === "sending"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : deployState === "building"
                      ? "border-blue-200 bg-blue-50 text-blue-800"
                      : "border-emerald-200 bg-emerald-50 text-emerald-800"
                }`}
              >
                {deployState === "sending" && (
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    <p className="font-medium">
                      🟡 Änderungen werden übertragen …
                    </p>
                  </div>
                )}
                {deployState === "building" && (
                  <div className="flex items-start gap-2">
                    <Rocket className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="flex-1">
                      <p className="font-medium">
                        🔵 Website wird neu aufgebaut (Dauer: ca. 45–60 Sek.) …
                      </p>
                      <p className="mt-1 text-blue-700/80">
                        Gleich ist alles fertig – die Vorschau lädt danach von
                        allein neu.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={openLiveSite}
                          className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-800 transition hover:bg-blue-100"
                        >
                          Live-Website öffnen
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={() => setDeployState("idle")}
                      className="opacity-60 transition hover:opacity-100"
                      aria-label="Hinweis schließen"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {deployState === "done" && (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <p className="flex-1 font-medium">
                      🟢 Fertig! Ihre Website ist jetzt weltweit aktualisiert.
                    </p>
                    <button
                      onClick={() => setDeployState("idle")}
                      className="opacity-60 transition hover:opacity-100"
                      aria-label="Hinweis schließen"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            )}

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

            {/* Tabs: nur wenn das Blog-Feature im Manifest aktiviert ist */}
            {blogEnabled && !manifestError && (
              <div className="mb-6 flex rounded-xl border border-zinc-200 bg-zinc-100 p-1">
                <button
                  onClick={() => setActiveTab("content")}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    activeTab === "content"
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  <FileText className="h-4 w-4" />
                  Seiten-Inhalte
                </button>
                <button
                  onClick={() => setActiveTab("blog")}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    activeTab === "blog"
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  <Newspaper className="h-4 w-4" />
                  Blog-Artikel
                </button>
              </div>
            )}

            {blogEnabled && activeTab === "blog" && !manifestError ? (
              <BlogPanel
                siteId={site.id}
                onError={pushErrorToast}
                onSuccess={(msg) => pushToast("success", msg)}
              />
            ) : (
              <>
                {/* Hinweis- & Urlaubsbanner (Schalter + Stil + Text, direkt über der Liste) */}
                {!manifestError && <BannerCard values={values} onChange={handleChange} />}
                {/* Suche + Akkordeon-Steuerung */}
                {!manifestError && sections.length > 0 && (
                  <div className="mb-5 space-y-3">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Feld suchen …"
                        className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={expandAll}
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700"
                      >
                        <ChevronsUpDown className="h-3.5 w-3.5" />
                        Alle aufklappen
                      </button>
                      <button
                        onClick={collapseAll}
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700"
                      >
                        <ChevronsDownUp className="h-3.5 w-3.5" />
                        Alle einklappen
                      </button>
                    </div>
                  </div>
                )}

                {/* Seiten-Tabs: Sektionen nach Seite gruppieren (bei Suche ausgeblendet) */}
                {!manifestError && !isSearching && pages.length > 1 && (
                  <div className="mb-5 flex flex-wrap gap-2">
                    {pages.map((page) => {
                      const isActive = activePage?.id === page.id;
                      return (
                        <button
                          key={page.id}
                          type="button"
                          onClick={() => selectPage(page)}
                          className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                            isActive
                              ? "bg-zinc-900 text-white shadow-sm"
                              : "border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                          }`}
                        >
                          {page.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {visibleSections.map((section) => {
                  // Bei aktiver Suche alle Treffer geöffnet anzeigen
                  const isOpen = isSearching || openSections.has(section.id);
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
                          {section?.title}{" "}
                          <span className="font-normal text-zinc-400">
                            ({section?.fields?.length ?? 0}{" "}
                            {section?.fields?.length === 1 ? "Feld" : "Felder"})
                          </span>
                        </span>
                        <ChevronDown
                          className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${
                            isOpen ? "rotate-180" : ""
                          }`}
                        />
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
                              selected={selectedFieldId === field.id}
                              changed={(values[field.id] ?? "") !== (liveMap[field.id] ?? "")}
                              onUndo={() => void handleFieldUndo(field.id)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}

                {!manifestError && isSearching && visibleSections.length === 0 && (
                  <p className="py-6 text-center text-sm text-zinc-500">
                    Keine Felder gefunden für &bdquo;{searchQuery.trim()}&ldquo;.
                  </p>
                )}

                {!manifestError && sections.length === 0 && (
                  <p className="text-sm text-zinc-500">
                    Das Manifest enthält keine bearbeitbaren Sektionen.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* Rechte Spalte: Vorschau (am Handy nur wenn "Vorschau" gewählt) */}
        <div
          className={`min-w-0 flex-1 flex-col lg:flex ${
            mobileView === "preview" ? "flex" : "hidden"
          }`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2">
            {/* Finden = Klick sucht das Feld, Surfen = Klicks gehen normal auf Links */}
            <div className="flex gap-1 rounded-lg bg-zinc-200/70 p-0.5">
              <button
                onClick={() => toggleSelectMode(true)}
                title="Klick auf die Website springt zum passenden Feld"
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  selectMode
                    ? "bg-zinc-900 text-white shadow-sm"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                Finden
              </button>
              <button
                onClick={() => toggleSelectMode(false)}
                title="Vorschau normal bedienen (Links anklickbar)"
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  !selectMode
                    ? "bg-zinc-900 text-white shadow-sm"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                Surfen
              </button>
            </div>
            <div className="flex items-center gap-2">
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
                // Nach jedem (Neu-)Laden der Vorschau den Klick-Modus erneut melden,
                // weil die Website beim Laden auf "Finden" zurücksetzt
                onLoad={() => sendSelectMode(selectMode)}
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

      {/* KI-Chat-Drawer (nur wenn für diese Website freigeschaltet) */}
      {site.ai_enabled && (
        <ChatDrawer
          siteId={site.id}
          fields={allFields}
          values={values}
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          onFieldApplied={handleAiFieldApplied}
          onDraftTouched={touchDraft}
          onError={pushErrorToast}
          onSuccess={(msg) => pushToast("success", msg)}
        />
      )}

      {/* Diff-Inspektor: Vorher/Nachher vor dem Veröffentlichen */}
      {diffOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-zinc-900/40"
            onClick={() => setDiffOpen(false)}
            aria-hidden
          />
          <div className="relative flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
              <h2 className="text-sm font-semibold text-zinc-900">
                Ausstehende Änderungen prüfen
              </h2>
              <button
                onClick={() => setDiffOpen(false)}
                className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100"
                aria-label="Schließen"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {changedFields.length === 0 && changedFreeDrafts.length === 0 && codeDraftFiles.length === 0 && (
                <p className="py-6 text-center text-sm text-zinc-500">
                  Keine ausstehenden Änderungen.
                </p>
              )}
              {changedFields.map((field) => {
                const oldValue = liveMap[field.id] ?? "";
                const newValue = values[field.id] ?? "";
                return (
                  <div key={field.id} className="rounded-xl border border-zinc-200 p-3">
                    <p className="text-xs font-semibold text-zinc-900">{field.label}</p>
                    <p className="mt-1.5 break-words text-xs text-zinc-400">
                      <span className="font-medium">Live: </span>
                      <span className="rounded bg-red-50 px-1 text-red-700 line-through">
                        {oldValue === "" ? "(leer)" : oldValue.slice(0, 300)}
                      </span>
                    </p>
                    <p className="mt-1 break-words text-xs text-zinc-600">
                      <span className="font-medium">Neu: </span>
                      <span className="rounded bg-emerald-50 px-1 text-emerald-800">
                        {newValue === "" ? "(leer)" : newValue.slice(0, 300)}
                      </span>
                    </p>
                  </div>
                );
              })}
              {changedFreeDrafts.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-zinc-200 p-3">
                  <p className="text-xs font-semibold text-zinc-900">{entry.label}</p>
                  <p className="mt-1.5 break-words text-xs text-zinc-400">
                    <span className="font-medium">Live: </span>
                    <span className="rounded bg-red-50 px-1 text-red-700 line-through">
                      {entry.oldValue === "" ? "(leer)" : entry.oldValue.slice(0, 300)}
                    </span>
                  </p>
                  <p className="mt-1 break-words text-xs text-zinc-600">
                    <span className="font-medium">Neu: </span>
                    <span className="rounded bg-emerald-50 px-1 text-emerald-800">
                      {entry.newValue == null || entry.newValue === ""
                        ? "(Entwurf gespeichert)"
                        : entry.newValue.slice(0, 300)}
                    </span>
                  </p>
                </div>
              ))}
              {codeDraftFiles.length > 0 && (
                <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3">
                  <p className="text-xs font-semibold text-violet-900">
                    Datei-Entwürfe ({codeDraftFiles.length})
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {codeDraftFiles.map((f) => (
                      <li key={f} className="truncate font-mono text-[11px] text-violet-700">
                        {f}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] text-violet-600">
                    Design- und Datei-Änderungen siehst du nach dem Veröffentlichen in der Vorschau.
                  </p>
                </div>
              )}
            </div>
            <div className="flex gap-2 border-t border-zinc-200 px-5 py-4">
              <button
                onClick={() => setDiffOpen(false)}
                className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
              >
                Schließen
              </button>
              <button
                onClick={() => {
                  setDiffOpen(false);
                  void handlePublish();
                }}
                disabled={publishing || (!hasDrafts && codeDraftFiles.length === 0)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60"
              >
                {publishing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Rocket className="h-4 w-4" />
                )}
                Jetzt veröffentlichen
              </button>
            </div>
          </div>
        </div>
      )}

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

/** Unaufdringlicher Zurücksetzen-Knopf pro Feld (Undo auf Live-Stand). */
function UndoButton({ onUndo }: { onUndo: () => void }) {
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

const BANNER_FILE = "src/content/site.json";
const BANNER_ENABLED_ID = `json:${BANNER_FILE}:site.banner.enabled`;
const BANNER_VARIANT_ID = `json:${BANNER_FILE}:site.banner.variant`;
const BANNER_TEXT_ID = `json:${BANNER_FILE}:site.banner.text`;

const BANNER_VARIANTS = [
  { id: "vacation", label: "🟡 Betriebsurlaub", pill: "bg-amber-500 text-white border-amber-500" },
  { id: "emergency", label: "🔴 Dringend / Notfall", pill: "bg-red-500 text-white border-red-500" },
  { id: "info", label: "🔵 Information", pill: "bg-blue-500 text-white border-blue-500" },
] as const;

/** Hinweis- & Urlaubsbanner: Schalter, Stil und Text – schreibt direkt Entwürfe. */
function BannerCard({
  values,
  onChange,
}: {
  values: DraftMap;
  onChange: (fieldId: string, value: string) => void;
}) {
  const enabled = (values[BANNER_ENABLED_ID] ?? "") === "true";
  const variant = values[BANNER_VARIANT_ID] ?? "vacation";
  const text = values[BANNER_TEXT_ID] ?? "";

  return (
    <div className="mb-4 rounded-2xl border border-zinc-200 bg-zinc-50/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-zinc-900">
          Hinweisbanner auf der Website anzeigen
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onChange(BANNER_ENABLED_ID, enabled ? "false" : "true")}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
            enabled ? "bg-emerald-500" : "bg-zinc-300"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
              enabled ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <p className={`mt-0.5 text-xs font-medium ${enabled ? "text-emerald-700" : "text-zinc-400"}`}>
        {enabled ? "AN" : "AUS"}
      </p>

      {enabled && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {BANNER_VARIANTS.map((v) => {
              const active = variant === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onChange(BANNER_VARIANT_ID, v.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                    active
                      ? v.pill
                      : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100"
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
          <div>
            <input
              type="text"
              value={text}
              maxLength={160}
              onChange={(e) => onChange(BANNER_TEXT_ID, e.target.value)}
              placeholder="Wir sind vom 01. bis 15. August im Betriebsurlaub."
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
            />
            <p className="mt-1 text-right text-xs text-zinc-400">
              {text.length} / 160 Zeichen
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldEditor({
  field,
  value,
  siteId,
  onChange,
  onError,
  selected,
  changed,
  onUndo,
}: {
  field: ManifestField;
  value: string;
  siteId: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
  /** true wenn das Feld gerade per Klick in der Vorschau ausgewählt wurde */
  selected: boolean;
  /** true wenn der Wert vom Live-Stand abweicht (Undo anbieten) */
  changed: boolean;
  onUndo: () => void;
}) {
  const baseClass =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";

  const counter = field.maxLength
    ? `${value.length} / ${field.maxLength} Zeichen`
    : `${value.length} Zeichen`;
  const counterTooLong = field.maxLength != null && value.length > field.maxLength;

  // Anker-ID für "Klick in Vorschau springt hierher" + kurze Gelb-Markierung
  return (
    <div
      id={`cms-field-${field.id}`}
      className={`scroll-mt-4 rounded-xl transition ${
        selected ? "bg-blue-50 p-3 ring-2 ring-blue-600" : ""
      }`}
    >
      {field.type === "image" ? (
        <>
          {changed && (
            <div className="mb-2 flex justify-end">
              <UndoButton onUndo={onUndo} />
            </div>
          )}
          <ImageField
            field={field}
            value={value}
            siteId={siteId}
            onChange={onChange}
            onError={onError}
          />
        </>
      ) : (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label className="block text-sm font-medium text-zinc-700">
              {field.label}
            </label>
            {changed && <UndoButton onUndo={onUndo} />}
          </div>

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

          {["number", "email", "phone", "url", "date"].includes(field.type) && (
            <input
              type={field.type === "phone" ? "tel" : field.type}
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
      )}
    </div>
  );
}
