/**
 * KI-Werkzeuge als testbare Einheit (genutzt von der Chat-Route).
 *
 * Alle Werkzeuge arbeiten gegen die Server-Feldliste und die gemeinsamen
 * Schutzprüfungen aus content-guard.ts – dieselben Regeln wie im Publish.
 * Speicher- und Repo-Zugriffe laufen über schmale Adapter (Deps), sodass
 * Tests mit lokalen Fakes arbeiten können (kein Netz, keine Produktion).
 */
import { tool } from "ai";
import { z } from "zod";
import {
  AI_MAX_FILE_CHARS,
  MANIFEST_PATH,
  breaksBridge,
  findsSecret,
  isAllowedCodePath,
  isAllowedContentPath,
  validateManifestText,
} from "./ai";
import type { AiFieldContext } from "./ai";
import { getByPath, parsePathSafe, setByPath } from "./json-path";
import {
  FREE_VALUE_MAX,
  SITE_JSON,
  SUPPORTED_FIELD_TYPES,
  appendContextFor,
  canonicalTarget,
  classifyFreeTarget,
  convertEditValue,
  findListModel,
  fixedListGrowError,
  getBannerProblems,
  isAllowedFieldJsonFile,
  isPlainObject,
  makeCoveragePredicate,
  missingAppendKeys,
  parseFreeDraftIdSafe,
  validateBannerValue,
  validateJsonPath,
  validateListStructures,
  validateScalarTypePreservation,
} from "./content-guard";
import type { TypeEntry } from "./content-guard";
import { validateDraftValue, validateJsonValue } from "./validate";
import type { FieldType } from "../types/cms";
import { FREE_DRAFT_PREFIX } from "../types/cms";

export interface AiToolsSite {
  id: string;
  repo_owner: string;
  repo_name: string;
}

/** Schmale Speicherschnittstelle (Supabase-kompatibel, testbar mit Fakes). */
export interface AiDraftStore {
  storeDraft(
    siteId: string,
    fieldId: string,
    value: string
  ): Promise<{ error: { message: string } | null }>;
  storeCodeDraft(
    siteId: string,
    filePath: string,
    content: string
  ): Promise<{ error: { message: string } | null }>;
  listDrafts(siteId: string): Promise<Array<{ field_id: string; value: string }>>;
  listImages(siteId: string): Promise<string[]>;
}

/** Schmaler Repo-Zugriff (GitHub-kompatibel, testbar mit Fakes). */
export interface AiRepoReader {
  readFile(repoOwner: string, repoName: string, path: string): Promise<string>;
  listTree(repoOwner: string, repoName: string): Promise<string[]>;
}

export interface AiToolsDeps {
  site: AiToolsSite;
  /** Vollständige Server-Feldliste (entscheidend, nicht die Client-Liste). */
  serverFields: AiFieldContext[];
  store: AiDraftStore;
  repo: AiRepoReader;
}

/** Standard-Lesebudget pro Aufruf (Paging statt Abschneiden). */
export const READ_DEFAULT_CHARS = 12_000;
/** Harte Obergrenze pro Leseaufruf. */
export const READ_MAX_CHARS = 20_000;

function manifestByCanonical(serverFields: AiFieldContext[]) {
  const map = new Map<string, AiFieldContext & { maxLength?: number }>();
  for (const f of serverFields) {
    const c = canonicalTarget(f.file, f.path);
    if (c && !map.has(c)) map.set(c, f);
  }
  return map;
}

function safeTypeOf(value: unknown): FieldType {
  return SUPPORTED_FIELD_TYPES.includes(value as FieldType) ? (value as FieldType) : "text";
}

/** Fehlende Banner-Angaben im Kandidaten (ehrlicher Hinweis, gemeinsame Prüfung). */
function missingBannerParts(candidate: Record<string, unknown> | undefined): string[] {
  const banner =
    candidate && isPlainObject(candidate.banner)
      ? (candidate.banner as Record<string, unknown>)
      : undefined;
  if (!banner) return [];
  // Gemeinsame Banner-Prüfung wie im Publish – auch String-"true" zählt als
  // eingeschaltet, damit fehlender Stil/Text nie übersehen werden.
  const problems = getBannerProblems(
    banner.enabled === "true" || banner.enabled === "false"
      ? { ...banner, enabled: banner.enabled === "true" }
      : banner
  );
  const parts: string[] = [];
  if (problems.some((p) => /Stil/.test(p))) parts.push("Stil (vacation, emergency oder info)");
  if (problems.some((p) => /Text/.test(p))) parts.push("Text (max. 160 Zeichen)");
  if (problems.some((p) => /Schalter/.test(p))) parts.push("Schalter (an/aus)");
  for (const p of problems) {
    if (!/Stil|Text|Schalter/.test(p)) parts.push(p);
  }
  return parts;
}

