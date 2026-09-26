import { NextResponse } from "next/server";
import matter from "gray-matter";
import { z } from "zod";
import { requireSiteAccess } from "@/lib/auth";
import { createOctokit, githubFehlerGrund, isShaConflictError } from "@/lib/github";
import { slugify } from "@/lib/slugify";
import type { BlogPost } from "@/types/cms";
import type { Octokit } from "@octokit/rest";

const BLOG_DIR = "src/content/blog";

/** W9: Frontmatter-Grenzen – nichts Riesiges, nichts Skriptartiges. */
const MAX_BLOG_TITLE = 200;
const MAX_BLOG_EXCERPT = 500;
const MAX_BLOG_ALT = 200;
const MAX_BLOG_CONTENT = 100_000;

/** https-Adresse oder interne/relative Bildreferenz (niemals javascript:/data:). */
const coverImageSchema = z
  .string()
  .max(2000, "Das Beitragsbild ist zu lang (max. 2000 Zeichen).")
  .refine(
    (v) => {
      const t = v.trim();
      if (t === "") return true;
      try {
        const url = new URL(t);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return (
          t.startsWith("/") &&
          !t.startsWith("//") &&
          !t.includes("..") &&
          !/["'<>\\\s]/.test(t)
        );
      }
    },
    "Das Beitragsbild muss eine http(s)-Adresse oder ein interner Pfad (/bilder/…) sein."
  );

const blogFrontmatterSchema = z.object({
  title: z
    .string("Titel fehlt.")
    .trim()
    .min(1, "Titel fehlt.")
    .max(MAX_BLOG_TITLE, `Der Titel ist zu lang (max. ${MAX_BLOG_TITLE} Zeichen).`),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Das Datum braucht das Format JJJJ-MM-TT.")
    .refine((v) => !Number.isNaN(Date.parse(v)), "Das Datum ist kein gültiges Kalenderdatum.")
    .optional(),
  coverImage: coverImageSchema.optional().default(""),
  coverImageAlt: z
    .string()
    .max(MAX_BLOG_ALT, `Der Bild-Alt-Text ist zu lang (max. ${MAX_BLOG_ALT} Zeichen).`)
    .optional()
    .default(""),
  excerpt: z
    .string()
    .max(MAX_BLOG_EXCERPT, `Die Kurzbeschreibung ist zu lang (max. ${MAX_BLOG_EXCERPT} Zeichen).`)
    .optional()
    .default(""),
  draft: z.boolean().optional().default(false),
});

const blogPostSchema = z.object({
  frontmatter: blogFrontmatterSchema,
  content: z
    .string()
    .max(MAX_BLOG_CONTENT, "Der Artikeltext ist zu lang (max. 100.000 Zeichen).")
    .optional()
    .default(""),
});

/** Strikte Pfad-Whitelist: nur src/content/blog/<slug>.md mit [a-z0-9-] im Dateinamen. */
const VALID_BLOG_PATH = /^src\/content\/blog\/[a-z0-9-]+\.md$/;

function isValidBlogPath(path: string): boolean {
  return !path.includes("..") && VALID_BLOG_PATH.test(path);
}

/** Session + Site-Zugriff prüfen (zentral in src/lib/auth.ts). */
const authorize = requireSiteAccess;

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

/** Alle Markdown-Dateien des Blog-Ordners laden und parsen. */
async function listBlogPosts(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<BlogPost[]> {
  let entries;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: BLOG_DIR,
      ref: "main",
    });
    entries = data;
  } catch (err) {
    if (isNotFound(err)) return []; // Ordner existiert noch nicht
    throw err;
  }

  if (!Array.isArray(entries)) return [];

  const mdFiles = entries.filter(
    (e) => e.type === "file" && e.name.endsWith(".md")
  );

  const posts: BlogPost[] = [];
  for (const file of mdFiles) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: file.path,
        ref: "main",
      });
      if (Array.isArray(data) || data.type !== "file") continue;

      const text = Buffer.from(data.content, "base64").toString("utf-8");
      const { data: fm } = matter(text);

      posts.push({
        path: file.path,
        sha: data.sha,
        title: typeof fm.title === "string" ? fm.title : file.name.replace(/\.md$/, ""),
        slug:
          typeof fm.slug === "string"
            ? fm.slug
            : file.name.replace(/\.md$/, ""),
        date: fm.date ? String(fm.date) : "",
        coverImage: typeof fm.coverImage === "string" ? fm.coverImage : "",
        coverImageAlt: typeof fm.coverImageAlt === "string" ? fm.coverImageAlt : "",
        excerpt: typeof fm.excerpt === "string" ? fm.excerpt : "",
        draft: fm.draft === true,
      });
    } catch (err) {
      console.error(`Blog-Datei "${file.path}" konnte nicht gelesen werden:`, err);
    }
  }

  // Neueste zuerst
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return posts;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const siteId = searchParams.get("siteId");
  const path = searchParams.get("path");

  const auth = await authorize(siteId);
  if (!auth.ok) return auth.error;

  try {
    const octokit = createOctokit();

    // Einzelnen Beitrag inkl. Inhalt laden (für den Beitrags-Editor)
    if (path) {
      if (!isValidBlogPath(path)) {
        return NextResponse.json({ error: "Ungültiger Dateipfad." }, { status: 400 });
      }
      const { data } = await octokit.repos.getContent({
        owner: auth.site.repo_owner,
        repo: auth.site.repo_name,
        path,
        ref: "main",
      });
      if (Array.isArray(data) || data.type !== "file") {
        return NextResponse.json({ error: "Beitrag nicht gefunden." }, { status: 404 });
      }
      const text = Buffer.from(data.content, "base64").toString("utf-8");
      const { content } = matter(text);
      return NextResponse.json({ content: content.trim() });
    }

    const posts = await listBlogPosts(
      octokit,
      auth.site.repo_owner,
      auth.site.repo_name
    );
    return NextResponse.json({ posts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Blog-Liste fehlgeschlagen:", message);
    return NextResponse.json(
      { error: "Blog-Artikel konnten nicht geladen werden. Details stehen im Server-Protokoll." },
      { status: 502 }
    );
  }
}

export async function POST(request: Request) {
  let body: {
    siteId?: string;
    slug?: string;
    frontmatter?: {
      title?: string;
      date?: string;
      coverImage?: string;
      coverImageAlt?: string;
      excerpt?: string;
      draft?: boolean;
    };
    content?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
  }

  const auth = await authorize(body.siteId ?? null);
  if (!auth.ok) return auth.error;

  const slug = slugify(body.slug ?? "");
  if (!slug) {
    return NextResponse.json({ error: "Ungültige oder fehlende Webadresse." }, { status: 400 });
  }

  const fm = body.frontmatter ?? {};
  // W9: Eingaben erst auf Strings normieren (falsche Typen → deutsche
  // Meldung statt englischem Zod-Standardtext), dann streng validieren.
  const normiert = {
    title: typeof fm.title === "string" ? fm.title : "",
    date: typeof fm.date === "string" ? fm.date : undefined,
    coverImage: typeof fm.coverImage === "string" ? fm.coverImage : "",
    coverImageAlt: typeof fm.coverImageAlt === "string" ? fm.coverImageAlt : "",
    excerpt: typeof fm.excerpt === "string" ? fm.excerpt : "",
    draft: fm.draft === true,
  };
  const inhalt = typeof body.content === "string" ? body.content : "";
  const parsed = blogPostSchema.safeParse({ frontmatter: normiert, content: inhalt });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: first?.message ?? "Blog-Daten ungültig." }, { status: 400 });
  }
  const valid = parsed.data;
  if (!valid.frontmatter.title.trim()) {
    return NextResponse.json({ error: "Titel fehlt." }, { status: 400 });
  }

  const frontmatter = {
    title: valid.frontmatter.title.trim(),
    slug,
    date: valid.frontmatter.date || new Date().toISOString().slice(0, 10),
    coverImage: valid.frontmatter.coverImage ?? "",
    coverImageAlt: valid.frontmatter.coverImageAlt || valid.frontmatter.title || "",
    excerpt: valid.frontmatter.excerpt ?? "",
    draft: valid.frontmatter.draft === true,
  };

  const markdown = matter.stringify(`\n${valid.content ?? ""}\n`, frontmatter);
  const filePath = `${BLOG_DIR}/${slug}.md`;

  // Defense in Depth: der erzeugte Pfad muss dem Blog-Pfad-Schema entsprechen
  if (!isValidBlogPath(filePath)) {
    return NextResponse.json({ error: "Ungültiger Dateipfad." }, { status: 400 });
  }

  try {
    const octokit = createOctokit();

    // Existiert die Datei bereits? -> SHA für Update holen
    let sha: string | undefined;
    try {
      const { data } = await octokit.repos.getContent({
        owner: auth.site.repo_owner,
        repo: auth.site.repo_name,
        path: filePath,
        ref: "main",
      });
      if (!Array.isArray(data) && data.type === "file") {
        sha = data.sha;
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    // W13: Bei Versionskonflikt (paralleles Speichern) einmal mit frischem
    // SHA erneut versuchen, statt sofort aufzugeben.
    let commitData;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await octokit.repos.createOrUpdateFileContents({
          owner: auth.site.repo_owner,
          repo: auth.site.repo_name,
          path: filePath,
          message: `cms: save blog post ${slug}`,
          content: Buffer.from(markdown, "utf-8").toString("base64"),
          sha,
          branch: "main",
        });
        commitData = res.data;
        break;
      } catch (err) {
        if (attempt === 0 && isShaConflictError(err)) {
          try {
            const { data } = await octokit.repos.getContent({
              owner: auth.site.repo_owner,
              repo: auth.site.repo_name,
              path: filePath,
              ref: "main",
            });
            if (!Array.isArray(data) && data.type === "file") {
              sha = data.sha;
              continue;
            }
          } catch {
            // Frisches Laden scheiterte – unten als Fehler melden
          }
        }
        throw err;
      }
    }

    return NextResponse.json({
      message: sha
        ? `Beitrag "${frontmatter.title}" wurde aktualisiert.`
        : `Beitrag "${frontmatter.title}" wurde veröffentlicht.`,
      post: {
        path: filePath,
        sha: commitData!.content?.sha ?? "",
        ...frontmatter,
      } satisfies BlogPost,
    });
  } catch (err) {
    console.error("Blog-Speichern fehlgeschlagen:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: `Beitrag konnte nicht gespeichert werden: ${githubFehlerGrund(err)}` },
      { status: 502 }
    );
  }
}

