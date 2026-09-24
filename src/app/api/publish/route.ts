import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOctokit, getManifestRaw, getRepoFile, normalizeManifest } from "@/lib/github";
import { getBySegments, parsePathSafe, setByPath } from "@/lib/json-path";
import { validateDraftValue, validateFinalJsonValue } from "@/lib/validate";
import {
  SITE_JSON,
  canonicalTarget,
  classifyFreeTarget,
  convertEditValue,
  extractRawFields,
  getBannerProblems,
  isAllowedFieldJsonFile,
  parseFreeDraftIdSafe,
  resolveEditType,
  validateBannerValue,
  validateFieldTargets,
  validateFullJsonDraft,
  validateListStructures,
} from "@/lib/content-guard";
import type { ResolvedTarget, TypeEntry } from "@/lib/content-guard";
import {
  AI_MAX_FILE_CHARS,
  MANIFEST_PATH,
  breaksBridge,
  findsSecret,
  isAllowedCodePath,
  isAllowedContentPath,
  validateManifestText,
} from "@/lib/ai";
import type { CodeDraft, Draft, Site } from "@/types/cms";
import { FREE_DRAFT_PREFIX } from "@/types/cms";

const COMMIT_MESSAGE = "cms: update content by client";
const BLOG_MD = /^src\/content\/blog\/[a-z0-9-]+\.md$/;

