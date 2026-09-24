/**
 * Nachprüfung 1d: Abschlussreparatur der Inhaltsvalidierung.
 *
 * Belegt die drei 1d-Fehlerbereiche gegen echte Routen-/Werkzeugfunktionen
 * (lokale Adapter, kein Netz, keine Produktion):
 *  A) Modellannahmen: feste Listen wachsen nicht (auch vollständig nicht),
 *     nur ausdrücklich modellierte dynamische Listen (FAQ) dürfen wachsen.
 *  B) Vollständige Dateien ohne Sonderweg: strikte Endtypen im Kandidaten
 *     (Zahl = echte Zahl, Boolean = echter Boolean, Text = Text, null
 *     abgelehnt), Banner immer gültig – auch ausgeschaltet.
 *  C) Chat-Ablauf mit derselben gemeinsamen Logik: Banner per Feld-ID,
 *     FAQ-Fortsetzung (Antwort nach Frage), Banner-Hinweis trotz "true"-String.
 *
 * Start: npm run test:reparatur1d
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
const tmp = path.join(root, ".tmp-rep1d");
const tsconfigPath = path.join(root, ".tmp-rep1d-tsconfig.json");

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

// Demo-nahe Inhalte: Startseite mit fester 3er-Bewertungssektion.
function demoHome() {
  return {
    hero: { title: "Willkommen" },
    testimonials: {
      title: "Das sagen unsere Kunden",
      subtitle: "Über 800 Bewertungen.",
      items: [
        { quote: "Top.", author: "A", rating: 5, location: "Hannover" },
        { quote: "Super.", author: "B", rating: 5, location: "Laatzen" },
        { quote: "Gerne wieder.", author: "C", rating: 4, location: "Langenhagen" },
      ],
    },
  };
}

const DEMO_MANIFEST = {
  sections: [
    {
      id: "haupt",
      title: "Haupt",
      fields: [
        { id: "hero.title", label: "Titel", type: "text", file: "src/content/pages/home.json", path: "hero.title", maxLength: 90 },
        { id: "t.quote.0", label: "Bewertung 1", type: "text", file: "src/content/pages/home.json", path: "testimonials.items[0].quote" },
        { id: "t.rating.0", label: "Sterne 1", type: "number", file: "src/content/pages/home.json", path: "testimonials.items[0].rating" },
        { id: "preis.betrag", label: "Preis", type: "number", file: "src/content/pages/preise.json", path: "preis.betrag" },
      ],
    },
  ],
};

const DEMO_FILES = () => ({
  "src/content/pages/home.json": JSON.stringify(demoHome()),
  "src/content/pages/preise.json": JSON.stringify({ preis: { betrag: 10 } }),
  "src/content/site.json": JSON.stringify({ titel: "Firma" }),
});

const FAQ_EXTRA = {
  "src/content/pages/home.json": JSON.stringify({ hero: { title: "Alt" } }),
  "src/content/pages/preise.json": JSON.stringify({ preis: { betrag: 10 } }),
};

const FAQ_FILES = () => Object.assign(
  {
    "src/content/site.json": JSON.stringify({ titel: "Firma" }),
    "src/content/pages/faq.json": JSON.stringify({ items: [{ frage: "Q1", antwort: "A1" }, { frage: "Q2", antwort: "A2" }] }),
  },
  FAQ_EXTRA
);

// Passendes Manifest für die FAQ-Szenarien (ohne Testimonials-Felder).
const FAQ_MANIFEST = {
  sections: [
    {
      id: "haupt",
      title: "Haupt",
      fields: [
        { id: "hero.title", label: "Titel", type: "text", file: "src/content/pages/home.json", path: "hero.title", maxLength: 90 },
        { id: "preis.betrag", label: "Preis", type: "number", file: "src/content/pages/preise.json", path: "preis.betrag" },
      ],
    },
  ],
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

  // ---------- Teil U: gemeinsame Bausteine ----------
  {
    ok(typeof guard.findListModel === "function", "U-D1 gemeinsame Listmodell-Suche existiert");
    ok(typeof guard.validateListStructures === "function", "U-D2 gemeinsame Listen-Strukturprüfung existiert");
    ok(typeof guard.getBannerProblems === "function", "U-D3 gemeinsame Banner-Prüfung existiert");
    ok(typeof guard.missingAppendKeys === "function", "U-D4 gemeinsame Ergänzungs-Hinweise existieren");
    ok(typeof validate.validateFinalJsonValue === "function", "U-D5 strikte Endtyp-Prüfung existiert");
    if (typeof validate.validateFinalJsonValue === "function") {
      ok(validate.validateFinalJsonValue("number", 42) === null, "U-D6 echte Zahl ok");
      ok(validate.validateFinalJsonValue("number", "42") !== null, "U-D7 Zahl als Text abgelehnt");
      ok(validate.validateFinalJsonValue("boolean", true) === null, "U-D8 echter Boolean ok");
      ok(validate.validateFinalJsonValue("boolean", "true") !== null, "U-D9 Boolean als Text abgelehnt");
      ok(validate.validateFinalJsonValue("text", "Hallo") === null, "U-D10 Text ok");
      ok(validate.validateFinalJsonValue("text", null) !== null, "U-D11 null als Text abgelehnt");
      ok(validate.validateFinalJsonValue("number", null) !== null, "U-D12 null als Zahl abgelehnt");
    }
    if (typeof guard.findListModel === "function") {
      ok(guard.findListModel("src/content/pages/faq.json", "items") !== null, "U-D13 FAQ-Modell vorhanden");
      ok(guard.findListModel("src/content/pages/home.json", "testimonials.items") === null, "U-D14 festes Bewertungsmodell: kein Wachstumsmodell");
    }
    if (typeof guard.getBannerProblems === "function") {
      ok(guard.getBannerProblems({ enabled: true, variant: "vacation", text: "ok" }).length === 0, "U-D15 gültiger Banner ok");
      ok(guard.getBannerProblems({ enabled: false, variant: "party", text: "x".repeat(161) }).length >= 2, "U-D16 ausgeschalteter Banner mit party/Überlänge bemängelt");
      ok(guard.getBannerProblems({ enabled: false, variant: "info", text: "ok" }).length === 0, "U-D17 ausgeschalteter gültiger Banner ok");
    }
  }

  // ---------- Adapter-Harness (wie 1c) ----------
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
  process.env.REP1D_REAL_GITHUB = realGithub;
  fs.writeFileSync(
    path.join(stubDir, "github.js"),
    `const real = require(process.env.REP1D_REAL_GITHUB);
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

  async function runScenario({ manifest, files, drafts, codeDrafts }) {
    globalThis.__FAKE_REPO__ = new Map(
      Object.entries(Object.assign({}, files, { "src/content/cms.manifest.json": JSON.stringify(manifest) }))
    );
    globalThis.__FAKE_COMMITS__ = [];
    const liveHome = files["src/content/pages/home.json"];
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
      liveHome,
    };
  }

  // ---------- Teil B: vollständige Dateien ohne Sonderweg ----------
  {
    // D-F1: volle home.json mit 4. Bewertung (nur quote) + gültiger Titel-Entwurf
    const home = demoHome();
    home.testimonials.items.push({ quote: "Nur Zitat." });
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [["hero.title", "Neu"]],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(home)]],
    });
    ok(r.status === 400 && r.commits.length === 0, "D-F1 volle Datei mit quote-only-Bewertung -> 400 ohne Write");
    ok(r.draftsLeft === 1 && r.codeLeft === 1, "D-F1 alle Entwürfe bleiben (keine Teilspeicherung)");
    ok(JSON.parse(r.repo.get("src/content/pages/home.json")).hero.title === "Willkommen", "D-F1 Live-Datei unverändert");
  }
  {
    // D-F2: volle home.json mit hero.title = null
    const home = demoHome();
    home.hero.title = null;
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [["preis.betrag", "12"]],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(home)]],
    });
    ok(r.status === 400 && r.commits.length === 0, "D-F2 volle Datei mit hero.title=null -> 400 ohne Write");
    ok(r.draftsLeft === 1 && r.codeLeft === 1, "D-F2 alle Entwürfe bleiben");
  }
  {
    // D-F3: deklariertes Zahlfeld als String "42" per voller Datei
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/preise.json", JSON.stringify({ preis: { betrag: "42" } })]],
    });
    ok(r.status === 400 && r.commits.length === 0, "D-F3 Zahlfeld als String per voller Datei -> 400 ohne Write");
    ok(r.codeLeft === 1, "D-F3 Entwurf bleibt");
    const good = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/preise.json", JSON.stringify({ preis: { betrag: 42 } })]],
    });
    const stored = JSON.parse(good.repo.get("src/content/pages/preise.json")).preis.betrag;
    ok(good.status === 200 && stored === 42, "D-F3b echte Zahl per voller Datei -> 200 als Zahl");
    // D-F3c: vorhandener deklarierter Wert als Text per voller Datei -> 400
    const homeStr = demoHome();
    homeStr.testimonials.items[0].rating = "5";
    const rStr = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(homeStr)]],
    });
    ok(rStr.status === 400 && rStr.commits.length === 0, "D-F3c vorhandene Sterne als Text per voller Datei -> 400 ohne Write");
  }
  {
    // D-F4: ausgeschalteter Banner mit party + 161 Zeichen per voller Datei
    const badSite = { titel: "Firma", banner: { enabled: false, variant: "party", text: "x".repeat(161) } };
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/site.json", JSON.stringify(badSite)]],
    });
    ok(r.status === 400 && r.commits.length === 0, "D-F4 ausgeschalteter Banner mit party/Überlänge -> 400 ohne Write");
    const goodSite = { titel: "Firma", banner: { enabled: false, variant: "info", text: "Betriebsferien" } };
    const good = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/site.json", JSON.stringify(goodSite)]],
    });
    const banner = JSON.parse(good.repo.get("src/content/site.json")).banner;
    ok(good.status === 200 && banner.enabled === false && banner.variant === "info", "D-F4b gültiger ausgeschalteter Banner -> 200");
  }
  {
    // D-F5: volle Datei + Feldentwurf gemeinsam (gültig) -> 200, beide wirksam
    const home = demoHome();
    home.hero.title = "Aus Datei";
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [["hero.title", "Aus Entwurf"]],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(home)]],
    });
    const title = JSON.parse(r.repo.get("src/content/pages/home.json")).hero.title;
    ok(r.status === 200 && title === "Aus Entwurf", "D-F5 volle Datei + Feldentwurf gemeinsam -> 200");
    ok(r.draftsLeft === 0 && r.codeLeft === 0, "D-F5 Entwürfe aufgeräumt");
  }

  // ---------- Teil A: feste vs. dynamische Listen ----------
  {
    // D-L1: vollständige 4. Bewertung per Entwurf -> trotzdem 400 (feste Liste)
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [
        ["json:src/content/pages/home.json:testimonials.items[3].quote", "Toll!"],
        ["json:src/content/pages/home.json:testimonials.items[3].author", "A. Tester"],
        ["json:src/content/pages/home.json:testimonials.items[3].location", "Hannover"],
        ["json:src/content/pages/home.json:testimonials.items[3].rating", "5"],
      ],
      codeDrafts: [],
    });
    ok(r.status === 400 && /fest/.test(r.body.error || ""), "D-L1 vollständige 4. Bewertung -> 400 feste Liste");
    ok(r.commits.length === 0 && r.draftsLeft === 4, "D-L1 kein Write, Entwürfe bleiben");
  }
  {
    // D-L2: unvollständige FAQ-Ergänzung per Publish -> 400 nennt antwort
    const r = await runScenario({
      manifest: FAQ_MANIFEST,
      files: FAQ_FILES(),
      drafts: [["json:src/content/pages/faq.json:items[2].frage", "Neu?"]],
      codeDrafts: [],
    });
    ok(r.status === 400 && /antwort/.test(r.body.error || ""), "D-L2 unvollständige FAQ-Ergänzung -> 400 nennt antwort");
    ok(r.commits.length === 0, "D-L2 kein Write");
    // D-L3: vollständige FAQ-Ergänzung bei vorhandenem Modell -> 200
    const full = await runScenario({
      manifest: FAQ_MANIFEST,
      files: FAQ_FILES(),
      drafts: [
        ["json:src/content/pages/faq.json:items[2].frage", "Neu?"],
        ["json:src/content/pages/faq.json:items[2].antwort", "Neue Antwort."],
      ],
      codeDrafts: [],
    });
    const items = JSON.parse(full.repo.get("src/content/pages/faq.json")).items;
    ok(full.status === 200, "D-L3 vollständige FAQ-Ergänzung -> 200");
    ok(items.length === 3 && items[2].frage === "Neu?" && items[2].antwort === "Neue Antwort.", "D-L3 neues Element vollständig");
    ok(full.draftsLeft === 0, "D-L3 Entwürfe aufgeräumt");
  }

  // ---------- Normale Bearbeitungen + Alias + spätes Feld ----------
  {
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [["hero.title", "Neu"], ["preis.betrag", "19,90"]],
      codeDrafts: [],
    });
    const home = JSON.parse(r.repo.get("src/content/pages/home.json"));
    const preise = JSON.parse(r.repo.get("src/content/pages/preise.json"));
    ok(r.status === 200 && home.hero.title === "Neu", "D-N1 normaler Text -> 200");
    ok(preise.preis.betrag === 19.9, "D-N2 Zahlumwandlung bleibt Zahl");
    const b = await runScenario({
      manifest: DEMO_MANIFEST,
      files: Object.assign(DEMO_FILES(), { "src/content/site.json": JSON.stringify({ titel: "F", banner: { enabled: false } }) }),
      drafts: [["json:src/content/site.json:banner.enabled", "true"]],
      codeDrafts: [],
    });
    ok(b.status === 400 && /Text/.test(b.body.error || ""), "D-N3 Banner einschalten ohne Stil/Text -> 400 Dreifaltigkeit");
  }
  {
    // D-N4: leeres Textfeld (Feld leeren) bleibt zulässig
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [["hero.title", ""]],
      codeDrafts: [],
    });
    const title = r.status === 200 ? JSON.parse(r.repo.get("src/content/pages/home.json")).hero.title : null;
    ok(r.status === 200 && title === "", "D-N4 leeres Textfeld -> 200 als Leertext");
    // D-N5: false/0 sind echte Werte (kein Falsy-Fehler)
    const z = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [["preis.betrag", "0"]],
      codeDrafts: [],
    });
    const betrag = z.status === 200 ? JSON.parse(z.repo.get("src/content/pages/preise.json")).preis.betrag : null;
    ok(z.status === 200 && betrag === 0, "D-N5 Zahl 0 -> 200 als Zahl 0");
    const off = await runScenario({
      manifest: DEMO_MANIFEST,
      files: Object.assign(DEMO_FILES(), { "src/content/site.json": JSON.stringify({ titel: "F", banner: { enabled: true, variant: "info", text: "Hallo" } }) }),
      drafts: [["json:src/content/site.json:banner.enabled", "false"]],
      codeDrafts: [],
    });
    const enabled = off.status === 200 ? JSON.parse(off.repo.get("src/content/site.json")).banner.enabled : null;
    ok(off.status === 200 && enabled === false, "D-N5b Banner-aus -> 200 als Boolean false");
  }
  {
    // D-X1: Kombination im selben Satz (gültige Voll-Datei + festes Wachstum) -> 400
    const home = demoHome();
    home.hero.title = "Aus Datei";
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [
        ["json:src/content/pages/home.json:testimonials.items[3].quote", "Toll!"],
        ["json:src/content/pages/home.json:testimonials.items[3].author", "A"],
        ["json:src/content/pages/home.json:testimonials.items[3].location", "H"],
        ["json:src/content/pages/home.json:testimonials.items[3].rating", "5"],
      ],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(home)]],
    });
    ok(r.status === 400 && /fest/.test(r.body.error || "") && r.commits.length === 0, "D-X1 Kombination Voll-Datei + festes Wachstum -> 400 ohne Write");
    ok(r.draftsLeft === 4 && r.codeLeft === 1, "D-X1 alle Entwürfe bleiben");
    // D-X2: volle Datei mit neuer Liste ohne Modell -> 400
    const neu = demoHome();
    neu.neuigkeiten = [{ t: "x" }];
    const r2 = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(neu)]],
    });
    ok(r2.status === 400 && /ohne Website-Modell/.test(r2.body.error || "") && r2.commits.length === 0, "D-X2 neue Liste ohne Modell -> 400 ohne Write");
    // D-X3: volle Datei kürzt feste Liste 3 -> 2 -> 400
    const kurz = demoHome();
    kurz.testimonials.items = kurz.testimonials.items.slice(0, 2);
    const r3 = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(kurz)]],
    });
    ok(r3.status === 400 && /gekürzt/.test(r3.body.error || "") && r3.commits.length === 0, "D-X3 gekürzte feste Liste -> 400 ohne Write");
  }
  {
    const r = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: [["hero.title", "Neu"], ["json:src/content/pages/home.json:hero.title", "Neu"]],
      codeDrafts: [],
    });
    ok(r.status === 200 && r.draftsLeft === 0, "D-A1 Alias-Aufräumen bei gleichem Wert");
  }
  {
    // D-BIG: 500 Felder, spätes Feld bearbeiten
    const N = 500;
    const big = {};
    const fields = [];
    for (let i = 0; i < N; i += 1) {
      big[`k${i}`] = { v: `Wert-${i}` };
      fields.push({ id: `f${i}`, label: `Feld ${i}`, type: "text", file: "src/content/pages/big.json", path: `k${i}.v` });
    }
    const r = await runScenario({
      manifest: { sections: [{ id: "big", title: "Big", fields }] },
      files: { "src/content/pages/big.json": JSON.stringify(big) },
      drafts: [["f499", "Spät geändert"]],
      codeDrafts: [],
    });
    const stored = JSON.parse(r.repo.get("src/content/pages/big.json")).k499.v;
    ok(r.status === 200 && stored === "Spät geändert", "D-BIG spätes Feld bei 500 Feldern bearbeitbar");
  }

  // ---------- Teil C: Chat-Ablauf mit gemeinsamer Logik ----------
  function chatHarness({ files, drafts, serverFields }) {
    const repo = new Map(Object.entries(files));
    const stored = drafts.map((d) => ({ field_id: d[0], value: d[1] }));
    const store = {
      async storeDraft(sid, fieldId, value) {
        const at = stored.findIndex((d) => d.field_id === fieldId);
        if (at >= 0) stored[at] = { field_id: fieldId, value };
        else stored.push({ field_id: fieldId, value });
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

  const BANNER_FIELDS = [
    { id: "banner.enabled", label: "Banner an", type: "boolean", file: "src/content/site.json", path: "banner.enabled" },
    { id: "banner.variant", label: "Banner-Stil", type: "text", file: "src/content/site.json", path: "banner.variant" },
    { id: "banner.text", label: "Banner-Text", type: "text", file: "src/content/site.json", path: "banner.text" },
  ];

  {
    // C-B1: Feld-ID banner.variant mit "party" -> im Chat abgelehnt wie im Publish
    const h = chatHarness({ files: DEMO_FILES(), drafts: [], serverFields: BANNER_FIELDS });
    const bad = await h.tools.schreibeInhalt.execute({ feldId: "banner.variant", wert: "party" });
    ok(bad.fehler && h.stored.length === 0, "C-B1 banner.variant=party per Feld-ID im Chat abgelehnt");
    const good = await h.tools.schreibeInhalt.execute({ feldId: "banner.variant", wert: "info" });
    ok(!good.fehler && h.stored.length === 1, "C-B1b gültiger Stil per Feld-ID gespeichert");
  }
  {
    // C-B3: freier Alias auf deklariertes Bannerfeld umgeht die Regel nicht
    const h = chatHarness({ files: DEMO_FILES(), drafts: [], serverFields: BANNER_FIELDS });
    const bad = await h.tools.schreibeInhalt.execute({ datei: "src/content/site.json", pfad: "banner.variant", wert: "party" });
    ok(bad.fehler && h.stored.length === 0, "C-B3 freier Alias banner.variant=party abgelehnt");
  }
  {
    // C-F1/F2: Frage speichern, Antwort als Fortsetzung (kein neuer-Pfad-Fehler),
    // Korrektur des begonnenen Entwurfs, danach veröffentlichbar + Publish ok.
    const h = chatHarness({ files: FAQ_FILES(), drafts: [], serverFields: [] });
    const q = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].frage", wert: "Neu?" });
    ok(!q.fehler && /antwort/i.test(q.hinweis || ""), "C-F1 Frage gespeichert mit ehrlichem Antwort-Hinweis");
    const fix = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].frage", wert: "Neu korrigiert?" });
    ok(!fix.fehler, "C-F1b Korrektur des begonnenen Entwurfs möglich");
    const a = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].antwort", wert: "Neue Antwort." });
    ok(!a.fehler && (a.hinweis === null || a.hinweis === undefined), "C-F2 Antwort als Fortsetzung gespeichert, Eintrag vollständig");
    const mirror = await runScenario({
      manifest: FAQ_MANIFEST,
      files: FAQ_FILES(),
      drafts: h.stored.map((d) => [d.field_id, d.value]),
      codeDrafts: [],
    });
    const items = mirror.status === 200 ? JSON.parse(mirror.repo.get("src/content/pages/faq.json")).items : [];
    ok(mirror.status === 200 && items.length === 3 && items[2].antwort === "Neue Antwort.", "C-F2b Chat-Entwürfe gemeinsam veröffentlichbar");
  }
  {
    // C-T1: feste Bewertungsliste schon beim ersten Schritt ehrlich abgelehnt
    const h = chatHarness({ files: DEMO_FILES(), drafts: [], serverFields: [] });
    const bad = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/home.json", pfad: "testimonials.items[3].quote", wert: "Toll!" });
    ok(bad.fehler && /fest/.test(bad.fehler || "") && h.stored.length === 0, "C-T1 feste Liste im Chat sofort abgelehnt, nichts gespeichert");
  }
  {
    // C-B2: Banner einschalten (String "true") meldet trotzdem fehlenden Stil/Text
    const h = chatHarness({ files: DEMO_FILES(), drafts: [], serverFields: BANNER_FIELDS });
    const on = await h.tools.schreibeInhalt.execute({ datei: "src/content/site.json", pfad: "banner.enabled", wert: "true" });
    ok(!on.fehler && /Stil/.test(on.hinweis || "") && /Text/.test(on.hinweis || ""), "C-B2 Banner-an nennt fehlenden Stil und Text");
    await h.tools.schreibeInhalt.execute({ datei: "src/content/site.json", pfad: "banner.variant", wert: "vacation" });
    const last = await h.tools.schreibeInhalt.execute({ datei: "src/content/site.json", pfad: "banner.text", wert: "Urlaub" });
    ok(!last.fehler && (last.hinweis === null || last.hinweis === undefined), "C-B2b Banner nach Stil+Text vollständig");
    const mirror = await runScenario({
      manifest: DEMO_MANIFEST,
      files: DEMO_FILES(),
      drafts: h.stored.map((d) => [d.field_id, d.value]),
      codeDrafts: [],
    });
    const banner = mirror.status === 200 ? JSON.parse(mirror.repo.get("src/content/site.json")).banner : null;
    ok(mirror.status === 200 && banner && banner.enabled === true, "C-B2c Chat-Banner gemeinsam veröffentlichbar (Boolean)");
  }

  // ---------- Teil E: Restlücken nach 29f6da5 ----------
  {
    // E-S1: volle faq.json verliert bei vorhandenem Eintrag das Pflichtfeld
    // antwort (Listenlänge bleibt 1) -> 400 ohne Write, Entwürfe bleiben.
    const faq1 = () => ({
      "src/content/site.json": JSON.stringify({ titel: "Firma" }),
      "src/content/pages/home.json": JSON.stringify({ hero: { title: "Alt" } }),
      "src/content/pages/preise.json": JSON.stringify({ preis: { betrag: 10 } }),
      "src/content/pages/faq.json": JSON.stringify({ items: [{ frage: "Q1", antwort: "A1" }] }),
    });
    const gekuerzt = { items: [{ frage: "Q1" }] };
    const r = await runScenario({
      manifest: FAQ_MANIFEST,
      files: faq1(),
      drafts: [],
      codeDrafts: [["src/content/pages/faq.json", JSON.stringify(gekuerzt)]],
    });
    ok(r.status === 400 && /antwort/.test(r.body.error || "") && r.commits.length === 0, "E-S1 volle FAQ ohne antwort -> 400 ohne Write");
    ok(r.codeLeft === 1, "E-S1 Entwurf bleibt");
    ok(r.repo.get("src/content/pages/faq.json") === faq1()["src/content/pages/faq.json"], "E-S1 Live-Datei unverändert");
  }
  {
    // E-S2: rating (nicht im Manifest) Zahl 5 -> String "5" per voller Datei.
    const home = demoHome();
    home.testimonials.items[0].rating = "5";
    const r = await runScenario({
      manifest: FAQ_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(home)]],
    });
    ok(r.status === 400 && /Typ/.test(r.body.error || "") && r.commits.length === 0, "E-S2 Typwechsel Zahl->Text außerhalb Feldliste -> 400 ohne Write");
    ok(r.codeLeft === 1, "E-S2 Entwurf bleibt");
    // E-S2b: Typwechsel außerhalb von Listen per voller Datei (titel undeclared).
    const rTitel = await runScenario({
      manifest: FAQ_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/site.json", JSON.stringify({ titel: 5 })]],
    });
    ok(rTitel.status === 400 && /Typ/.test(rTitel.body.error || "") && rTitel.commits.length === 0, "E-S2b Typwechsel Text->Zahl außerhalb Listen -> 400 ohne Write");
  }
  {
    // E-S3/E-S4: gültige normale Bearbeitungen per voller Datei bleiben möglich.
    const faqNeu = { items: [{ frage: "Q1", antwort: "A1" }, { frage: "Q2", antwort: "Aktualisiert" }] };
    const r = await runScenario({
      manifest: FAQ_MANIFEST,
      files: FAQ_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/faq.json", JSON.stringify(faqNeu)]],
    });
    const antwort = r.status === 200 ? JSON.parse(r.repo.get("src/content/pages/faq.json")).items[1].antwort : null;
    ok(r.status === 200 && antwort === "Aktualisiert", "E-S3 gleichartige Textänderung per voller Datei -> 200");
    const home = demoHome();
    home.testimonials.items[0].quote = "Aktualisiert.";
    const r2 = await runScenario({
      manifest: FAQ_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(home)]],
    });
    const quote = r2.status === 200 ? JSON.parse(r2.repo.get("src/content/pages/home.json")).testimonials.items[0].quote : null;
    ok(r2.status === 200 && quote === "Aktualisiert.", "E-S4 gleichartige Textänderung außerhalb Feldliste -> 200");
  }
  {
    // E-S5/E-S6: verwandte Strukturvarianten in fester Liste (fremder/fehlender Schlüssel).
    const extra = demoHome();
    extra.testimonials.items[0].spitzname = "X";
    const r = await runScenario({
      manifest: FAQ_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(extra)]],
    });
    ok(r.status === 400 && /Struktur/.test(r.body.error || "") && r.commits.length === 0, "E-S5 fremder Schlüssel in fester Liste -> 400 ohne Write");
    const fehlt = demoHome();
    delete fehlt.testimonials.items[0].author;
    const r2 = await runScenario({
      manifest: FAQ_MANIFEST,
      files: DEMO_FILES(),
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", JSON.stringify(fehlt)]],
    });
    ok(r2.status === 400 && /Struktur/.test(r2.body.error || "") && r2.commits.length === 0, "E-S6 fehlender Schlüssel in fester Liste -> 400 ohne Write");
  }
  {
    // E-C1: Frage speichern, dieselbe Frage korrigieren (ohne Antwort) ->
    // Status aus dem zusammengesetzten Entwurf: antwort fehlt, nicht veröffentlichbar.
    const h = chatHarness({ files: FAQ_FILES(), drafts: [], serverFields: [] });
    const q = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].frage", wert: "Neu?" });
    ok(!q.fehler && q.veroeffentlichbar === false && /antwort/i.test(q.hinweis || ""), "E-C1a Frage gespeichert: antwort fehlt, nicht veröffentlichbar");
    const fix = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].frage", wert: "Neu korrigiert?" });
    ok(!fix.fehler && fix.veroeffentlichbar === false && /antwort/i.test(fix.hinweis || ""), "E-C1b Korrektur ohne Antwort: weiterhin antwort fehlend, nicht veröffentlichbar");
    // E-C2: Korrektur im vollständigen Eintrag bleibt veröffentlichbar.
    await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].antwort", wert: "Neue Antwort." });
    const fix2 = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/faq.json", pfad: "items[2].frage", wert: "Neu final?" });
    ok(!fix2.fehler && fix2.veroeffentlichbar === true && (fix2.hinweis === null || fix2.hinweis === undefined), "E-C2 Korrektur im vollständigen Eintrag: veröffentlichbar");
  }
  {
    // E-C3: Banner-Korrektur auf bestehendem Pfad: nach Einschalten fehlt
    // weiterhin der Text (Status aus dem zusammengesetzten Entwurf).
    const h = chatHarness({
      files: Object.assign(DEMO_FILES(), { "src/content/site.json": JSON.stringify({ titel: "F", banner: { enabled: false, variant: "info" } }) }),
      drafts: [],
      serverFields: BANNER_FIELDS,
    });
    const mid = await h.tools.schreibeInhalt.execute({ datei: "src/content/site.json", pfad: "banner.enabled", wert: "true" });
    ok(!mid.fehler && mid.veroeffentlichbar === false && /Text/.test(mid.hinweis || ""), "E-C3 Banner nach Einschalten: Text fehlt weiterhin, nicht veröffentlichbar");
    const done = await h.tools.schreibeInhalt.execute({ datei: "src/content/site.json", pfad: "banner.text", wert: "Hallo" });
    ok(!done.fehler && done.veroeffentlichbar === true, "E-C3b Banner vollständig: veröffentlichbar");
  }
  {
    // E-C4: Typwechsel außerhalb der Feldliste wird im Status ehrlich markiert.
    const h = chatHarness({
      files: Object.assign(DEMO_FILES(), { "src/content/pages/preise.json": JSON.stringify({ preis: { betrag: 10 } }) }),
      drafts: [],
      serverFields: [],
    });
    const bad = await h.tools.schreibeInhalt.execute({ datei: "src/content/pages/preise.json", pfad: "preis.betrag", wert: "fünf" });
    ok(!bad.fehler && bad.veroeffentlichbar === false && /Typ/.test(bad.hinweis || ""), "E-C4 Typwechsel Zahl->Text: gespeichert, aber nicht veröffentlichbar");
    const mirror = await runScenario({
      manifest: FAQ_MANIFEST,
      files: DEMO_FILES(),
      drafts: h.stored.map((d) => [d.field_id, d.value]),
      codeDrafts: [],
    });
    ok(mirror.status === 400 && mirror.commits.length === 0, "E-C4b Publish lehnt Typwechsel ab (400 ohne Write)");
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
      console.log(`\n${passed} 1d-Tests bestanden, ${failed} fehlgeschlagen.`);
    }
  });
