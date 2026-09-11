import { NextResponse } from "next/server";
import matter from "gray-matter";
import { createClient } from "@/lib/supabase/server";
import { createOctokit } from "@/lib/github";
import { slugify } from "@/lib/slugify";
import type { BlogPost, Site } from "@/types/cms";
import type { Octokit } from "@octokit/rest";

const BLOG_DIR = "src/content/blog";

/** Session + Site-Zugriff prüfen, liefert die Site oder eine Fehler-Response. */
async function authorize(siteId: string | null) {
  if (!siteId) {
    return { error: NextResponse.json({ error: "siteId fehlt." }, { status: 400 }) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 }) };
  }

  const { data: assignment } = await supabase
    .from("user_sites")
    .select("site_id")
    .eq("user_id", user.id)
    .eq("site_id", siteId)
    .maybeSingle();

  if (!assignment) {
    return { error: NextResponse.json({ error: "Kein Zugriff auf diese Website." }, { status: 403 }) };
  }

  const { data: site, error: siteError } = await supabase
    .from("sites")
    .select("*")
    .eq("id", siteId)
    .single();

  if (siteError || !site) {
    return { error: NextResponse.json({ error: "Website nicht gefunden." }, { status: 404 }) };
  }

  return { site: site as Site };
}

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
  if ("error" in auth) return auth.error;

  try {
    const octokit = createOctokit();

    // Einzelnen Beitrag inkl. Inhalt laden (für den Beitrags-Editor)
    if (path) {
      if (!path.startsWith(`${BLOG_DIR}/`) || !path.endsWith(".md")) {
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
      { error: `Blog-Artikel konnten nicht geladen werden: ${message}` },
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
  if ("error" in auth) return auth.error;

  const slug = slugify(body.slug ?? "");
  if (!slug) {
    return NextResponse.json({ error: "Ungültiger oder fehlender Slug." }, { status: 400 });
  }

  const fm = body.frontmatter ?? {};
  if (!fm.title?.trim()) {
    return NextResponse.json({ error: "Titel fehlt." }, { status: 400 });
  }

  const frontmatter = {
    title: fm.title.trim(),
    slug,
    date: fm.date || new Date().toISOString().slice(0, 10),
    coverImage: fm.coverImage ?? "",
    excerpt: fm.excerpt ?? "",
    draft: fm.draft === true,
  };

  const markdown = matter.stringify(`\n${body.content ?? ""}\n`, frontmatter);
  const filePath = `${BLOG_DIR}/${slug}.md`;

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

    const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
      owner: auth.site.repo_owner,
      repo: auth.site.repo_name,
      path: filePath,
      message: `cms: save blog post ${slug}`,
      content: Buffer.from(markdown, "utf-8").toString("base64"),
      sha,
      branch: "main",
    });

    return NextResponse.json({
      message: sha
        ? `Beitrag "${frontmatter.title}" wurde aktualisiert.`
        : `Beitrag "${frontmatter.title}" wurde veröffentlicht.`,
      post: {
        path: filePath,
        sha: commitData.content?.sha ?? "",
        ...frontmatter,
      } satisfies BlogPost,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Blog-Speichern fehlgeschlagen:", message);
    return NextResponse.json(
      { error: `Beitrag konnte nicht gespeichert werden: ${message}` },
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
  if ("error" in auth) return auth.error;

  const { path, sha } = body;
  if (!path || !sha) {
    return NextResponse.json({ error: "path oder sha fehlt." }, { status: 400 });
  }

  // Sicherheitscheck: nur Dateien im Blog-Ordner löschen
  if (!path.startsWith(`${BLOG_DIR}/`) || !path.endsWith(".md")) {
    return NextResponse.json(
      { error: "Nur Markdown-Dateien im Blog-Ordner dürfen gelöscht werden." },
      { status: 400 }
    );
  }

  const slug = path.replace(`${BLOG_DIR}/`, "").replace(/\.md$/, "");

  try {
    const octokit = createOctokit();
    await octokit.repos.deleteFile({
      owner: auth.site.repo_owner,
      repo: auth.site.repo_name,
      path,
      message: `cms: delete blog post ${slug}`,
      sha,
      branch: "main",
    });

    return NextResponse.json({ message: `Beitrag "${slug}" wurde gelöscht.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Blog-Löschen fehlgeschlagen:", message);
    return NextResponse.json(
      { error: `Beitrag konnte nicht gelöscht werden: ${message}` },
      { status: 502 }
    );
  }
}