export async function DELETE(request: Request) {
  let body: { siteId?: string; path?: string; sha?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
  }

  const auth = await authorize(body.siteId ?? null);
  if (!auth.ok) return auth.error;

  const { path, sha } = body;
  if (!path || !sha) {
    return NextResponse.json({ error: "path oder sha fehlt." }, { status: 400 });
  }

  // Sicherheitscheck: nur Dateien im Blog-Ordner löschen (strikt: kein "..", nur [a-z0-9-].md)
  if (!isValidBlogPath(path)) {
    return NextResponse.json(
      { error: "Nur Markdown-Dateien im Blog-Ordner dürfen gelöscht werden." },
      { status: 400 }
    );
  }

  const slug = path.replace(`${BLOG_DIR}/`, "").replace(/\.md$/, "");

  try {
    const octokit = createOctokit();
    // W13: Bei Versionskonflikt einmal mit frischem SHA erneut versuchen.
    let currentSha = sha;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await octokit.repos.deleteFile({
          owner: auth.site.repo_owner,
          repo: auth.site.repo_name,
          path,
          message: `cms: delete blog post ${slug}`,
          sha: currentSha,
          branch: "main",
        });
        break;
      } catch (err) {
        if (attempt === 0 && isShaConflictError(err)) {
          try {
            const { data } = await octokit.repos.getContent({
              owner: auth.site.repo_owner,
              repo: auth.site.repo_name,
              path,
              ref: "main",
            });
            if (!Array.isArray(data) && data.type === "file") {
              currentSha = data.sha;
              continue;
            }
          } catch {
            // Frisches Laden scheiterte – unten als Fehler melden
          }
        }
        throw err;
      }
    }

    return NextResponse.json({ message: `Beitrag "${slug}" wurde gelöscht.` });
  } catch (err) {
    console.error("Blog-Löschen fehlgeschlagen:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: `Beitrag konnte nicht gelöscht werden: ${githubFehlerGrund(err)}` },
      { status: 502 }
    );
  }
}
