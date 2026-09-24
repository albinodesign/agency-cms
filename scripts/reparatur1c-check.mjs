/**
 * Nachprüfung 1c: einheitliche Zielregeln, Kandidaten-Prüfung, Chat-Anbindung,
 * Alias-Aufräumen und große Feldbestände – gegen echte Routen-/Werkzeugfunktionen.
 *
 * Teil U:Alle Abnahmen nutzen lokale Adapter (kein Netz, keine Produktion).
 * Teil U: Schutzprimitive (Typ-Auflösung, Umwandlung, Werte, Listen-Modell).
 * Teil R: echter Publish-Handler mit gefakten GitHub-/Supabase-Adaptern.
 * Teil P: echte KI-Werkzeuge (buildAiTools) mit lokalen Speicher-/Repo-Fakes.
 *
 * Fixture "bewertungen.json": unverfälschte testimonials-Struktur der
 * Demo-Website (3 Einträge, Schlüssel quote/author/rating/location).
 *
 * Start: npm run test:reparatur1c
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = path.join(root, ".tmp-rep1c");
const tsconfigPath = path.join(root, ".tmp-rep1c-tsconfig.json");

let passed = 0;
let failed = 0;
function ok(condition, name) {
  if (!condition) {
    failed += 1;
    process.exitCode = 1;
    console.error(`FEHLGESCHLAGEN: ${name}`);
  } else {
    passed += 1;
    console.log(`ok: ${name}`);
  }
}

function walk(dir, name, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, name, out);
    else if (entry.name === name) out.push(full);
  }
  return out;
}

// Unverfälschte testimonials-Fixture aus der Demo-Website (demo3, home.json).
const DEMO_TESTIMONIALS = {
  items: [
    {
      quote: "Vom Aufmaß bis zur Montage hat alles reibungslos geklappt. Die neuen Fenster sind top – und die Wohnung bleibt endlich warm.",
      author: "S. Meyer",
      rating: 5,
      location: "Hannover-List",
    },
    {
      quote: "Unsere alte Haustür war ein Sicherheitsrisiko. Klarwerk hat in einem Tag eine neue Tür mit Einbruchschutz montiert. Absolut empfehlenswert.",
      author: "T. und K. Brandt",
      rating: 5,
      location: "Hannover-Bothfeld",
    },
    {
      quote: "Fester Preis, festes Datum, saubere Arbeit. Genau so stellt man sich Handwerk vor. Die 25 Jahre Garantie gibt es schriftlich dazu.",
      author: "M. Yilmaz",
      rating: 5,
      location: "Hannover-Vahrenwald",
    },
  ],
  title: "Das sagen unsere Kunden",
  subtitle: "Über 800 Bewertungen aus Hannover und Umgebung – durchschnittlich 4,9 von 5 Sternen.",
};

async function main() {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        baseUrl: root,
        paths: { "@/*": ["src/*"] },
        outDir: tmp,
        rootDir: "src",
        module: "commonjs",
        target: "es2020",
        moduleResolution: "node",
        skipLibCheck: true,
        strict: true,
        esModuleInterop: true,
      },
      include: [
        "src/app/api/publish/route.ts",
        "src/lib/ai-tools.ts",
        "src/lib/json-path.ts",
        "src/lib/content-guard.ts",
        "src/lib/validate.ts",
        "src/lib/github.ts",
        "src/lib/ai.ts",
        "src/types/cms.ts",
      ],
    })
  );
  execSync(`npx tsc -p ${tsconfigPath}`, { cwd: root, stdio: "inherit" });

  const guard = require(path.join(tmp, "lib", "content-guard.js"));
  const validate = require(path.join(tmp, "lib", "validate.js"));

  // ---------- Teil U: Primitive ----------
  {
    const byCanon = new Map([
      ["src/content/pages/home.json#hero.kurz", { id: "kurz", label: "Kurz", type: "text", file: "src/content/pages/home.json", path: "hero.kurz", maxLength: 5 }],
      ["src/content/pages/preise.json#preis.betrag", { id: "betrag", label: "Preis", type: "number", file: "src/content/pages/preise.json", path: "preis.betrag" }],
    ]);
    const r1 = guard.resolveTargetType("src/content/pages/home.json#hero.kurz", byCanon, "src/content/pages/home.json", ["hero", "kurz"]);
    ok(r1.type === "text" && r1.maxLength === 5 && r1.via === "manifest", "U1 Alias erbt Typ/Länge/Label");
    const r2 = guard.resolveTargetType("src/content/pages/preise.json#preis.betrag", byCanon, "src/content/pages/preise.json", ["preis", "betrag"]);
    ok(r2.type === "number", "U2 Alias erbt Zahltyp");
    const r3 = guard.resolveTargetType("src/content/site.json#banner.enabled", new Map(), "src/content/site.json", ["banner", "enabled"]);
    ok(r3.type === "boolean" && r3.via === "banner", "U3 Banner-Schalter löst zu Boolean auf");
    ok(validate.convertStoredValue("text", "true") === "true", "U4 Text-true bleibt Text");
    ok(validate.convertStoredValue("boolean", "true") === true, "U5 Boolean-true wird Boolean");
    ok(validate.convertStoredValue("number", "19,90") === 19.9, "U6 Zahl mit Komma wird Zahl");
    ok(validate.validateJsonValue("number", 19.9) === null, "U7 Zahlwert ok");
    ok(validate.validateJsonValue("number", "abc") !== null, "U8 Text als Zahl abgelehnt");
    ok(validate.validateJsonValue("boolean", true) === null, "U9 Boolean ok");
    ok(validate.validateJsonValue("text", "123456", 5) !== null, "U10 maxLength greift");
    ok(JSON.stringify(guard.inferRequiredKeys(DEMO_TESTIMONIALS.items)) === JSON.stringify(["quote", "author", "rating", "location"]), "U11 Pflichtschlüssel aus Demo-Modell");
    ok(guard.inferRequiredKeys([]).length === 0, "U12 leere Liste = unbekanntes Modell");
    ok(guard.validateBannerValue("variant", "party") !== null, "U13 Banner-Stil party abgelehnt");
  }

  // ---------- Teil R/P: Adapter-Harness ----------
  const routeJs = walk(tmp, "route.js").find((p) => p.includes("publish"));
  const toolsJs = walk(tmp, "ai-tools.js")[0];
  if (!routeJs) throw new Error("kompilierte Publish-Route nicht gefunden");
  if (!toolsJs) throw new Error("kompiliertes ai-tools-Modul nicht gefunden");
  const compiledBase = routeJs.split(`${path.sep}app${path.sep}`)[0];

  const stubDir = path.join(tmp, "stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "next-server.js"),
    `module.exports = { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body, json: async () => body }) } };\n`
  );
  fs.writeFileSync(
    path.join(stubDir, "supabase-server.js"),
    `function rows(db, t) { return db.tables[t]; }
class Q {
  constructor(db, t) { this.db = db; this.t = t; this.filters = []; this.op = "select"; }
  select() { return this; }
  eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
  in(k, a) { this.filters.push((r) => a.includes(r[k])); return this; }
  match(r) { return this.filters.every((f) => f(r)); }
  async maybeSingle() { const h = rows(this.db, this.t).find((r) => this.match(r)); return { data: h || null }; }
  async single() { const h = rows(this.db, this.t).find((r) => this.match(r)); return h ? { data: h, error: null } : { data: null, error: { message: "nichts gefunden" } }; }
  async insert(o) { const row = Object.assign({ id: "gen-" + Math.random().toString(36).slice(2, 10) }, o); rows(this.db, this.t).push(row); return { data: row, error: null }; }
  delete() { this.op = "delete"; return this; }
  then(res, rej) {
    try {
      if (this.op === "delete") {
        const arr = rows(this.db, this.t);
        const keep = arr.filter((r) => !this.match(r));
        this.db.tables[this.t] = keep;
        res({ error: null, count: arr.length - keep.length });
      } else {
        res({ data: rows(this.db, this.t).filter((r) => this.match(r)), error: null });
      }
    } catch (e) { rej(e); }
  }
}
module.exports = {
  createClient() {
    const db = globalThis.__FAKE_DB__;
    return { auth: { getUser: async () => ({ data: { user: db.user } }) }, from: (t) => new Q(db, t) };
  },
};\n`
  );
  const realGithub = walk(tmp, "github.js").find((p) => p.includes(`${path.sep}lib${path.sep}`));
  if (!realGithub) throw new Error("kompiliertes github-Modul nicht gefunden");
  process.env.REP1C_REAL_GITHUB = realGithub;
  fs.writeFileSync(
    path.join(stubDir, "github.js"),
    `const real = require(process.env.REP1C_REAL_GITHUB);
module.exports = Object.assign({}, real, {
  createOctokit() {
    return {
      repos: {
        async createOrUpdateFileContents({ path: p, content, message }) {
          const text = Buffer.from(content, "base64").toString("utf8");
          globalThis.__FAKE_REPO__.set(p, text);
          const sha = "commit-" + globalThis.__FAKE_COMMITS__.length;
          globalThis.__FAKE_COMMITS__.push({ path: p, message, sha });
          return { data: { commit: { sha } } };
        },
      },
    };
  },
  async getRepoFile(octokit, owner, repo, p) {
    const m = globalThis.__FAKE_REPO__;
    if (!m.has(p)) { const e = new Error('Datei "' + p + '" fehlt'); e.status = 404; throw e; }
    return { text: m.get(p), sha: "sha-" + p.length + "-" + m.get(p).length };
  },
  async getManifestRaw(octokit, owner, repo) {
    const f = await module.exports.getRepoFile(octokit, owner, repo, real.MANIFEST_PATH);
    return { text: f.text, parsed: JSON.parse(f.text) };
  },
});\n`
  );

  const STUB_NEXT = path.join(stubDir, "next-server.js");
  const STUB_SUPA = path.join(stubDir, "supabase-server.js");
  const STUB_GH = path.join(stubDir, "github.js");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "next/server") return require(STUB_NEXT);
    if (request === "@/lib/supabase/server") return require(STUB_SUPA);
    if (request === "@/lib/github") return require(STUB_GH);
    if (request.startsWith("@/")) {
      return origLoad.call(this, path.join(compiledBase, request.slice(2)), parent, isMain);
    }
    return origLoad.call(this, request, parent, isMain);
  };

  const route = require(routeJs);
  const { buildAiTools } = require(toolsJs);

  const BASE_MANIFEST = {
    sections: [
      {
        id: "haupt",
        title: "Haupt",
        fields: [
          { id: "hero.title", label: "Titel", type: "text", file: "src/content/pages/home.json", path: "hero.title", maxLength: 90 },
          { id: "hero.kurz", label: "Kurz", type: "text", file: "src/content/pages/home.json", path: "hero.kurz", maxLength: 5 },
          { id: "preis.betrag", label: "Preis", type: "number", file: "src/content/pages/preise.json", path: "preis.betrag" },
        ],
      },
    ],
  };
  const BASE_FILES = {
    "src/content/pages/home.json": JSON.stringify({ hero: { title: "Alt", kurz: "ok" } }),
    "src/content/pages/preise.json": JSON.stringify({ preis: { betrag: 10 } }),
    "src/content/site.json": JSON.stringify({ titel: "Firma" }),
  };

  async function runScenario({ manifest, files, drafts, codeDrafts }) {
    globalThis.__FAKE_REPO__ = new Map(
      Object.entries(Object.assign({}, files, { "src/content/cms.manifest.json": JSON.stringify(manifest) }))
    );
    globalThis.__FAKE_COMMITS__ = [];
    globalThis.__FAKE_DB__ = {
      user: { id: "u1" },
      tables: {
        user_sites: [{ user_id: "u1", site_id: "site-1" }],
        sites: [{ id: "site-1", name: "Test", repo_owner: "o", repo_name: "r", preview_url: "https://x", ai_enabled: true }],
        drafts: drafts.map((d, i) => ({ id: `draft-${i}`, site_id: "site-1", field_id: d[0], value: d[1], updated_at: "" })),
        code_drafts: codeDrafts.map((c, i) => ({ id: `code-${i}`, site_id: "site-1", file_path: c[0], content: c[1], updated_at: "" })),
        publish_history: [],
      },
    };
    const req = new Request("http://test/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId: "site-1" }),
    });
    const res = await route.POST(req);
    return {
      status: res.status,
      body: res.body,
      commits: globalThis.__FAKE_COMMITS__,
      draftsLeft: globalThis.__FAKE_DB__.tables.drafts.length,
      codeLeft: globalThis.__FAKE_DB__.tables.code_drafts.length,
      repo: new Map(globalThis.__FAKE_REPO__),
    };
  }

  // R-U1: freier Alias umgeht maxLength nicht mehr
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["json:src/content/pages/home.json:hero.kurz", "viel zu lang für fünf Zeichen"]],
      codeDrafts: [],
    });
    ok(r.status === 400 && /zu lang/.test(r.body.error || ""), "R-U1 Alias-maxLength -> 400");
    ok(r.commits.length === 0 && r.draftsLeft === 1, "R-U1 kein Write, Entwurf bleibt");
  }

  // R-U2: vorhandenes Banner mit party / Überlänge
  {
    const withBanner = Object.assign({}, BASE_FILES, {
      "src/content/site.json": JSON.stringify({ titel: "F", banner: { enabled: true, variant: "vacation", text: "ok" } }),
    });
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: withBanner,
      drafts: [["json:src/content/site.json:banner.variant", "party"]],
      codeDrafts: [],
    });
    ok(r.status === 400 && r.commits.length === 0, "R-U2 Banner party auf Bestand -> 400 ohne Write");
    const r2 = await runScenario({
      manifest: BASE_MANIFEST,
      files: withBanner,
      drafts: [["json:src/content/site.json:banner.text", "x".repeat(200)]],
      codeDrafts: [],
    });
    ok(r2.status === 400 && r2.commits.length === 0, "R-U2 Banner-Überlänge auf Bestand -> 400 ohne Write");
  }

  // R-U3: Text "true" bleibt Text
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["hero.title", "true"]],
      codeDrafts: [],
    });
    const stored = JSON.parse(r.repo.get("src/content/pages/home.json")).hero.title;
    ok(r.status === 200 && stored === "true", "R-U3 Text-true bleibt Text");
  }

  // R-U4: freier Alias auf Zahlfeld speichert Zahl
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["json:src/content/pages/preise.json:preis.betrag", "19,90"]],
      codeDrafts: [],
    });
    const stored = JSON.parse(r.repo.get("src/content/pages/preise.json")).preis.betrag;
    ok(r.status === 200 && stored === 19.9, "R-U4 Alias-Zahl wird Zahl");
  }

  // R-R1: volle home.json mit {} trotz erforderlichem Ziel
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["preis.betrag", "12"]],
      codeDrafts: [["src/content/pages/home.json", "{}"]],
    });
    ok(r.status === 400 && /fehlt im neuen Stand/.test(r.body.error || ""), "R-R1 leere Voll-Datei -> 400");
    ok(r.commits.length === 0 && r.draftsLeft === 1 && r.codeLeft === 1, "R-R1 kein Write, alle Entwürfe bleiben");
  }

  // R-R2: neuer Manifest-Entwurf mit package.json-Ziel
  {
    const evilManifest = {
      sections: [{ id: "x", title: "X", fields: [{ id: "evil", label: "Böse", type: "text", file: "package.json", path: "scripts" }] }],
    };
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["preis.betrag", "12"]],
      codeDrafts: [["src/content/cms.manifest.json", JSON.stringify(evilManifest)]],
    });
    ok(r.status === 400 && /package\.json/.test(r.body.error || ""), "R-R2 Manifest-Entwurf mit package.json -> 400");
    ok(r.commits.length === 0 && r.draftsLeft === 1 && r.codeLeft === 1, "R-R2 kein Write, alle Entwürfe bleiben");
  }

  // R-R3: Demo-Listenmodell (unvollständig vs. vollständig vs. falscher Typ)
  {
    const files = Object.assign({}, BASE_FILES, {
      "src/content/pages/bewertungen.json": JSON.stringify({ testimonials: DEMO_TESTIMONIALS }),
    });
    const incomplete = await runScenario({
      manifest: BASE_MANIFEST,
      files,
      drafts: [["json:src/content/pages/bewertungen.json:testimonials.items[3].quote", "Toll!"]],
      codeDrafts: [],
    });
    ok(incomplete.status === 400 && /author/.test(incomplete.body.error || "") && /location/.test(incomplete.body.error || ""), "R-R3 unvollständige Ergänzung nennt fehlende Schlüssel");
    ok(incomplete.commits.length === 0, "R-R3 kein Write");
    const wrongType = await runScenario({
      manifest: BASE_MANIFEST,
      files,
      drafts: [
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].quote", "Toll!"],
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].author", "A"],
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].location", "B"],
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].rating", "fünf"],
      ],
      codeDrafts: [],
    });
    ok(wrongType.status === 400 && /Zahl/.test(wrongType.body.error || ""), "R-R3 falscher Typ (rating) -> 400");
    const complete = await runScenario({
      manifest: BASE_MANIFEST,
      files,
      drafts: [
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].quote", "Toll!"],
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].author", "A. Tester"],
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].location", "Hannover"],
        ["json:src/content/pages/bewertungen.json:testimonials.items[3].rating", "5"],
      ],
      codeDrafts: [],
    });
    const items = JSON.parse(complete.repo.get("src/content/pages/bewertungen.json")).testimonials.items;
    ok(complete.status === 200, "R-R3 vollständige Ergänzung -> 200");
    ok(items.length === 4 && items[3].rating === 5 && items[3].author === "A. Tester", "R-R3 neues Element vollständig + typgerecht");
  }

  // R-R4: gültiges Manifest samt Inhaltsänderung im selben Satz
  {
    const comboManifest = {
      sections: [
        { id: "haupt", title: "Haupt", fields: [{ id: "hero.title", label: "Titel", type: "text", file: "src/content/pages/home.json", path: "hero.title" }] },
        { id: "banner", title: "Banner", fields: [{ id: "site.banner.enabled", label: "Banner an", type: "boolean", file: "src/content/site.json", path: "banner.enabled" }] },
      ],
    };
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [
        ["hero.title", "Neu"],
        ["json:src/content/site.json:banner.enabled", "true"],
        ["json:src/content/site.json:banner.variant", "info"],
        ["json:src/content/site.json:banner.text", "Info"],
      ],
      codeDrafts: [["src/content/cms.manifest.json", JSON.stringify(comboManifest)]],
    });
    const site = JSON.parse(r.repo.get("src/content/site.json"));
    ok(r.status === 200, "R-R4 Manifest+Inhalt kombiniert -> 200");
    ok(site.banner && site.banner.enabled === true, "R-R4 Banner passt zum neuen Manifest");
  }

  // R-R5: Alias-Aufräumen bei gleichem Wert
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["hero.title", "Neu"], ["json:src/content/pages/home.json:hero.title", "Neu"]],
      codeDrafts: [],
    });
    ok(r.status === 200, "R-R5 gleichwertige Dubletten -> 200");
    ok(r.draftsLeft === 0, "R-R5 kein erledigter Alias bleibt liegen");
    ok(/Dubletten/.test(r.body.message || ""), "R-R5 Aufräumen wird gemeldet");
  }

  // ---------- Teil P: echte Werkzeuge ----------
  function toolHarness({ files, drafts, serverFields }) {
    const repo = new Map(Object.entries(files));
    const stored = drafts.map((d) => ({ field_id: d[0], value: d[1] }));
    const store = {
      async storeDraft(sid, fieldId, value) {
        stored.push({ field_id: fieldId, value });
        return { error: null };
      },
      async storeCodeDraft() {
        return { error: null };
      },
      async listDrafts() {
        return stored.map((d) => ({ field_id: d.field_id, value: d.value }));
      },
      async listImages() {
        return [];
      },
    };
    const repoReader = {
      async readFile(o, n, p) {
        if (!repo.has(p)) throw new Error("fehlt");
        return repo.get(p);
      },
      async listTree() {
        return [...repo.keys()];
      },
    };
    const tools = buildAiTools({
      site: { id: "site-1", repo_owner: "o", repo_name: "r" },
      serverFields,
      store,
      repo: repoReader,
    });
    return { tools, stored };
  }

  // P-P1: 500 Felder, spätes Feld hinter der Dateigrenze
  {
    const N = 500;
    const big = {};
    const fields = [];
    for (let i = 0; i < N; i += 1) {
      big[`k${i}`] = { v: `Wert-${i}-` + "x".repeat(150) };
      fields.push({ id: `f${i}`, label: `Feld ${i}`, type: "text", file: "src/content/pages/big.json", path: `k${i}.v` });
    }
    const { tools } = toolHarness({
      files: { "src/content/pages/big.json": JSON.stringify(big) },
      drafts: [],
      serverFields: fields,
    });
    const list = await tools.listeFelder.execute({});
    ok(list.felder && list.felder.length === 500, "P-P1 listeFelder liefert alle 500 IDs");
    const late = await tools.leseFeld.execute({ feldId: "f499" });
    ok(!late.fehler && late.wert.indexOf("Wert-499-") === 0 && late.gekuerzt === false, "P-P1 spätes Feld vollständig lesbar");
    const page1 = await tools.leseDatei.execute({ datei: "src/content/pages/big.json" });
    ok(page1.gekuerzt === true && typeof page1.weiterAb === "number" && page1.gesamtZeichen > 50000, "P-P1 leseDatei kennzeichnet Kürzung + Fortsetzung");
    const page2 = await tools.leseDatei.execute({ datei: "src/content/pages/big.json", abZeichen: page1.weiterAb });
    ok(!page2.fehler && page2.von === page1.weiterAb, "P-P1 Nachladen ab Fortsetzung");
  }

  // P-P2: schreibeInhalt lehnt ab / speichert / meldet ehrlich
  {
    const heroFields = [{ id: "hero.title", label: "Titel", type: "text", file: "src/content/pages/home.json", path: "hero.title", maxLength: 90 }];
    const faqFiles = {
      "src/content/site.json": JSON.stringify({ titel: "Firma" }),
      "src/content/pages/faq.json": JSON.stringify({ items: [{ frage: "Q1", antwort: "A1" }, { frage: "Q2", antwort: "A2" }] }),
      "src/content/pages/home.json": JSON.stringify({ hero: { title: "Alt" } }),
    };
    const h1 = toolHarness({ files: faqFiles, drafts: [], serverFields: heroFields });
    const bad = await h1.tools.schreibeInhalt.execute({ datei: "src/content/site.json", pfad: "hero.neu", wert: "x" });
    ok(bad.fehler && h1.stored.length === 0, "P-P2 hero.neu abgelehnt, nichts gespeichert");
    const good = await h1.tools.schreibeInhalt.execute({ feldId: "hero.title", wert: "Neu" });
    ok(!good.fehler && good.art === "feld" && h1.stored.length === 1, "P-P2 gültiges Feld gespeichert");
    const h2 = toolHarness({ files: faqFiles, drafts: [], serverFields: heroFields });
    const inc = await h2.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].frage", wert: "Neu?" });
    ok(!inc.fehler && typeof inc.hinweis === "string" && /antwort/.test(inc.hinweis), "P-P2 unvollständige Ergänzung ehrlich markiert");
  }
}

main()
  .catch((e) => {
    console.error("Testlauf abgestürzt:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tsconfigPath, { force: true });
  })
  .then(() => {
    if (process.exitCode) {
      console.log(`\nFEHLER: ${passed} bestanden, ${failed} fehlgeschlagen.`);
    } else {
      console.log(`\n${passed} 1c-Tests bestanden, ${failed} fehlgeschlagen.`);
    }
  });
