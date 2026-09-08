import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DashboardClient } from "@/components/DashboardClient";
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

  // Admin-Check: steht der Nutzer in der Tabelle "admins"?
  let isAdmin = false;
  try {
    const adminClient = createAdminClient();
    const { data: adminRow } = await adminClient
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    isAdmin = adminRow !== null;
  } catch {
    // Ohne Service-Role-Key keine Admin-Prüfung möglich -> normale Ansicht
    isAdmin = false;
  }

  return (
    <DashboardClient
      initialSites={sites}
      isAdmin={isAdmin}
      loadError={error?.message ?? null}
    />
  );
}