interface FileEdit {
  draftId: string;
  fieldId: string;
  path: string;
  value: string;
  label: string;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Nicht authentifiziert." }, { status: 401 });
    }

    let body: { siteId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Ungültiger Request-Body." }, { status: 400 });
    }

    const siteId = body.siteId;
    if (!siteId || typeof siteId !== "string") {
      return NextResponse.json({ error: "siteId fehlt." }, { status: 400 });
    }

    // Zugriff prüfen
    const { data: assignment } = await supabase
      .from("user_sites")
      .select("site_id")
      .eq("user_id", user.id)
      .eq("site_id", siteId)
      .maybeSingle();

    if (!assignment) {
      return NextResponse.json({ error: "Kein Zugriff auf diese Website." }, { status: 403 });
    }

    const { data: site, error: siteError } = await supabase
      .from("sites")
      .select("*")
      .eq("id", siteId)
      .single();

    if (siteError || !site) {
      return NextResponse.json({ error: "Website nicht gefunden." }, { status: 404 });
    }

    const typedSite = site as Site;

    // Alle Entwürfe dieser Site laden (Formular + freie KI-Pfade)
    const { data: drafts, error: draftsError } = await supabase
      .from("drafts")
      .select("*")
      .eq("site_id", siteId);

    if (draftsError) {
      return NextResponse.json(
        { error: `Entwürfe konnten nicht geladen werden: ${draftsError.message}` },
        { status: 500 }
      );
    }

    // Code-Entwürfe laden (Design, Feldliste, Blog – alles volle Dateien)
    const { data: codeRows } = await supabase.from("code_drafts").select("*").eq("site_id", siteId);
    const codeDrafts = (codeRows ?? []) as CodeDraft[];

    const typedDrafts = (drafts ?? []) as Draft[];
    if (typedDrafts.length === 0 && codeDrafts.length === 0) {
      return NextResponse.json({ message: "Keine unveröffentlichten Änderungen vorhanden." });
    }

    // Manifest vom Server laden (ein Abruf): Diese Definition gilt.
    // Vom Client kommen nur siteId – keine Dateipfade, Typen oder
    // Ersatz-Manifeste. Die Roh-Definition wird unten streng geprüft.
    const octokit = createOctokit();
    let manifestRaw: unknown;
    let manifest;
    try {
      const loaded = await getManifestRaw(octokit, typedSite.repo_owner, typedSite.repo_name);
      manifestRaw = loaded.parsed;
      manifest = normalizeManifest(manifestRaw);
    } catch (err) {
      return NextResponse.json(
        {
          error: `CMS-Manifest konnte nicht aus GitHub geladen werden: ${
            err instanceof Error ? err.message : "Unbekannter Fehler"
          }`,
        },
        { status: 502 }
      );
    }

    const fieldMap = new Map(
      manifest.sections.flatMap((s) => s.fields.map((f) => [f.id, f] as const))
    );

    // Effektives Manifest: Ein Manifest-Entwurf im selben Satz ersetzt die
    // Live-Definition. So bleiben zusammengehörige Manifest- und
    // Inhaltsänderungen im selben Satz möglich (z. B. neue Banner-Felder
    // plus Banner-Inhalte). Die strenge Prüfung folgt unten gegen den Kandidaten.
    let effectiveManifestRaw: unknown = manifestRaw;
    let effectiveNormalized = manifest;
    let effectiveFieldMap = fieldMap;
    const manifestDraft = codeDrafts.find((cd) => cd.file_path === MANIFEST_PATH);
    if (manifestDraft) {
      try {
        effectiveManifestRaw = JSON.parse(manifestDraft.content) as unknown;
      } catch {
        return NextResponse.json(
          { error: "Der Manifest-Entwurf enthält kein gültiges JSON. Entwürfe bleiben erhalten." },
          { status: 400 }
        );
      }
      effectiveNormalized = normalizeManifest(effectiveManifestRaw);
      effectiveFieldMap = new Map(
        effectiveNormalized.sections.flatMap((s) => s.fields.map((f) => [f.id, f] as const))
      );
    }

    // Aufgelöste Zieltypen je kanonischem Ziel (einheitlich für Manifestfeld,
    // freien Alias und vollständige Datei-Inhalte – dieselbe Auflösung wie im
    // Chat; ein Alias erbt Typ, Länge und Label des Felds).
    const typeMap = new Map<string, TypeEntry>();
    for (const f of effectiveNormalized.sections.flatMap((s) => s.fields)) {
      const c = canonicalTarget(f.file, f.path);
      if (c && !typeMap.has(c)) {
        typeMap.set(c, { type: f.type, maxLength: f.maxLength, label: f.label });
      }
    }

    /** Löst Typ, Länge und Label eines Entwurfs einheitlich auf (gemeinsame Logik). */
    const resolveEdit = (file: string, editPath: string, fieldId: string): ResolvedTarget => {
      const pp = parsePathSafe(editPath);
      if (!pp.ok) {
        const known = effectiveFieldMap.get(fieldId);
        if (known) {
          return { type: known.type, maxLength: known.maxLength, label: known.label, via: "manifest" };
        }
        return { type: "text", label: editPath, via: "frei" };
      }
      const r = resolveEditType(
        file,
        pp.segments,
        `${file}#${pp.canonical}`,
        typeMap,
        parsedJson.get(file)
      );
      return {
        type: r.type,
        maxLength: r.maxLength,
        label: r.label,
        via: r.via === "manifest" ? "manifest" : r.via === "banner" ? "banner" : "frei",
      };
    };

    // Erfüllte Alias-Entwürfe (gleicher Wert wie Manifest-Entwurf): werden nach
    // Erfolg mit aufgeräumt, damit keine erledigten Dubletten liegen bleiben.
    const fulfilledAliases: Array<{ id: string; value: string }> = [];

    // Entwürfe auflösen: Manifest-Feld, freier JSON-Pfad oder unbekannt.
    // Freie IDs ("json:<datei>:<pfad>") müssen der Dateisperre und der
    // Pfad-Sicherheit genügen – ein Verstoß bricht den gesamten Satz ab.
    // Unbekannte IDs ohne json-Präfix bleiben als Entwurf erhalten (wie bisher).
    const editsByFile = new Map<string, FileEdit[]>();
    const skipped: string[] = [];
    const targetErrors: string[] = [];
    const freeTargets: Array<{ draft: Draft; file: string; path: string }> = [];
    for (const draft of typedDrafts) {
      const field = effectiveFieldMap.get(draft.field_id);
      if (field) {
        const list = editsByFile.get(field.file) ?? [];
        list.push({
          draftId: draft.id,
          fieldId: field.id,
          path: field.path,
          value: draft.value,
          label: field.label,
        });
        editsByFile.set(field.file, list);
        continue;
      }
      if (draft.field_id.startsWith(FREE_DRAFT_PREFIX)) {
        const parsed = parseFreeDraftIdSafe(draft.field_id);
        if (!parsed.ok) {
          targetErrors.push(parsed.error);
          continue;
        }
        freeTargets.push({ draft, file: parsed.file, path: parsed.path });
        continue;
      }
      skipped.push(draft.field_id);
    }

    // Freie Ziele: kein stiller Doppel mit einem Manifest-ENTWURF desselben
    // Satzes (gleicher Wert = überflüssig, anderer Wert = Konflikt mit 400).
    // Schreibweisen-normiert vergleichen (items[0].x und items.0.x sind
    // dasselbe Ziel). Überschneidung mit bloß deklarierten Manifestfeldern
    // ist kein Fehler – sie wird über akzeptierte Erstellungen abgedeckt.
    const manifestEditTargets = new Map<string, string>();
    for (const [file, fileEdits] of editsByFile) {
      for (const edit of fileEdits) {
        const editCanonical = canonicalTarget(file, edit.path);
        if (editCanonical && !manifestEditTargets.has(editCanonical)) {
          manifestEditTargets.set(editCanonical, edit.value);
        }
      }
    }
    const seenFreeCanonicals = new Set<string>();
    for (const free of freeTargets) {
      const canonical = canonicalTarget(free.file, free.path);
      if (!canonical) {
        targetErrors.push(`Entwurf "${free.draft.field_id}": ungültiger Pfad.`);
        continue;
      }
      const manifestValue = manifestEditTargets.get(canonical);
      if (manifestValue !== undefined) {
        if (manifestValue !== free.draft.value) {
          targetErrors.push(
            `Entwurf "${free.draft.field_id}": Das Ziel wird in diesem Satz bereits anders beschrieben – bitte nur eine Stelle ändern.`
          );
        } else {
          // Gleicher Wert: Der Manifest-Entwurf deckt es ab – der Alias gilt
          // als erfüllt und wird nach Erfolg mit aufgeräumt.
          fulfilledAliases.push({ id: free.draft.id, value: free.draft.value });
        }
        continue;
      }
      if (seenFreeCanonicals.has(canonical)) {
        targetErrors.push(
          `Entwurf "${free.draft.field_id}": Das Ziel ist in diesem Satz doppelt vergeben (andere Schreibweise desselben Pfads?).`
        );
        continue;
      }
      seenFreeCanonicals.add(canonical);
      const list = editsByFile.get(free.file) ?? [];
      list.push({
        draftId: free.draft.id,
        fieldId: free.draft.field_id,
        path: free.path,
        value: free.draft.value,
        label: free.path,
      });
      editsByFile.set(free.file, list);
    }

    // Vollständige Datei-Entwürfe prüfen (Whitelist, Größe, Geheimnisse).
    // JSON-Inhaltsdateien müssen zusätzlich der Dateisperre für normale
    // Inhaltsziele genügen und saubere Objekte sein – sonst ließe sich die
    // Inhaltsprüfung über einen Komplett-Entwurf umgehen. Alles vor jedem Commit.
    const codeByFile = new Map<string, CodeDraft>();
    for (const cd of codeDrafts) {
      const isManifest = cd.file_path === MANIFEST_PATH;
      const isContent = isAllowedContentPath(cd.file_path);
      const isCode = isAllowedCodePath(cd.file_path);
      const isBlog = BLOG_MD.test(cd.file_path);
      if (!isManifest && !isContent && !isCode && !isBlog) {
        return NextResponse.json(
          { error: `Die Datei "${cd.file_path}" darf nicht veröffentlicht werden (Tabu-Bereich). Entwurf wurde nicht angerührt.` },
          { status: 400 }
        );
      }
      if (cd.content.length > AI_MAX_FILE_CHARS) {
        return NextResponse.json(
          { error: `Die Datei "${cd.file_path}" ist zu groß. Bitte in kleinere Schritte aufteilen.` },
          { status: 400 }
        );
      }
      if (findsSecret(cd.content)) {
        return NextResponse.json(
          { error: `Die Datei "${cd.file_path}" sieht nach Schlüssel oder Passwort aus. So etwas gehört niemals in Dateien.` },
          { status: 400 }
        );
      }
      if (isManifest) {
        const problem = validateManifestText(cd.content);
        if (problem) {
          return NextResponse.json(
            { error: `Die neue Feldliste ist ungültig: ${problem}` },
            { status: 400 }
          );
        }
      }
      if (isContent && cd.file_path.endsWith(".json") && !isManifest) {
        if (!isAllowedFieldJsonFile(cd.file_path)) {
          return NextResponse.json(
            { error: `Die Datei "${cd.file_path}" ist kein erlaubtes Inhaltsziel (erlaubt: src/content/site.json und JSON-Dateien unter src/content/pages/). Entwurf wurde nicht angerührt.` },
            { status: 400 }
          );
        }
        const problem = validateFullJsonDraft(cd.content);
        if (problem) {
          return NextResponse.json(
            { error: `Die Datei "${cd.file_path}" kann so nicht übernommen werden: ${problem} Entwurf wurde nicht angerührt.` },
            { status: 400 }
          );
        }
      }
      codeByFile.set(cd.file_path, cd);
    }

    // Nichts zu tun? Dann ehrlich melden (kein stilles "Erfolg").
    // Hinweis: Unbekannte Entwurfs-IDs landen in "skipped" und werden in der
    // Antwort offengelegt; alle anderen Fehler brechen unten bereits ab.
    if (editsByFile.size === 0 && codeByFile.size === 0 && targetErrors.length === 0) {
      const skippedNote =
        skipped.length > 0
          ? ` (${skipped.length} Eintrag/Einträge ohne Zuordnung bleiben als Entwurf erhalten).`
          : "";
      return NextResponse.json({
        message: `Keine unveröffentlichten Änderungen vorhanden.${skippedNote}`,
      });
    }

    // Phase 1: ALLE Dateien vorab laden. Erst wenn alles ok ist, wird committet.
    // Neben den Entwurfs-Dateien werden alle erlaubten Manifestdateien geladen,
    // damit die Pfad-Existenz jedes Felds prüfbar ist. Unerlaubte Manifestziele
    // werden gar nicht erst aus dem Repo gelesen (sie landen als Fehler unten).
    const committedFields: string[] = [];
    const committedDraftIds: string[] = [];
    const committedFiles: string[] = [];
    const payload: Record<string, Record<string, unknown>> = {};
    let lastCommitSha: string | null = null;

    const loadFiles = new Set<string>();
    for (const entry of extractRawFields(effectiveManifestRaw)) {
      const file = (entry as { file?: unknown })?.file;
      if (typeof file === "string" && isAllowedFieldJsonFile(file)) loadFiles.add(file);
    }
    for (const filePath of editsByFile.keys()) {
      if (isAllowedFieldJsonFile(filePath)) loadFiles.add(filePath);
    }
    for (const filePath of codeByFile.keys()) loadFiles.add(filePath);

    const baseFiles = new Map<string, { text: string; sha: string }>();
    for (const filePath of loadFiles) {
      try {
        const file = await getRepoFile(octokit, typedSite.repo_owner, typedSite.repo_name, filePath);
        baseFiles.set(filePath, {
          text: file.text,
          sha: file.sha,
        });
      } catch (err) {
        // Blog-Artikel dürfen neu sein (Datei existiert noch nicht)
        if (BLOG_MD.test(filePath)) {
          baseFiles.set(filePath, { text: "", sha: "" });
          continue;
        }
        return NextResponse.json(
          {
            error: `Datei "${filePath}" konnte nicht aus GitHub geladen werden: ${
              err instanceof Error ? err.message : "Unbekannter Fehler"
            }`,
          },
          { status: 502 }
        );
      }
    }

    // Server-Manifest gegen die geladenen Inhalte prüfen (Struktur, Typen,
    // Dateisperre, Duplikate, Pfad-Existenz) – vor jedem Repository-Schreibvorgang.
    const parsedJson = new Map<string, Record<string, unknown>>();
    for (const [filePath, base] of baseFiles) {
      if (!filePath.endsWith(".json") || BLOG_MD.test(filePath)) continue;
      try {
        parsedJson.set(filePath, JSON.parse(base.text) as Record<string, unknown>);
      } catch {
        return NextResponse.json(
          { error: `Die Datei "${filePath}" enthält kein gültiges JSON und kann nicht gespeichert werden. Entwürfe bleiben erhalten.` },
          { status: 400 }
        );
      }
    }

    // Freie Ziele einordnen: Bestand schreiben oder ausdrücklich freigegebene
    // Erstellung (Banner-Felder, Listen-Ergänzung). Akzeptierte Erstellungen
    // decken passende Manifestfeld-Pfade im selben Satz ab. Ob eine
    // Listen-Ergänzung veröffentlichbar ist, prüft erst die gemeinsame
    // Strukturprüfung am fertigen Kandidaten (feste Listen wachsen nicht).
    const pendingCreations = new Set<string>();
    for (const [filePath, fileEdits] of editsByFile) {
      for (const edit of fileEdits) {
        if (effectiveFieldMap.has(edit.fieldId)) continue;
        const verdict = classifyFreeTarget(filePath, edit.path, parsedJson.get(filePath), edit.value);
        if (!verdict.ok) {
          targetErrors.push(`Entwurf "${edit.fieldId}": ${verdict.error}`);
          continue;
        }
        if (verdict.creation) {
          pendingCreations.add(verdict.creation.canonical);
        }
      }
    }

    // Einheitliche Wertprüfung je Entwurf (Manifestfeld UND freier Alias):
    // Typ, Länge und Banner-Regeln gelten unabhängig vom Zugriffsweg.
    const valueErrors: string[] = [];
    for (const [filePath, fileEdits] of editsByFile) {
      for (const edit of fileEdits) {
        const resolved = resolveEdit(filePath, edit.path, edit.fieldId);
        const problem = validateDraftValue(resolved.type, edit.value, resolved.maxLength);
        if (problem) {
          valueErrors.push(`${resolved.label}: ${problem}`);
          continue;
        }
        const pp = parsePathSafe(edit.path);
        if (
          filePath === SITE_JSON &&
          pp.ok &&
          pp.segments.length === 2 &&
          pp.segments[0] === "banner" &&
          typeof pp.segments[1] === "string"
        ) {
          const bannerProblem = validateBannerValue(pp.segments[1], edit.value);
          if (bannerProblem) valueErrors.push(`Banner: ${bannerProblem}`);
        }
      }
    }

    // Kandidat zusammenbauen (noch ungeprüft): Voll-Entwurf als Basis, dann
    // alle Entwürfe mit einheitlich aufgelöster Typ-Umwandlung einarbeiten.
    // Erst dieser Stand wird streng geprüft – nicht alte Dateien.
    const candidateJson = new Map<string, Record<string, unknown>>();
    const candidateErrors: string[] = [];
    for (const [filePath, live] of parsedJson) {
      const code = codeByFile.get(filePath);
      if (code) {
        try {
          const parsed = JSON.parse(code.content) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            candidateErrors.push(`Die Datei "${filePath}" muss ein JSON-Objekt sein.`);
            continue;
          }
          candidateJson.set(filePath, parsed as Record<string, unknown>);
        } catch {
          candidateErrors.push(`Die Datei "${filePath}" enthält kein gültiges JSON.`);
        }
      } else {
        candidateJson.set(filePath, structuredClone(live));
      }
    }
    for (const [filePath, fileEdits] of editsByFile) {
      const cand = candidateJson.get(filePath);
      if (!cand) continue; // Unerlaubte Datei – Strukturfehler folgt unten.
      for (const edit of fileEdits) {
        const label = resolveEdit(filePath, edit.path, edit.fieldId).label;
        try {
          setByPath(cand, edit.path, convertEditValue(filePath, edit.path, edit.value, typeMap, parsedJson.get(filePath)));
        } catch (err) {
          candidateErrors.push(
            `Feld "${label}": ${err instanceof Error ? err.message : "Pfad konnte nicht geschrieben werden."}`
          );
        }
      }
    }

    // Strenge Prüfung des EFFEKTIVEN Manifests gegen den KANDIDATEN:
    // IDs, Typen, Duplikate, erlaubte Dateien, sämtliche Feldziele im neuen
    // Stand. So fällt z. B. ein home.json-Entwurf mit {} auf (Ziele entfallen)
    // und ein Manifest-Entwurf mit package.json-Ziel wird abgewiesen.
    const strictErrors = validateFieldTargets(
      extractRawFields(effectiveManifestRaw),
      candidateJson,
      pendingCreations
    );

    // Werte im Kandidaten gegen die deklarierten Typen prüfen – einheitlich
    // und streng für Feldentwürfe, freie Aliase (erben Typ/Länge) und volle
    // Dateien: Zahlen sind echte Zahlen, Booleans echte Booleans, Text bleibt
    // Text, null/leer ist hier nicht erlaubt.
    for (const f of effectiveNormalized.sections.flatMap((s) => s.fields)) {
      if (!isAllowedFieldJsonFile(f.file)) continue;
      const cand = candidateJson.get(f.file);
      if (!cand) continue;
      const v = getBySegments(cand, (() => {
        const pp = parsePathSafe(f.path);
        return pp.ok ? pp.segments : [];
      })());
      if (v === undefined && parsePathSafe(f.path).ok) {
        strictErrors.push(
          `Feld "${f.label}": Pfad "${f.path}" fehlt im neuen Stand von "${f.file}" – die Änderung passt nicht zum Content-Modell.`
        );
        continue;
      }
      if (v === undefined) continue;
      const problem = validateFinalJsonValue(f.type, v, f.maxLength);
      if (problem) strictErrors.push(`Feld "${f.label}": ${problem}`);
    }

    // Banner-Endstand im Kandidaten – gilt immer bei vorhandenem Banner,
    // auch ausgeschaltet (gemeinsame Prüfung wie im Chat).
    const siteCand = candidateJson.get(SITE_JSON);
    if (siteCand && siteCand.banner !== undefined) {
      strictErrors.push(...getBannerProblems(siteCand.banner));
    }

    // Listen-Strukturen im GESAMTEN Kandidaten (gemeinsame Prüfung wie im
    // Chat): kein Sonderweg für vollständige Dateien – feste Listen wachsen
    // nicht, dynamische nur modellvollständig am Ende.
    strictErrors.push(...validateListStructures(parsedJson, candidateJson));

    const blockingErrors = [...targetErrors, ...candidateErrors, ...strictErrors, ...valueErrors];
    if (blockingErrors.length > 0) {
      return NextResponse.json(
        {
          error: `Bitte korrigiere zuerst diese Punkte (es wurde nichts veröffentlicht, Entwürfe bleiben erhalten):\n- ${blockingErrors.join("\n- ")}`,
        },
        { status: 400 }
      );
    }

    // Abschluss: Der geprüfte Kandidat wird versandfertig gemacht – nur
    // Dateien mit Entwürfen. JSON kommt aus dem Kandidaten, Text-Dateien
    // (Blog, Code) komplett aus dem Entwurf (Brücken-Check wie bisher).
    const finalContent = new Map<string, { text: string; kind: "json" | "text" }>();
    for (const [filePath, cand] of candidateJson) {
      if (!editsByFile.has(filePath) && !codeByFile.has(filePath)) continue;
      finalContent.set(filePath, { text: JSON.stringify(cand, null, 2), kind: "json" });
      payload[filePath] = cand;
    }
    const bridgeErrors: string[] = [];
    for (const [filePath, code] of codeByFile) {
      if (filePath.endsWith(".json")) continue;
      const base = baseFiles.get(filePath);
      if (!base) {
        skipped.push(filePath);
        continue;
      }
      if (isAllowedCodePath(filePath) && breaksBridge(base.text, code.content)) {
        bridgeErrors.push(
          `Die Datei "${filePath}" würde die CMS-Vorschau-Brücke entfernen. So kann sie nicht live gehen – bitte Version mit Brücke einreichen.`
        );
        continue;
      }
      finalContent.set(filePath, { text: code.content, kind: "text" });
    }
    if (bridgeErrors.length > 0) {
      return NextResponse.json(
        {
          error: `Bitte korrigiere zuerst diese Punkte (es wurde nichts veröffentlicht, Entwürfe bleiben erhalten):\n- ${bridgeErrors.join("\n- ")}`,
        },
        { status: 400 }
      );
    }

    // Phase 2: jetzt erst committen (alles wurde oben geprüft)
    for (const [filePath, final] of finalContent) {
      const base = baseFiles.get(filePath)!;
      try {
        const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
          owner: typedSite.repo_owner,
          repo: typedSite.repo_name,
          path: filePath,
          message: COMMIT_MESSAGE,
          content: Buffer.from(final.text, "utf-8").toString("base64"),
          ...(base.sha ? { sha: base.sha } : {}),
          branch: "main",
        });
        lastCommitSha = commitData.commit.sha ?? null;
      } catch (err) {
        return NextResponse.json(
          {
            error: `GitHub-Commit für "${filePath}" fehlgeschlagen: ${
              err instanceof Error ? err.message : "Unbekannter Fehler"
            }`,
          },
          { status: 502 }
        );
      }
      if (final.kind === "text") {
        // Text-Dateien als Rohtext sichern (für echtes Wiederherstellen)
        payload[filePath] = { __text: final.text };
      }
      committedFiles.push(filePath);
      const edits = editsByFile.get(filePath) ?? [];
      committedFields.push(...edits.map((e) => e.label));
      committedDraftIds.push(...edits.map((e) => e.draftId));
    }

    // Snapshot in publish_history speichern (vollständiger Stand pro Datei)
    const { error: historyError } = await supabase.from("publish_history").insert({
      site_id: siteId,
      published_by: user.id ?? null,
      commit_sha: lastCommitSha,
      payload,
    });

    if (historyError) {
      console.error("publish_history insert fehlgeschlagen:", historyError);
      return NextResponse.json(
        {
          error: `Die Änderungen wurden zu GitHub übertragen, aber der Verlaufseintrag konnte nicht gespeichert werden: ${historyError.message}`,
        },
        { status: 500 }
      );
    }

    console.log(
      `publish_history: Eintrag für Site ${siteId} gespeichert (Commit ${lastCommitSha ?? "unbekannt"}, ${committedFiles.length} Datei(en))`
    );

    // Publizierte Entwürfe löschen – nur exakt die committeten IDs/Dateien
    if (committedDraftIds.length > 0) {
      const { error: deleteError } = await supabase
        .from("drafts")
        .delete()
        .eq("site_id", siteId)
        .in("id", committedDraftIds);
      if (deleteError) {
        console.error("drafts delete fehlgeschlagen:", deleteError.message);
      }
    }
    if (committedFiles.length > 0) {
      const { error: codeDeleteError } = await supabase
        .from("code_drafts")
        .delete()
        .eq("site_id", siteId)
        .in("file_path", committedFiles);
      if (codeDeleteError) {
        console.error("code_drafts delete fehlgeschlagen:", codeDeleteError.message);
      }
    }

    // Erfüllte Alias-Entwürfe aufräumen: Sie wurden durch den gleichwertigen
    // Manifest-Entwurf miterfüllt. Gelöscht wird nur, wessen Wert sich
    // seitdem nicht geändert hat (kein Pauschal-Löschen, kein Fremdverlust).
    // Grenze: Gleichzeitige parallele Veröffentlichungen bleiben ein eigenes Thema.
    let cleanedAliases = 0;
    if (fulfilledAliases.length > 0) {
      const aliasIds = fulfilledAliases.map((a) => a.id);
      const { data: aliasRows } = await supabase
        .from("drafts")
        .select("id,value")
        .eq("site_id", siteId)
        .in("id", aliasIds);
      const stillSame = ((aliasRows ?? []) as Array<{ id: string; value: string }>)
        .filter((row) => fulfilledAliases.some((a) => a.id === row.id && a.value === row.value))
        .map((row) => row.id);
      if (stillSame.length > 0) {
        const { error: aliasDeleteError } = await supabase
          .from("drafts")
          .delete()
          .eq("site_id", siteId)
          .in("id", stillSame);
        if (aliasDeleteError) {
          console.error("alias drafts delete fehlgeschlagen:", aliasDeleteError.message);
        } else {
          cleanedAliases = stillSame.length;
        }
      }
    }

    const skippedNote =
      skipped.length > 0
        ? ` ${skipped.length} Eintrag/Einträge ohne Zuordnung wurden übersprungen.`
        : "";
    const aliasNote =
      cleanedAliases > 0
        ? ` Gleichwertige Dubletten wurden mit aufgeräumt (${cleanedAliases}).`
        : "";

    return NextResponse.json({
      message: `${committedFiles.length} Datei(en) veröffentlicht.${skippedNote}${aliasNote}`,
      publishedFields: committedFields,
      publishedFiles: committedFiles,
      // Echter Versions-Stempel für den Aufbau-Check (Vercel meldet den Bau-Status daran)
      commitSha: lastCommitSha,
    });
  } catch (err) {
    console.error("Publish fehlgeschlagen:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Interner Serverfehler." },
      { status: 500 }
    );
  }
}
