"use client";

import { useCallback, useEffect, useState } from "react";
import { BlogEditorModal } from "@/components/editor/BlogEditorModal";
import {
  FileText,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { BlogPost } from "@/types/cms";

interface BlogPanelProps {
  siteId: string;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

interface EditorState {
  post: BlogPost | null;
  content: string;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function BlogPanel({ siteId, onError, onSuccess }: BlogPanelProps) {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  const loadPosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/blog?siteId=${encodeURIComponent(siteId)}`);
      const body = (await res.json()) as { posts?: BlogPost[]; error?: string };
      if (!res.ok) {
        onError(body.error ?? "Blog-Artikel konnten nicht geladen werden.");
        return;
      }
      setPosts(body.posts ?? []);
    } catch {
      onError("Server nicht erreichbar. Blog-Artikel konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [siteId, onError]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  async function openEditor(post: BlogPost | null) {
    if (!post) {
      setEditor({ post: null, content: "" });
      return;
    }
    // Beim Bearbeiten den Markdown-Inhalt nachladen
    setEditorLoading(true);
    try {
      const res = await fetch(
        `/api/blog?siteId=${encodeURIComponent(siteId)}&path=${encodeURIComponent(post.path)}`
      );
      const body = (await res.json()) as { content?: string; error?: string };
      if (!res.ok) {
        onError(body.error ?? "Beitrag konnte nicht geladen werden.");
        return;
      }
      setEditor({ post, content: body.content ?? "" });
    } catch {
      onError("Server nicht erreichbar. Beitrag konnte nicht geladen werden.");
    } finally {
      setEditorLoading(false);
    }
  }

  async function handleDelete(post: BlogPost) {
    const confirmed = window.confirm(
      `Beitrag "${post.title}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`
    );
    if (!confirmed) return;

    setDeletingPath(post.path);
    try {
      const res = await fetch("/api/blog", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, path: post.path, sha: post.sha }),
      });
      const body = (await res.json()) as { error?: string; message?: string };

      if (!res.ok) {
        onError(body.error ?? "Beitrag konnte nicht gelöscht werden.");
        return;
      }

      onSuccess(body.message ?? "Beitrag wurde gelöscht.");
      await loadPosts();
    } catch {
      onError("Server nicht erreichbar. Beitrag konnte nicht gelöscht werden.");
    } finally {
      setDeletingPath(null);
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">Blog-Artikel</h2>
        <button
          onClick={() => void openEditor(null)}
          disabled={editorLoading}
          className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          Neuer Beitrag
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Lade Blog-Artikel …
        </div>
      )}

      {editorLoading && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Lade Beitrag …
        </div>
      )}

      {!loading && posts.length === 0 && (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-6 py-12 text-center">
          <FileText className="mx-auto mb-3 h-8 w-8 text-zinc-300" />
          <p className="text-sm text-zinc-500">
            Noch keine Artikel vorhanden.
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {posts.map((post) => (
          <li
            key={post.path}
            className="flex items-center gap-4 rounded-xl border border-zinc-200 bg-white p-4"
          >
            {post.coverImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={post.coverImage}
                alt={post.title}
                className="h-14 w-14 shrink-0 rounded-lg border border-zinc-200 object-cover"
              />
            ) : (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400">
                <FileText className="h-6 w-6" />
              </div>
            )}

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-zinc-900">
                {post.title}
              </p>
              <p className="truncate font-mono text-xs text-zinc-400">
                /{post.slug}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-xs text-zinc-500">
                  {formatDate(post.date)}
                </span>
                {post.draft ? (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    Entwurf
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    Veröffentlicht
                  </span>
                )}
              </div>
            </div>

            <div className="flex shrink-0 gap-1.5">
              <button
                onClick={() => void openEditor(post)}
                disabled={editorLoading}
                title="Bearbeiten"
                className="rounded-lg border border-zinc-300 p-2 text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-60"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => void handleDelete(post)}
                disabled={deletingPath !== null}
                title="Löschen"
                className="rounded-lg border border-red-200 p-2 text-red-600 transition hover:bg-red-50 disabled:opacity-60"
              >
                {deletingPath === post.path ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {editor && (
        <BlogEditorModal
          siteId={siteId}
          post={editor.post}
          initialContent={editor.content}
          onClose={() => setEditor(null)}
          onError={onError}
          onSaved={(message) => {
            setEditor(null);
            onSuccess(message);
            void loadPosts();
          }}
        />
      )}
    </div>
  );
}
