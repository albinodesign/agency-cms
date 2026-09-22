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

  // Admin-Check und KI-Verbrauchsstatistik für den aktuellen Monat laden
  let isAdmin = false;
  const usageStats: Record<string, { messages: number; costEuro: number }> = {};

  try {
    const adminClient = createAdminClient();
    const { data: adminRow } = await adminClient
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    isAdmin = adminRow !== null;

    if (isAdmin) {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const { data: usageRows } = await adminClient
        .from("ai_usage")
        .select("site_id, messages, prompt_tokens, completion_tokens")
        .eq("month", currentMonth);

      const { calculateCostEuro } = await import("@/lib/ai");

      (usageRows ?? []).forEach((row) => {
        const cost = calculateCostEuro(row.prompt_tokens ?? 0, row.completion_tokens ?? 0);
        usageStats[row.site_id] = {
          messages: row.messages ?? 0,
          costEuro: cost,
        };
      });
    }
  } catch {
    isAdmin = false;
  }

  return (
    <DashboardClient
      initialSites={sites}
      isAdmin={isAdmin}
      loadError={error?.message ?? null}
      usageStats={usageStats}
    />
  );
}
