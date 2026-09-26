"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { HistoryDrawer } from "@/components/editor/HistoryDrawer";
import { ChatDrawer } from "@/components/editor/ChatDrawer";
import { BlogPanel } from "@/components/editor/BlogPanel";
import { StatusBadge } from "@/components/editor/StatusBadge";
import type { SaveStatus } from "@/components/editor/StatusBadge";
import { BannerCard } from "@/components/editor/BannerCard";
import { FieldEditor } from "@/components/editor/FieldEditor";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  FileText,
  History,
  Loader2,
  Monitor,
  Newspaper,
  Rocket,
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

type Viewport = "desktop" | "mobile";

interface EditorClientProps {
  site: Site;
  manifest: CmsManifest | null;
  manifestError: string | null;
  /** W16: Stille Manifest-Deutungen (steht sonst nirgends) */
  manifestWarnings?: string[];
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

type DeployState = "idle" | "sending" | "building" | "done" | "failed" | "slow";

/** Bekannte Seiten-Präfixe (Sektions-ID/Titel oder Dateiname) -> Tab-Label */
const PAGE_KEYWORDS: [RegExp, string][] = [
  [/home|startseite|index/i, "Startseite"],
  [/about|über|ueber/i, "Über uns"],
  [/service|leistung/i, "Leistungen"],
  [/contact|kontakt/i, "Kontakt"],
  [/blog/i, "Blog"],
  [/site|global|firma|footer|header|settings/i, "Firmendaten"],
];

/** Nur http(s)-Vorschau-Adressen sind erlaubt – niemals javascript:, data: o. ä. */
function isSafePreviewUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.protocol === "http:") {
      const host = url.hostname;
      if (host !== "localhost" && host !== "127.0.0.1") return false;
    }
    return url.hostname !== "";
  } catch {
    return false;
  }
}

