/**
 * Liest die Supabase-Konfiguration aus den Env-Variablen und normalisiert
 * die URL: Versehentlich mitkopierte API-Pfade (z. B. "/rest/v1") und
 * abschließende Slashes werden entfernt, da supabase-js die Pfade
 * ("/auth/v1", "/rest/v1", …) selbst an die Basis-URL anhängt.
 */
export function getSupabaseConfig() {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const url = rawUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(rest|auth|storage|realtime)\/v1$/i, "");

  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();

  return {
    url: url || "https://placeholder.supabase.co",
    anonKey: anonKey || "placeholder-anon-key",
  };
}