export function buildAiTools(deps: AiToolsDeps) {
  const { site, serverFields, store, repo } = deps;
  const fieldMap = new Map(serverFields.map((f) => [f.id, f]));
  const byCanonical = manifestByCanonical(serverFields);
  // Gemeinsame Zielauflösung wie im Publish: kanonisches Ziel -> Typ/Länge/Label.
  const typeMap = new Map<string, TypeEntry>();
  for (const f of serverFields) {
    const c = canonicalTarget(f.file, f.path);
    if (c && !typeMap.has(c)) {
      typeMap.set(c, { type: safeTypeOf(f.type), maxLength: f.maxLength, label: f.label });
    }
  }

  /** Kandidat aus Live-Datei + bereits gespeicherten Entwürfen (best effort). */
  async function buildCandidate(
    datei: string
  ): Promise<{ live: Record<string, unknown>; candidate: Record<string, unknown> } | { fehler: string }> {
    let liveText: string;
    try {
      liveText = await repo.readFile(site.repo_owner, site.repo_name, datei);
    } catch (err) {
      return { fehler: `Die Datei "${datei}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : "unbekannt"}` };
    }
    let live: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(liveText);
      if (!isPlainObject(parsed)) return { fehler: `Die Datei "${datei}" enthält kein JSON-Objekt.` };
      live = parsed;
    } catch {
      return { fehler: `Die Datei "${datei}" enthält kein gültiges JSON.` };
    }
    const candidate = structuredClone(live);
    try {
      const existing = await store.listDrafts(site.id);
      for (const d of existing) {
        const known = fieldMap.get(d.field_id);
        if (known && known.file === datei) {
          try {
            // Gemeinsame Typumwandlung wie im Publish (keine rohen Strings:
            // "true" auf Boolean-Feldern wird echtes true).
            setByPath(candidate, known.path, convertEditValue(datei, known.path, d.value, typeMap, live));
          } catch {
            // Alter Entwurf passt nicht mehr – ignorieren, Publish prüft streng.
          }
          continue;
        }
        const free = parseFreeDraftIdSafe(d.field_id);
        if (free.ok && free.file === datei) {
          try {
            setByPath(candidate, free.path, convertEditValue(datei, free.path, d.value, typeMap, live));
          } catch {
            // Wie oben: Publish entscheidet.
          }
        }
      }
    } catch {
      // Entwürfe nicht ladbar – weiter mit Live-Stand (Publish prüft streng).
    }
    return { live, candidate };
  }

  /**
   * Bestimmt den Entwurfsstatus aus dem zusammengesetzten Stand (Live plus
   * ALLE gespeicherten Entwürfe, inkl. der gerade gespeicherten Änderung):
   * Fehlende Modellschlüssel, Struktur-/Typabweichungen und Banner-Lücken
   * führen zu hinweis + veroeffentlichbar=false – auch bei Korrekturen und
   * über beide Zugriffswege (Feld-ID oder datei+pfad). Ein fehlender Hinweis
   * allein beweist keine Veröffentlichungsfähigkeit; maßgeblich bleibt Publish.
   */
  async function statusAfterStore(
    datei: string,
    pfad: string
  ): Promise<{ hinweis: string | null; veroeffentlichbar: boolean }> {
    const built = await buildCandidate(datei);
    if ("fehler" in built) return { hinweis: null, veroeffentlichbar: true };
    let hinweis: string | null = null;
    const pp = parsePathSafe(pfad);
    if (pp.ok) {
      const missing = missingAppendKeys(datei, pp.segments, built.live, built.candidate);
      if (missing.length > 0) {
        hinweis = `Noch unvollständig – ergänze noch als eigene Entwürfe: ${missing.join(", ")}. Erst dann veröffentlichen. Sage das dem Kunden ehrlich.`;
      }
    }
    if (hinweis === null) {
      const pred = makeCoveragePredicate(typeMap);
      const liveM = new Map([[datei, built.live]]);
      const candM = new Map([[datei, built.candidate]]);
      const struktur = [
        ...validateListStructures(liveM, candM, pred),
        ...validateScalarTypePreservation(liveM, candM, pred),
      ];
      if (struktur.length > 0) {
        hinweis = `Noch nicht veröffentlichbar: ${struktur[0]}`;
      }
    }
    if (hinweis === null && datei === SITE_JSON) {
      const parts = missingBannerParts(built.candidate);
      if (parts.length > 0) {
        hinweis = `Banner noch unvollständig – es fehlt noch: ${parts.join(", ")}. Erst dann veröffentlichen. Sage das dem Kunden ehrlich.`;
      }
    }
    return { hinweis, veroeffentlichbar: hinweis === null };
  }

  return {
    projektUebersicht: tool({
      description:
        "Liefert eine kompakte Liste aller Komponenten, Seiten und Inhaltsdateien im Website-Repository. Nutze dies ZUERST, um Dateipfade zu finden, bevor du Dateien liest.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const paths = await repo.listTree(site.repo_owner, site.repo_name);
          return {
            dateien: paths.filter(
              (p) =>
                p.startsWith("src/") &&
                (p.endsWith(".astro") || p.endsWith(".json") || p.endsWith(".md") || p.endsWith(".css"))
            ),
          };
        } catch (err) {
          return { fehler: `Projektübersicht konnte nicht geladen werden: ${err instanceof Error ? err.message : "unbekannt"}` };
        }
      },
    }),
    listeFelder: tool({
      description:
        "Listet ALLE bearbeitbaren Felder der Website (ID, Name, Typ) – serverseitig, immer vollständig, auch wenn der Prompt gekürzt war.",
      inputSchema: z.object({}),
      execute: async () => ({
        felder: serverFields.map((f) => ({ id: f.id, name: f.label, typ: f.type })),
      }),
    }),
    leseDatei: tool({
      description:
        "Liest eine Website-Datei abschnittsweise (Paging). Gekürzte Ergebnisse sind als gekuerzt=true markiert – dann mit abZeichen=weiterAb weiterlesen, bis gekuerzt=false.",
      inputSchema: z.object({
        datei: z.string().describe("Dateipfad im Repo, z. B. src/content/pages/home.json"),
        abZeichen: z.number().optional().describe("Startposition (Standard 0)"),
        maxZeichen: z.number().optional().describe("Zeichen pro Aufruf, max. 20000 (Standard 12000)"),
      }),
      execute: async ({ datei, abZeichen, maxZeichen }) => {
        if (!isAllowedContentPath(datei) && !isAllowedCodePath(datei)) {
          return { fehler: `Die Datei "${datei}" darfst du nicht öffnen (Tabu-Bereich).` };
        }
        const start = Math.max(0, Math.floor(abZeichen ?? 0));
        const amount = Math.min(READ_MAX_CHARS, Math.max(1, Math.floor(maxZeichen ?? READ_DEFAULT_CHARS)));
        try {
          const text = await repo.readFile(site.repo_owner, site.repo_name, datei);
          const end = Math.min(text.length, start + amount);
          const gekuerzt = end < text.length;
          return {
            datei,
            inhalt: text.slice(start, end),
            von: start,
            bis: end,
            gesamtZeichen: text.length,
            gekuerzt,
            weiterAb: gekuerzt ? end : null,
          };
        } catch (err) {
          return { fehler: `Die Datei "${datei}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : "unbekannt"}` };
        }
      },
    }),
    leseFeld: tool({
      description:
        "Liest EIN Feld anhand seiner Feld-ID vollständig aus – auch wenn es weit hinten in einer großen Datei liegt (kein Abschneiden). Nutze listeFelder für die ID.",
      inputSchema: z.object({
        feldId: z.string().describe("Feld-ID aus der Feldliste, z. B. hero.title"),
      }),
      execute: async ({ feldId }) => {
        const field = fieldMap.get(feldId);
        if (!field) return { fehler: `Das Feld "${feldId}" gibt es nicht.` };
        try {
          const text = await repo.readFile(site.repo_owner, site.repo_name, field.file);
          const json: unknown = JSON.parse(text);
          if (!isPlainObject(json)) return { fehler: `Die Datei "${field.file}" enthält kein JSON-Objekt.` };
          const value = getByPath(json, field.path);
          if (value === undefined) return { fehler: `Der Pfad "${field.path}" existiert nicht in Datei "${field.file}".` };
          const rendered = typeof value === "string" ? value : JSON.stringify(value);
          const gekuerzt = rendered.length > READ_MAX_CHARS;
          return {
            feldId,
            datei: field.file,
            pfad: field.path,
            wert: gekuerzt ? rendered.slice(0, READ_MAX_CHARS) : rendered,
            gekuerzt,
            gesamtZeichen: rendered.length,
          };
        } catch (err) {
          return { fehler: `Das Feld "${feldId}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : "unbekannt"}` };
        }
      },
    }),
    schreibeInhalt: tool({
      description:
        "Ändert einen Inhalt als Entwurf (geht NICHT live, nur Vorbereitung). Entweder feldId ODER datei+pfad angeben. Unzulässige Ziele werden mit Fehler abgelehnt (kein stilles Speichern). Unvollständige Ergänzungen werden ehrlich als hinweis gemeldet – veröffentlichen darf sich das erst vollständig.",
      inputSchema: z.object({
        feldId: z.string().optional().describe("Feld-ID aus der Feldliste, z. B. hero.title"),
        datei: z.string().optional().describe("Nur ohne feldId: Zieldatei, z. B. src/content/pages/home.json"),
        pfad: z.string().optional().describe("Nur ohne feldId: Pfad in der Datei, z. B. hero.title oder faq.eintraege[0].frage"),
        wert: z.string().describe("Der neue Text"),
      }),
      execute: async ({ feldId, datei, pfad, wert }) => {
        if (typeof wert !== "string" || wert.length > FREE_VALUE_MAX) {
          return { fehler: `Der Text ist zu lang (max. ${FREE_VALUE_MAX} Zeichen). Bitte kürzen.` };
        }
        if (feldId) {
          const field = fieldMap.get(feldId);
          if (!field) return { fehler: `Das Feld "${feldId}" gibt es nicht.` };
          const problem = validateDraftValue(safeTypeOf(field.type), wert, field.maxLength);
          if (problem) return { fehler: `${field.label}: ${problem}` };
          // Banner-Regel gilt auch per Feld-ID (gemeinsam mit Publish) – sonst
          // nähme der Chat z. B. variant="party" an, was Publish ablehnt.
          const fieldParsed = parsePathSafe(field.path);
          if (
            field.file === SITE_JSON &&
            fieldParsed.ok &&
            fieldParsed.segments.length === 2 &&
            fieldParsed.segments[0] === "banner" &&
            typeof fieldParsed.segments[1] === "string"
          ) {
            const bannerProblem = validateBannerValue(fieldParsed.segments[1], wert);
            if (bannerProblem) return { fehler: `Banner: ${bannerProblem}` };
          }
          const { error } = await store.storeDraft(site.id, feldId, wert);
          if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
          const status = await statusAfterStore(field.file, field.path);
          return {
            art: "feld",
            feldId,
            wert,
            vorschau: "sofort",
            meldung: `"${field.label}" als Entwurf gespeichert, Kunde sieht es sofort in der Vorschau.`,
            hinweis: status.hinweis,
            veroeffentlichbar: status.veroeffentlichbar,
          };
        }
        if (datei && pfad) {
          // Gleiche gemeinsame Prüfung wie im Publish (Dateisperre, Pfad,
          // Typ/Länge bei bekanntem Ziel, Banner-Regeln) – Einordnung gegen
          // den Live-Stand, Bestand inklusive gespeicherter Entwürfe
          // (zusammengehörige Änderungen bleiben vervollständigbar).
          if (!isAllowedFieldJsonFile(datei)) {
            return { fehler: `Die Datei "${datei}" ist kein erlaubtes Inhaltsziel (erlaubt: src/content/site.json und JSON-Dateien unter src/content/pages/).` };
          }
          const pathProblem = validateJsonPath(pfad);
          if (pathProblem) {
            return { fehler: `Der Pfad "${pfad}" ist ungültig: ${pathProblem}` };
          }
          const built = await buildCandidate(datei);
          if ("fehler" in built) return { fehler: built.fehler };
          const verdict = classifyFreeTarget(datei, pfad, built.live, wert, built.candidate);
          if (!verdict.ok) return { fehler: verdict.error };
          const pp = parsePathSafe(pfad);
          const canonical = pp.ok ? `${datei}#${pp.canonical}` : null;
          const declared = canonical ? byCanonical.get(canonical) : undefined;
          if (declared) {
            const problem = validateJsonValue(safeTypeOf(declared.type), wert, declared.maxLength);
            if (problem) return { fehler: `${declared.label}: ${problem}` };
          }
          // Banner-Regel gilt zusätzlich immer – auch auf deklarierten Pfaden
          // (ein Alias erbt sonst die lose Textprüfung und umgeht das Enum).
          if (pp.ok) {
            const segs = pp.segments;
            if (
              datei === SITE_JSON &&
              segs.length === 2 &&
              segs[0] === "banner" &&
              typeof segs[1] === "string"
            ) {
              const bannerProblem = validateBannerValue(segs[1], wert);
              if (bannerProblem) return { fehler: `Banner: ${bannerProblem}` };
            }
          }
          // Feste Listen schon beim ersten Schritt ehrlich ablehnen statt
          // einen nicht fertigstellbaren Entwurf zu beginnen (gemeinsam mit
          // Publish: nur ausdrücklich modellierte Listen wachsen).
          if (verdict.creation?.kind === "append" && pp.ok) {
            const ctx = appendContextFor(pp.segments, built.live);
            if (ctx && !findListModel(datei, ctx.listCanonical)) {
              return { fehler: fixedListGrowError(datei, ctx.listCanonical) };
            }
          }
          const freeId = `${FREE_DRAFT_PREFIX}${datei}:${pfad}`;
          const { error } = await store.storeDraft(site.id, freeId, wert);
          if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
          // Status aus dem zusammengesetzten Entwurf (gilt auch für
          // Korrekturen begonnener Einträge, nicht nur frische Anhänge).
          const status = await statusAfterStore(datei, pfad);
          return {
            art: "frei",
            feldId: freeId,
            vorschau: "nach Veröffentlichen",
            meldung: `Entwurf für ${datei} (${pfad}) gespeichert, sichtbar nach dem Veröffentlichen.`,
            hinweis: status.hinweis,
            veroeffentlichbar: status.veroeffentlichbar,
          };
        }
        return { fehler: "Bitte feldId oder datei+pfad angeben." };
      },
    }),
    schreibeCode: tool({
      description: "Ändert eine Design-/Code-Datei als Entwurf (geht NICHT live). Ganzen neuen Datei-Inhalt übergeben.",
      inputSchema: z.object({
        datei: z.string().describe("Dateipfad, z. B. src/components/Header.astro"),
        inhalt: z.string().describe("Der komplette neue Datei-Inhalt"),
      }),
      execute: async ({ datei, inhalt }) => {
        if (!isAllowedCodePath(datei)) {
          return { fehler: `Die Datei "${datei}" darfst du nicht ändern (.env-Dateien mit Geheimnissen sind tabu).` };
        }
        if (inhalt.length > AI_MAX_FILE_CHARS) {
          return { fehler: "Die Datei ist zu groß. Bitte in kleinere Schritte aufteilen." };
        }
        if (findsSecret(inhalt)) {
          return { fehler: "Der Inhalt sieht nach Schlüssel oder Passwort aus. So etwas gehört niemals in Dateien." };
        }
        try {
          const original = await repo.readFile(site.repo_owner, site.repo_name, datei);
          if (breaksBridge(original, inhalt)) {
            return { fehler: "Der neue Inhalt würde die CMS-Vorschau-Brücke entfernen. Die muss bleiben – bitte Version mit Brücke einreichen." };
          }
        } catch (err) {
          return { fehler: `Original-Datei konnte nicht gelesen werden: ${err instanceof Error ? err.message : "unbekannt"}` };
        }
        const { error } = await store.storeCodeDraft(site.id, datei, inhalt);
        if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
        return { art: "code", datei, vorschau: "nach Veröffentlichen", meldung: `Design-Entwurf für ${datei} gespeichert, sichtbar nach dem Veröffentlichen.` };
      },
    }),
    schreibeFeldliste: tool({
      description: "Erweitert die Feldliste des Editors (nur wenn der Kunde wirklich neue Inhalte will). Ganzen neuen JSON-Inhalt übergeben.",
      inputSchema: z.object({ inhalt: z.string().describe("Der komplette neue Inhalt von src/content/cms.manifest.json") }),
      execute: async ({ inhalt }) => {
        const problem = validateManifestText(inhalt);
        if (problem) return { fehler: problem };
        const { error } = await store.storeCodeDraft(site.id, MANIFEST_PATH, inhalt);
        if (error) return { fehler: `Entwurf konnte nicht gespeichert werden: ${error.message}` };
        return { art: "manifest", datei: MANIFEST_PATH, vorschau: "nach Veröffentlichen", meldung: "Feldlisten-Entwurf gespeichert, aktiv nach dem Veröffentlichen." };
      },
    }),
    leseBilder: tool({
      description: "Listet bereits hochgeladene Bilder (zum Wiederverwenden statt neu hochladen).",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const urls = await store.listImages(site.id);
          if (urls.length === 0) {
            return { bilder: [], meldung: "Keine Bilder gefunden – Kunde muss erst welche hochladen." };
          }
          return { bilder: urls };
        } catch {
          return { bilder: [], meldung: "Bilder konnten nicht geladen werden." };
        }
      },
    }),
  };
}

export type AiTools = ReturnType<typeof buildAiTools>;
