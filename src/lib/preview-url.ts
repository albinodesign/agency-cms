/**
 * Vorschau-URLs je CMS-Seite (reine Funktionen, ohne Netz).
 *
 * Hintergrund (document.referrer-Falle, siehe CMS-REFERENCE.md Abschnitt 7):
 * Die Website leitet das postMessage-Ziel für CMS_FIELD_SELECT aus
 * `document.referrer` ab. Nur wenn die Vorschau-Seite vom CMS aus geladen
 * wurde (iframe.src durch das CMS gesetzt), ist der Referrer die CMS-Domain
 * und Klicks kommen an. Navigiert man dagegen über einen Link *innerhalb*
 * der Vorschau, ist der Referrer die vorherige Website-Seite – der Origin
 * steht nicht in der Allowlist, die Bridge verwirft jeden Klick still.
 *
 * Deshalb navigiert das CMS beim Seitenwechsel die Vorschau immer selbst
 * (iframe.src direkt setzen): Jede so geladene Seite hat wieder den
 * CMS-Referrer, egal auf welcher Seite man sich befindet. Die Ziel-URL je
 * Seite wird dabei aus den Manifest-Dateinamen abgeleitet
 * (`src/content/pages/<slug>.json` → `<preview_url>/<slug>`,
 * `home`/`index`/`start`/`startseite` → Basis-URL).
 */

export interface PreviewSectionsInput {
  sections: Array<{
    fields?: Array<{ file?: string }> | null;
  } | null> | null;
}

/** Dateiname ohne Endung aus "src/content/pages/<name>.json", sonst null. */
export function pageSlugFromFile(file: unknown): string | null {
  if (typeof file !== "string") return null;
  const prefix = "src/content/pages/";
  const suffix = ".json";
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) return null;
  const slug = file.slice(prefix.length, -suffix.length);
  if (!slug || slug.includes("/") || slug.includes("\\")) return null;
  return slug;
}

/** Startseiten-Slugs landen auf der Basis-URL (kein Pfad nötig). */
export function isHomeSlug(slug: string): boolean {
  return /^(home|index|start|startseite)$/i.test(slug.trim());
}

/**
 * Ziel-URL der Vorschau für eine CMS-Seite (Seiten-Tab).
 * Fällt bei unbekannten/unsicheren Angaben immer auf die Basis-URL zurück –
 * lieber Startseite mit funktionierender Feldsuche als eine geratene 404.
 */
export function getPagePreviewUrl(
  basePreviewUrl: string,
  page: PreviewSectionsInput | null | undefined
): string {
  let base: string;
  try {
    const url = new URL(basePreviewUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return basePreviewUrl;
    base = url.toString();
  } catch {
    return basePreviewUrl;
  }
  // Mit Query/Hash lässt sich kein Pfad sicher anhängen – Basis behalten.
  if (base.includes("?") || base.includes("#")) return base;
  base = base.replace(/\/+$/, "");

  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const section of page?.sections ?? []) {
    for (const field of section?.fields ?? []) {
      const slug = pageSlugFromFile(field?.file);
      if (!slug) continue;
      if (!counts.has(slug)) {
        counts.set(slug, 0);
        order.push(slug);
      }
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  if (order.length === 0) return base;

  // Häufigster Slug der Seite gewinnt (Gleichstand: erster im Manifest).
  let winner = order[0];
  for (const slug of order) {
    if ((counts.get(slug) ?? 0) > (counts.get(winner) ?? 0)) winner = slug;
  }
  if (isHomeSlug(winner)) return base;
  return `${base}/${winner}`;
}
