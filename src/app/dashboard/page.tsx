import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/components/LogoutButton";
import { Globe, ArrowRight } from "lucide-react";
import type { Site } from "@/types/cms";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("user_sites")
    .select("sites(*)")
    .eq("user_id", user.id);

  const sites: Site[] = (data ?? [])
    .map((row) => row.sites as unknown as Site | null)
    .filter((s): s is Site => s !== null);

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
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Deine Websites
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Wähle eine Website aus, um Inhalte zu bearbeiten.
        </p>

        {error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Websites konnten nicht geladen werden: {error.message}
          </div>
        )}

        {!error && sites.length === 0 && (
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
    </div>
  );
}
