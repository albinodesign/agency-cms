"use client";

import { useRef, useState } from "react";
import { ImageField } from "@/components/editor/ImageField";
import { slugify } from "@/lib/slugify";
import {
  Bold,
  Heading2,
  Heading3,
  Italic,
  List,
  Loader2,
  X,
} from "lucide-react";
import type { BlogPost } from "@/types/cms";

interface BlogEditorModalProps {
  siteId: string;
  /** Vorhandener Beitrag (Bearbeiten) oder null (Neuer Beitrag) */
  post: BlogPost | null;
  /** Bei Bearbeitung: der geladene Markdown-Body */
  initialContent: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BlogEditorModal({
  siteId,
  post,
  initialContent,
  onClose,
  onSaved,
  onError,
}: BlogEditorModalProps) {
  const [title, setTitle] = useState(post?.title ?? "");
  const [slug, setSlug] = useState(post?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(post !== null);
  const [date, setDate] = useState(post?.date || todayIso());
  const [coverImage, setCoverImage] = useState(post?.coverImage ?? "");
  const [excerpt, setExcerpt] = useState(post?.excerpt ?? "");
  const [draft, setDraft] = useState(post?.draft ?? false);
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  function handleTitleChange(value: string) {
    setTitle(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
  }

  /** Markdown-Schnellformatierung an der Cursorposition einfügen. */
  function insertFormat(kind: "h2" | "h3" | "bold" | "italic" | "list") {
    const textarea = contentRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = content.slice(start, end);

    let insertion: string;
    switch (kind) {
      case "h2":
        insertion = `\n## ${selected || "Überschrift"}\n`;
        break;
      case "h3":
        insertion = `\n### ${selected || "Überschrift"}\n`;
        break;
      case "bold":
        insertion = `**${selected || "fetter Text"}**`;
        break;
      case "italic":
        insertion = `*${selected || "kursiver Text"}*`;
        break;
      case "list":
        insertion = `\n- ${selected || "Listenpunkt"}\n- \n- \n`;
        break;
    }

    const next = content.slice(0, start) + insertion + content.slice(end);
    setContent(next);
    // Fokus zurück ins Textfeld
    window.setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
    }, 0);
  }

  async function handleSave() {
    if (!title.trim()) {
      onError("Bitte einen Titel eingeben.");
      return;
    }
    const finalSlug = slugify(slug || title);
    if (!finalSlug) {
      onError("Der Slug ist ungültig.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/blog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId,
          slug: finalSlug,
          frontmatter: { title: title.trim(), date, coverImage, excerpt, draft },
          content,
        }),
      });
      const body = (await res.json()) as { error?: string; message?: string };

      if (!res.ok) {
        onError(body.error ?? "Beitrag konnte nicht gespeichert werden.");
        return;
      }

      onSaved(body.message ?? "Beitrag wurde gespeichert.");
    } catch {
      onError("Server nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";

  const formatButtons = [
    { kind: "h2" as const, icon: Heading2, label: "H2" },
    { kind: "h3" as const, icon: Heading3, label: "H3" },
    { kind: "bold" as const, icon: Bold, label: "Fett" },
    { kind: "italic" as const, icon: Italic, label: "Kursiv" },
    { kind: "list" as const, icon: List, label: "Aufzählung" },
  ];

  return (
    <div className="fixed inset-0 z-40">
      <div
        className="absolute inset-0 bg-zinc-900/40"
        onClick={onClose}
        aria-hidden
      />

      <aside className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            {post ? "Beitrag bearbeiten" : "Neuer Beitrag"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100"
            aria-label="Schließen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-700">
              Titel
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="z. B. 5 Tipps für Ihr neues Bad"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700">
                Slug
              </label>
              <input
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugEdited(true);
                }}
                placeholder="5-tipps-fuer-ihr-neues-bad"
                className={`${inputClass} font-mono text-xs`}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700">
                Datum
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <ImageField
            field={{
              id: "blog.coverImage",
              label: "Beitragsbild",
              type: "image",
              file: "",
              path: "",
            }}
            value={coverImage}
            siteId={siteId}
            onChange={setCoverImage}
            onError={onError}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-700">
              Kurzbeschreibung
            </label>
            <textarea
              value={excerpt}
              onChange={(e) => setExcerpt(e.target.value)}
              rows={3}
              placeholder="Kurze Zusammenfassung des Beitrags …"
              className={`${inputClass} resize-y`}
            />
          </div>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
            <span className="text-sm font-medium text-zinc-700">
              Als Entwurf speichern (noch nicht öffentlich)
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={draft}
              onClick={() => setDraft((d) => !d)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                draft ? "bg-amber-500" : "bg-zinc-300"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                  draft ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </label>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-700">
              Inhalt
            </label>
            <div className="mb-2 flex gap-1">
              {formatButtons.map(({ kind, icon: Icon, label }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => insertFormat(kind)}
                  title={label}
                  className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <textarea
              ref={contentRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={14}
              placeholder="Hier den Artikeltext schreiben …"
              className={`${inputClass} resize-y font-mono text-xs leading-relaxed`}
            />
          </div>
        </div>

        <div className="flex gap-2 border-t border-zinc-200 px-5 py-4">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60"
          >
            Abbrechen
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "Speichern …" : "Beitrag speichern & veröffentlichen"}
          </button>
        </div>
      </aside>
    </div>
  );
}