/** Feld-IDs aus der Vorschau: Zeichenbegrenzung gegen Selektor-Injection. */
function isSafeFieldId(fieldId: string): boolean {
  return (
    fieldId.length >= 1 &&
    fieldId.length <= 200 &&
    !/[<>"'`\s]/.test(fieldId)
  );
}

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
  manifestWarnings = [],
  contentWarning,
  initialValues,
  liveValues: initialLiveValues,
  draftFields,
}: EditorClientProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const pendingRef = useRef(0);
  // Noch ungespeicherte Tipp-Stände je Feld (für garantierten Flush vor Publish)
  const pendingValuesRef = useRef<Map<string, string>>(new Map());
  // W11: Vorschau-Nachrichten bündeln – höchstens ein Schwung pro Frame,
  // damit schnelles Tippen das Iframe nicht flutet (fühlt sich gleich an).
  const previewQueueRef = useRef<Map<string, string>>(new Map());
  const previewRafRef = useRef<number | null>(null);

  // Vorschau-Adresse hart geprüft: Nur http(s) – bei ungültiger Adresse ist
  // die Vorschau deaktiviert (statt Nachrichten von allen Origins anzunehmen).
  const previewUrlSafe = useMemo(() => isSafePreviewUrl(site.preview_url), [site.preview_url]);

  // Konkreter Origin der Vorschau-Website für postMessage (statt "*")
  const previewOrigin = useMemo(() => {
    if (!previewUrlSafe) return null;
    try {
      return new URL(site.preview_url).origin;
    } catch {
      return null;
    }
  }, [site.preview_url, previewUrlSafe]);

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
  // true, während noch ungespeicherte Tipp-Stände geschrieben werden (B4-Flush)
  const [flushing, setFlushing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [codeDraftFiles, setCodeDraftFiles] = useState<string[]>([]);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Dauerhafter Veröffentlichungs-Fehler (bleibt stehen + kopierbar, bis der
  // nächste Versuch startet oder er geschlossen wird – Toasts verschwinden).
  const [publishError, setPublishError] = useState<{ title: string; details: string } | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
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
  // Echte Aufbau-Abfrage nach dem Veröffentlichen (wird beim Verlassen gestoppt)
  const deployPollRef = useRef<number | null>(null);
  // W11: Vorschau-Update einreihen (ein Schwung pro Animationsframe)
  const queuePreviewUpdate = useCallback(
    (fieldId: string, value: string) => {
      if (!previewOrigin) return;
      previewQueueRef.current.set(fieldId, value);
      if (previewRafRef.current !== null) return;
      previewRafRef.current = window.requestAnimationFrame(() => {
        previewRafRef.current = null;
        const frame = iframeRef.current?.contentWindow;
        if (!frame) {
          previewQueueRef.current.clear();
          return;
        }
        for (const [fid, val] of previewQueueRef.current) {
          frame.postMessage({ type: "CMS_FIELD_UPDATE", field: fid, value: val }, previewOrigin);
        }
        previewQueueRef.current.clear();
      });
    },
    [previewOrigin]
  );
  // W8: Parallele Tabs – neuester bekannter Entwurfs-Stempel + Warnung bei Fremdänderung
  const draftsBaselineRef = useRef<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  // W6: Nach Wiederherstellung frische Serverdaten laden + Formular weich zurücksetzen
  const [pendingRestore, setPendingRestore] = useState(false);
  const router = useRouter();

  // Neueste Entwurfs-Änderung dieser Site lesen (für W8-Vergleich)
  const readLatestDraftStamp = useCallback(async (): Promise<string | null> => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("drafts")
        .select("updated_at")
        .eq("site_id", site.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const stamp = (data as { updated_at?: string } | null)?.updated_at;
      return typeof stamp === "string" ? stamp : null;
    } catch {
      return null;
    }
  }, [site.id]);

  // W8: Basis-Stempel beim Öffnen merken, danach alle 20 s prüfen, ob ein
  // anderes Fenster/Tab Entwürfe gespeichert hat (eigene In-Flights ausblenden).
  useEffect(() => {
    let stopped = false;
    void readLatestDraftStamp().then((stamp) => {
      if (!stopped) draftsBaselineRef.current = stamp;
    });
    const timer = window.setInterval(async () => {
      if (stopped || document.hidden) return;
      if (pendingRef.current > 0 || timersRef.current.size > 0) return;
      const stamp = await readLatestDraftStamp();
      if (stopped || !stamp) return;
      if (draftsBaselineRef.current !== null && stamp > draftsBaselineRef.current) {
        draftsBaselineRef.current = stamp;
        setExternalChange(true);
      } else if (draftsBaselineRef.current === null) {
        draftsBaselineRef.current = stamp;
      }
    }, 20_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [readLatestDraftStamp]);

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

  // W6: Wiederherstellung ohne Reload – Serverdaten neu laden, dann das
  // Formular auf den frischen Stand setzen (Werte, Live-Vergleich, Drafts,
  // Vorschau). Laufende Autosave-Timer werden verworfen, damit keine alten
  // Tipp-Stände zurückgerollte Entwürfe wiederauferstehen lassen.
  const handleRestored = useCallback(
    (message: string) => {
      pushToast("success", message);
      setHistoryRefresh((k) => k + 1);
      setPendingRestore(true);
      router.refresh();
    },
    [pushToast, router]
  );

  useEffect(() => {
    if (!pendingRestore) return;
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
    pendingValuesRef.current.clear();
    setValues(initialValues);
    setLiveMap(initialLiveValues);
    setDirtyFields(new Set(draftFields));
    setStatus(draftFields.length > 0 ? "saved" : "live");
    setPublishError(null);
    setExternalChange(false);
    if (previewUrlSafe && iframeRef.current) {
      iframeRef.current.src = site.preview_url;
    }
    void readLatestDraftStamp().then((stamp) => {
      draftsBaselineRef.current = stamp;
    });
    setPendingRestore(false);
  }, [pendingRestore, initialValues, initialLiveValues, draftFields, previewUrlSafe, site.preview_url, readLatestDraftStamp]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      if (previewRafRef.current !== null) window.cancelAnimationFrame(previewRafRef.current);
      if (selectFlashRef.current) window.clearTimeout(selectFlashRef.current);
      if (deployPollRef.current) window.clearInterval(deployPollRef.current);
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
    async (fieldId: string, value: string): Promise<boolean> => {
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
          return false;
        }
        // W8: Eigene Speicherung als Basis merken (kein Fremd-Alarm dafür)
        void readLatestDraftStamp().then((stamp) => {
          if (stamp) draftsBaselineRef.current = stamp;
        });
        return true;
      } catch {
        pushToast("error", "Supabase ist nicht erreichbar. Änderung wurde nicht gespeichert.");
        return false;
      } finally {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (pendingRef.current === 0) {
          setStatus((prev) => (prev === "saving" ? "saved" : prev));
        }
      }
    },
    [site.id, pushToast, readLatestDraftStamp]
  );

  const handleChange = useCallback(
    (fieldId: string, value: string) => {
      setValues((prev) => ({ ...prev, [fieldId]: value }));
      setDirtyFields((prev) => new Set(prev).add(fieldId));
      // Noch ungespeicherten Stand merken (für garantierten Flush vor Publish)
      pendingValuesRef.current.set(fieldId, value);

      // a) Sofortiges Live-Update an die Vorschau (gebündelt pro Frame, W11)
      queuePreviewUpdate(fieldId, value);

      // b) Debounced Autosave (800ms)
      const existing = timersRef.current.get(fieldId);
      if (existing) clearTimeout(existing);
      setStatus("saving");
      timersRef.current.set(
        fieldId,
        setTimeout(() => {
          timersRef.current.delete(fieldId);
          pendingValuesRef.current.delete(fieldId);
          void saveDraft(fieldId, value);
        }, 800)
      );
    },
    [saveDraft, queuePreviewUpdate]
  );

  // Schreibt alle noch wartenden Tipp-Stände sofort (statt erst nach 800 ms).
  // Wird vor jedem Publish aufgerufen – so geht keine sichtbare Änderung verloren.
  const flushPendingDrafts = useCallback(async (): Promise<boolean> => {
    const pending: Array<[string, string]> = [];
    for (const [fieldId, timer] of timersRef.current) {
      window.clearTimeout(timer);
      const value = pendingValuesRef.current.get(fieldId);
      if (value !== undefined) pending.push([fieldId, value]);
    }
    timersRef.current.clear();
    pendingValuesRef.current.clear();
    if (pending.length === 0) return true;
    const results = await Promise.all(pending.map(([fieldId, value]) => saveDraft(fieldId, value)));
    return results.every(Boolean);
  }, [saveDraft]);

  async function handlePublish() {
    setPublishing(true);
    setPublishError(null);
    setErrorCopied(false);
    // B4: Erst alle noch wartenden Tipp-Stände speichern – sonst ginge die
    // letzte Eingabe (< 800 ms alt) beim sofortigen Publish verloren.
    if (timersRef.current.size > 0) {
      setFlushing(true);
      const flushed = await flushPendingDrafts();
      setFlushing(false);
      if (!flushed) {
        setPublishing(false);
        setDeployState("idle");
        setPublishError({
          title: "Noch nicht gespeichert.",
          details:
            "Mindestens eine Änderung konnte gerade nicht als Entwurf gespeichert werden (siehe Meldung unten rechts). Bitte kurz warten und erneut auf „Veröffentlichen“ klicken – es ging nichts verloren.",
        });
        return;
      }
    }
    // Phase 1: Übertragen läuft (Anfrage an den Server)
    setDeployState("sending");
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: site.id }),
      });
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        commitSha?: string | null;
        publishedFieldIds?: string[];
        publishedFiles?: string[];
        blocked?: Array<{ file: string; errors: string[] }>;
        failed?: Array<{ file: string; error: string }>;
        partial?: boolean;
      };

      if (!res.ok) {
        setDeployState("idle");
        const details = body.error ?? "Veröffentlichung fehlgeschlagen.";
        // Kein Toast unten rechts mehr – die dauerhafte Box oben zeigt den
        // Fehler in Ruhe (inkl. Kopieren-Button).
        setPublishError({ title: "Veröffentlichung fehlgeschlagen.", details });
        return;
      }

      // Teilveröffentlichung: Nur bestätigte Felder gelten als live, der Rest
      // bleibt als Entwurf erhalten (dirty) und wird namentlich genannt.
      const published = new Set(body.publishedFieldIds ?? [...dirtyFields]);
      setDirtyFields((prev) => new Set([...prev].filter((id) => !published.has(id))));
      setLiveMap((prev) => {
        const next = { ...prev };
        for (const id of published) {
          if (values[id] !== undefined) next[id] = values[id];
        }
        return next;
      });
      setStatus("live");
      // Verlaufs-Liste sofort neu laden lassen
      setHistoryRefresh((k) => k + 1);
      // B5: Teil-Erfolg ehrlich zeigen – kein stiller „Erfolg", wenn Dateien
      // zurückgehalten wurden oder Commits fehlschlugen.
      const blockedCount = body.blocked?.length ?? 0;
      const failedCount = body.failed?.length ?? 0;
      const isPartial = body.partial === true || blockedCount > 0 || failedCount > 0;
      if (!isPartial) {
        pushToast(
          "success",
          body.message ?? "Änderungen wurden übertragen. Die Website wird jetzt neu aufgebaut."
        );
      } else {
        pushToast(
          "error",
          `Teils veröffentlicht (${(body.publishedFiles ?? []).length} Datei(en) live, ${blockedCount + failedCount} zurückgehalten) – Details stehen oben in der Box.`
        );
      }
      const heldBack: string[] = [];
      if (body.blocked && body.blocked.length > 0) {
        heldBack.push(
          body.blocked
            .map((b) => `${b.file}:\n- ${(b.errors ?? []).join("\n- ")}`)
            .join("\n\n")
        );
      }
      if (body.failed && body.failed.length > 0) {
        heldBack.push(
          body.failed.map((f) => `${f.file}:\n- ${f.error}`).join("\n\n")
        );
      }
      if (heldBack.length > 0) {
        setPublishError({
          title: isPartial ? "Teils veröffentlicht – zurückgehalten:" : "Zurückgehalten:",
          details: heldBack.join("\n\n"),
        });
      }

      // Echter Aufbau-Check: alle 10 Sekunden bei GitHub nachfragen, was Vercel
      // zu dieser Version meldet (läuft / fertig / fehlgeschlagen). Nach 3 Minuten
      // ohne Antwort ehrlich sagen dass es länger dauert statt etwas zu behaupten.
      if (deployPollRef.current) window.clearInterval(deployPollRef.current);
      if (!body.commitSha) {
        setDeployState("slow");
        return;
      }
      setDeployState("building");
      const sha = body.commitSha;
      let tries = 0;
      const poll = async () => {
        tries += 1;
        try {
          const statusRes = await fetch(
            `/api/site/${site.id}/deploy-status?sha=${encodeURIComponent(sha)}`
          );
          const statusBody = (await statusRes.json()) as { state?: string };
          if (statusBody.state === "success") {
            if (deployPollRef.current) window.clearInterval(deployPollRef.current);
            deployPollRef.current = null;
            setDeployState("done");
            if (iframeRef.current) {
              iframeRef.current.src = iframeRef.current.src;
            }
            return;
          }
          if (statusBody.state === "failure" || statusBody.state === "error") {
            if (deployPollRef.current) window.clearInterval(deployPollRef.current);
            deployPollRef.current = null;
            setDeployState("failed");
            return;
          }
        } catch {
          // Netzfehler beim Abfragen: einfach weiter versuchen
        }
        if (tries >= 18) {
          if (deployPollRef.current) window.clearInterval(deployPollRef.current);
          deployPollRef.current = null;
          setDeployState("slow");
        }
      };
      deployPollRef.current = window.setInterval(() => void poll(), 10_000);
      // Erste Abfrage sofort (nicht erst nach 10 Sekunden)
      void poll();
    } catch {
      setDeployState("idle");
      setPublishError({
        title: "Server nicht erreichbar.",
        details: "Server nicht erreichbar. Bitte später erneut versuchen.",
      });
    } finally {
      setPublishing(false);
    }
  }

  /** Fehlertext in die Zwischenablage kopieren (mit Fallback für alte Browser). */
  async function copyPublishError() {
    if (!publishError) return;
    const text = `${publishError.title}\n${publishError.details}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    setErrorCopied(true);
    window.setTimeout(() => setErrorCopied(false), 2000);
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

  /** Öffnet die echte Live-Website in einem neuen Tab (nur sichere Adressen). */
  const openLiveSite = useCallback(() => {
    if (!previewUrlSafe) {
      pushToast("error", "Die Vorschau-Adresse ist ungültig und wird nicht geöffnet.");
      return;
    }
    window.open(site.preview_url, "_blank", "noopener");
  }, [site.preview_url, previewUrlSafe, pushToast]);

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
      const safeDownloadName =
        site.repo_name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 100) ||
        "website";
      a.download = `${safeDownloadName}-backup.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      pushToast("success", "Gesichert! Deine Website gehört dir – lade sie jederzeit herunter und nimm sie mit.");
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
      queuePreviewUpdate(fieldId, liveValue);
      try {
        const supabase = createClient();
        await supabase.from("drafts").delete().eq("site_id", site.id).eq("field_id", fieldId);
      } catch {
        pushToast("error", "Entwurf konnte nicht aus der Datenbank gelöscht werden – bitte Seite neu laden.");
      }
    },
    [liveMap, queuePreviewUpdate, site.id, pushToast]
  );

  /** Öffnet den Diff-Inspektor und lädt zusätzlich offene Datei-Entwürfe. */
  const openDiff = useCallback(async () => {
    setDiffOpen(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("code_drafts")
        .select("file_path")
        .eq("site_id", site.id);
      if (error) {
        pushToast("error", "Datei-Entwürfe konnten nicht geladen werden – die Liste ist ggf. unvollständig.");
        setCodeDraftFiles([]);
        return;
      }
      setCodeDraftFiles(((data ?? []) as Array<{ file_path: string }>).map((r) => r.file_path));
    } catch {
      pushToast("error", "Datei-Entwürfe konnten nicht geladen werden – die Liste ist ggf. unvollständig.");
      setCodeDraftFiles([]);
    }
  }, [site.id, pushToast]);

  // KI-Entwürfe wurden serverseitig bereits in drafts geupsertet.
  // Hier nur lokalen State & Live-Iframe aktualisieren (kein erneuter DB-Timer!).
  const handleAiFieldApplied = useCallback(
    (fieldId: string, value: string) => {
      setValues((prev) => ({ ...prev, [fieldId]: value }));
      setDirtyFields((prev) => new Set(prev).add(fieldId));
      setStatus("saved");

      queuePreviewUpdate(fieldId, value);
    },
    [queuePreviewUpdate]
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
    // B3: Bei ungültiger Vorschau-Adresse ist der Empfang deaktiviert – sonst
    // würde der Check unten („alle Origins erlauben") fremde Websites durchlassen.
    if (!previewOrigin) return;
    function onPreviewMessage(event: MessageEvent) {
      // Sicherheitscheck: nur Nachrichten aus der eigenen Vorschau annehmen –
      // erwarteter Origin UND erwartetes Fenster (das eingebettete Iframe).
      if (event.origin !== previewOrigin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; field?: unknown } | null;
      if (!data || data.type !== "CMS_FIELD_SELECT" || typeof data.field !== "string") {
        return;
      }
      // Feld-ID vor der Verarbeitung validieren (Selektor-Injection abwehren)
      if (!isSafeFieldId(data.field)) return;
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
            title="Deine Website gehört dir: Lade sie jederzeit als .zip herunter und nimm sie mit, wohin du willst – keine Bindung, kein Lock-in."
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60"
          >
            {backupLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Meine Website (.zip)</span>
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
            {flushing ? "Speichern …" : publishing ? "Veröffentlichen …" : "Veröffentlichen"}
          </button>
        </div>
      </header>

      {/* Dauerhafte Fehlerbox: bleibt stehen + kopierbar (Toasts verschwinden) */}
      {publishError && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-3">
          <div className="mx-auto flex max-w-6xl items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-red-800">{publishError.title}</p>
              <pre className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-red-200 bg-white px-3 py-2 font-mono text-xs text-red-900">
                {publishError.details}
              </pre>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void copyPublishError()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {errorCopied ? "Kopiert ✓" : "Fehler kopieren"}
                </button>
                <button
                  type="button"
                  onClick={() => setPublishError(null)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-100"
                >
                  <X className="h-3.5 w-3.5" />
                  Schließen
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* W8: Hinweis bei Änderungen aus anderem Tab/Fenster (kein stiller Verlust) */}
      {externalChange && (
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-3">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <p className="min-w-0 flex-1 text-sm text-amber-900">
              <span className="font-semibold">In einem anderen Fenster wurde gespeichert.</span>{" "}
              Deine Ansicht ist möglicherweise veraltet – neu laden übernimmt den fremden Stand
              (eigene ungespeicherte Eingaben dabei zuerst veröffentlichen oder kopieren).
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
            >
              Neu laden
            </button>
            <button
              type="button"
              onClick={() => setExternalChange(false)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
            >
              Ignorieren
            </button>
          </div>
        </div>
      )}

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
                    : deployState === "building" || deployState === "slow"
                      ? "border-blue-200 bg-blue-50 text-blue-800"
                      : deployState === "failed"
                        ? "border-red-200 bg-red-50 text-red-800"
                        : "border-emerald-200 bg-emerald-50 text-emerald-800"
                }`}
              >
                {deployState === "sending" && (
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    <p className="font-medium">
                      Änderungen werden übertragen …
                    </p>
                  </div>
                )}
                {deployState === "building" && (
                  <div className="flex items-start gap-2">
                    <Loader2 className="h-4 w-4 mt-0.5 shrink-0 animate-spin" />
                    <div className="flex-1">
                      <p className="font-medium">
                        Übertragen! Die Website wird gerade neu aufgebaut …
                      </p>
                      <p className="mt-1 text-blue-700/80">
                        Ich prüfe den echten Stand und melde mich, sobald alles
                        live ist – du musst nichts tun.
                      </p>
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
                {deployState === "slow" && (
                  <div className="flex items-start gap-2">
                    <Rocket className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="flex-1">
                      <p className="font-medium">
                        Übertragen! Der Aufbau dauert diesmal länger als sonst.
                      </p>
                      <p className="mt-1 text-blue-700/80">
                        Deine Änderungen sind gespeichert. Schau einfach in ein
                        paar Minuten auf deine Website und lade sie neu – oder
                        lade gleich hier die Vorschau neu.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={() => {
                            if (iframeRef.current) {
                              iframeRef.current.src = iframeRef.current.src;
                            }
                          }}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
                        >
                          Vorschau neu laden
                        </button>
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
                {deployState === "failed" && (
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="flex-1">
                      <p className="font-medium">
                        Der Aufbau ist fehlgeschlagen – deine Website zeigt
                        weiter den alten Stand.
                      </p>
                      <p className="mt-1 text-red-700/80">
                        Deine Änderungen sind als Entwurf gespeichert und nichts
                        ist verloren. Versuche es erneut oder melde dich bei
                        deiner Agentur.
                      </p>
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
                      Fertig! Deine Website ist jetzt überall aktualisiert –
                      die Vorschau wurde neu geladen.
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

            {/* W16: Stille Manifest-Deutungen – Tippfehler der Website fallen auf */}
            {!manifestError && manifestWarnings.length > 0 && (
              <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-semibold">
                      Feldliste mit {manifestWarnings.length} Hinweis{manifestWarnings.length === 1 ? "" : "en"} geladen
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {manifestWarnings.slice(0, 5).map((h, i) => (
                        <li key={i} className="break-words">{h}</li>
                      ))}
                      {manifestWarnings.length > 5 && (
                        <li>+ {manifestWarnings.length - 5} weitere … (Details stehen im Website-Repo in src/content/cms.manifest.json)</li>
                      )}
                    </ul>
                    <p className="mt-1">Bitte die Agentur bitten, die Feldliste zu prüfen – es wurde nichts gelöscht, nur gedeutet.</p>
                  </div>
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
              {previewUrlSafe ? (
                <iframe
                  ref={iframeRef}
                  src={site.preview_url}
                  title={`Vorschau: ${site.name}`}
                  className="h-full w-full"
                  // Nach jedem (Neu-)Laden der Vorschau den Klick-Modus erneut melden,
                  // weil die Website beim Laden auf "Finden" zurücksetzt
                  onLoad={() => sendSelectMode(selectMode)}
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
                  <p className="text-sm font-semibold text-red-700">
                    Vorschau deaktiviert
                  </p>
                  <p className="max-w-sm text-xs text-zinc-600">
                    Die hinterlegte Vorschau-Adresse ist ungültig (erlaubt: https bzw.
                    lokal http://localhost). Bitte die Agentur um Korrektur – aus
                    Sicherheit werden keine Nachrichten mit unbekannten Seiten
                    ausgetauscht.
                  </p>
                </div>
              )}
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
        onSuccess={handleRestored}
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
