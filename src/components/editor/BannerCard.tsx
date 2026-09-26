"use client";

import type { DraftMap } from "@/types/cms";

const BANNER_FILE = "src/content/site.json";
// Pfade OHNE "site."-Vorsatz: site.json liegt flach (banner.enabled),
// die Website liest sie als site.banner (getSite liefert die Datei direkt)
const BANNER_ENABLED_ID = `json:${BANNER_FILE}:banner.enabled`;
const BANNER_VARIANT_ID = `json:${BANNER_FILE}:banner.variant`;
const BANNER_TEXT_ID = `json:${BANNER_FILE}:banner.text`;

const BANNER_VARIANTS = [
  { id: "vacation", label: "🟡 Betriebsurlaub", pill: "bg-amber-500 text-white border-amber-500" },
  { id: "emergency", label: "🔴 Dringend / Notfall", pill: "bg-red-500 text-white border-red-500" },
  { id: "info", label: "🔵 Information", pill: "bg-blue-500 text-white border-blue-500" },
] as const;

/** Hinweis- & Urlaubsbanner: Schalter, Stil und Text – schreibt direkt Entwürfe. */
export function BannerCard({
  values,
  onChange,
}: {
  values: DraftMap;
  onChange: (fieldId: string, value: string) => void;
}) {
  const enabled = (values[BANNER_ENABLED_ID] ?? "") === "true";
  const variant = values[BANNER_VARIANT_ID] ?? "vacation";
  const text = values[BANNER_TEXT_ID] ?? "";

  return (
    <div className="mb-4 rounded-2xl border border-zinc-200 bg-zinc-50/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-zinc-900">
          Hinweisbanner auf der Website anzeigen
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onChange(BANNER_ENABLED_ID, enabled ? "false" : "true")}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
            enabled ? "bg-emerald-500" : "bg-zinc-300"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
              enabled ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <p className={`mt-0.5 text-xs font-medium ${enabled ? "text-emerald-700" : "text-zinc-400"}`}>
        {enabled ? "AN" : "AUS"}
      </p>

      {enabled && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {BANNER_VARIANTS.map((v) => {
              const active = variant === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onChange(BANNER_VARIANT_ID, v.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                    active
                      ? v.pill
                      : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100"
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
          <div>
            <input
              type="text"
              value={text}
              maxLength={160}
              onChange={(e) => onChange(BANNER_TEXT_ID, e.target.value)}
              placeholder="Wir sind vom 01. bis 15. August im Betriebsurlaub."
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
            />
            <p className="mt-1 text-right text-xs text-zinc-400">
              {text.length} / 160 Zeichen
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
