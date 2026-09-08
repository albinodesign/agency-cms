import { Octokit } from "@octokit/rest";
import type { CmsManifest } from "@/types/cms";

export function createOctokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN ist nicht gesetzt.");
  }
  return new Octokit({ auth: token });
}

export const MANIFEST_PATH = "src/content/cms.manifest.json";

interface GitHubFileContent {
  content: string;
  sha: string;
}

/** Lädt eine Datei aus dem Repo und dekodiert sie (Base64 -> UTF-8). */
export async function getRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string
): Promise<{ text: string; sha: string }> {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: "main",
  });

  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`"${path}" ist keine Datei im Repository.`);
  }

  const file = data as unknown as GitHubFileContent;
  const text = Buffer.from(file.content, "base64").toString("utf-8");
  return { text, sha: file.sha };
}

export async function getManifest(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<CmsManifest> {
  const { text } = await getRepoFile(octokit, owner, repo, MANIFEST_PATH);
  return JSON.parse(text) as CmsManifest;
}
