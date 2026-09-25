/**
 * Nachprüfung 1b: echte Publish-Route mit kontrollierten Testadaptern.
 *
 * Teil A prüft die eingeengten Erstellungsregeln (Banner, Listen-Ergänzung,
 * Ablehnung beliebiger neuer Schlüssel) direkt an den Schutzfunktionen.
 * Teil B ruft den TATSÄCHLICHEN Publish-Handler (kompilierte Route) mit
 * gefakten GitHub-/Supabase-Adaptern auf – kein Netz, keine Produktion.
 *
 * Belege: Gemischte Sätze (gültig + unerlaubt) lösen keinen einzigen
 * Repository-Schreibvorgang aus und löschen keine Entwürfe. Gültige
 * Inhaltsänderungen (Manifestfeld, freier Entwurf, Banner-Erstellung,
 * volle Datei) funktionieren weiterhin. Manifestfelder, freie Entwürfe und
 * volle Datei-Entwürfe können die Inhaltsprüfung nicht umgehen.
 *
 * Start: npm run test:reparatur1b
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
const tmp = path.join(root, ".tmp-rep1b");
const tsconfigPath = path.join(root, ".tmp-rep1b-tsconfig.json");

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

  // ---------- Teil A: Erstellungsregeln ----------
  {
    const fresh = {};
    const site = { titel: "Firma" };
    const withBanner = { banner: { enabled: false, variant: "vacation", text: "alt" } };
    const list = { items: [{ t: "a" }, { t: "b" }] };

    const r1 = guard.classifyFreeTarget("src/content/site.json", "banner.enabled", fresh, "true");
    ok(r1.ok && r1.creation && r1.creation.kind === "banner", "Banner-Erstellung auf frischer site.json");
    const r2 = guard.classifyFreeTarget("src/content/site.json", "banner.variant", fresh, "party");
    ok(!r2.ok, "falscher Banner-Stil abgelehnt");
    const r3 = guard.classifyFreeTarget("src/content/site.json", "banner.text", fresh, "x".repeat(200));
    ok(!r3.ok, "zu langer Banner-Text abgelehnt");
    const r4 = guard.classifyFreeTarget("src/content/site.json", "banner.unbekannt", fresh, "x");
    ok(!r4.ok, "unbekanntes Banner-Feld abgelehnt");
    const r5 = guard.classifyFreeTarget("src/content/site.json", "banner.enabled", withBanner, "true");
    ok(r5.ok && r5.creation === null, "bestehender Banner-Pfad = normales Schreiben");
    const r6 = guard.classifyFreeTarget("src/content/pages/l.json", "items[2].frage", list, "Neu?");
    ok(r6.ok && r6.creation && r6.creation.kind === "append", "Listen-Ergänzung am Ende (FAQ)");
    const r7 = guard.classifyFreeTarget("src/content/pages/l.json", "items[9].frage", list, "x");
    ok(!r7.ok, "Listen-Index mit Loch abgelehnt");
    const r8 = guard.classifyFreeTarget("src/content/pages/l.json", "items[2].a.b", list, "x");
    ok(!r8.ok, "tiefe Struktur unter neuem Element abgelehnt");
    const r9 = guard.classifyFreeTarget("src/content/site.json", "hero.neu", site, "x");
    ok(!r9.ok, "beliebiger neuer Schlüssel abgelehnt");
    const r10 = guard.classifyFreeTarget("src/content/site.json", "neu.tief.schluessel", site, "x");
    ok(!r10.ok, "beliebige neue Struktur abgelehnt");

    // Freigegebene Erstellung deckt Manifestfeld-Pfad im selben Satz ab
    const pending = new Set(["src/content/site.json#banner.enabled"]);
    const errs = guard.validateFieldTargets(
      [{ id: "b", label: "Banner", type: "boolean", file: "src/content/site.json", path: "banner.enabled" }],
      new Map([["src/content/site.json", {}]]),
      pending
    );
    ok(errs.length === 0, "Manifestfeld durch freigegebene Erstellung abgedeckt");
    const errs2 = guard.validateFieldTargets(
      [{ id: "b", label: "Banner", type: "boolean", file: "src/content/site.json", path: "banner.enabled" }],
      new Map([["src/content/site.json", {}]])
    );
    ok(errs2.length > 0, "ohne Erstellung bleibt fehlender Pfad ein Fehler");
  }

  // ---------- Teil B: echter Publish-Handler ----------
  const routeJs = walk(tmp, "route.js").find((p) => p.includes("publish"));
  if (!routeJs) throw new Error("kompilierte Publish-Route nicht gefunden");
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
  process.env.REP1B_REAL_GITHUB = realGithub;
  fs.writeFileSync(
    path.join(stubDir, "github.js"),
    `const real = require(process.env.REP1B_REAL_GITHUB);
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

  const BASE_MANIFEST = {
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
  const BASE_FILES = {
    "src/content/pages/home.json": JSON.stringify({ hero: { title: "Alt" } }),
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

  // S1: gültig + unerlaubt -> 200 teilveröffentlicht (Rest bleibt Entwurf)
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["hero.title", "Neu"], ["json:package.json:scripts", "x"]],
      codeDrafts: [],
    });
    ok(r.status === 200, "S1 gemischt -> 200 teilveröffentlicht");
    ok(r.commits.length === 1, "S1 nur die gültige Datei geschrieben");
    ok(r.draftsLeft === 1, "S1 unerlaubter Entwurf bleibt erhalten");
    ok(JSON.parse(r.repo.get("src/content/pages/home.json")).hero.title === "Neu", "S1 gültige Änderung live");
    ok(JSON.stringify(r.body.blocked || []).includes("package.json"), "S1 Blockade wird genannt");
  }

  // S2: nur gültig -> 200, Write, Entwürfe weg
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["hero.title", "Neu"], ["preis.betrag", "19,90"]],
      codeDrafts: [],
    });
    ok(r.status === 200, "S2 gültig -> 200");
    ok(r.commits.length === 2, "S2 beide Dateien geschrieben");
    ok(JSON.parse(r.repo.get("src/content/pages/home.json")).hero.title === "Neu", "S2 Text übernommen");
    ok(JSON.parse(r.repo.get("src/content/pages/preise.json")).preis.betrag === 19.9, "S2 Zahl als Zahl");
    ok(r.draftsLeft === 0, "S2 Entwürfe gelöscht");
  }

  // S3: Banner-Erstellung auf frischer site.json (ohne Manifest-Bannerfelder)
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [
        ["json:src/content/site.json:banner.enabled", "true"],
        ["json:src/content/site.json:banner.variant", "vacation"],
        ["json:src/content/site.json:banner.text", "Urlaub"],
      ],
      codeDrafts: [],
    });
    const site = JSON.parse(r.repo.get("src/content/site.json"));
    ok(r.status === 200, "S3 Banner-Erstellung -> 200");
    ok(site.banner && site.banner.enabled === true, "S3 Banner als Boolean angelegt");
    ok(site.banner.variant === "vacation" && site.banner.text === "Urlaub", "S3 Banner-Inhalte passen");
    ok(site.titel === "Firma", "S3 Rest der Datei unversehrt");
    ok(r.draftsLeft === 0, "S3 Entwürfe gelöscht");
  }

  // S4: neuer Schlüssel in einer Datei -> diese Datei zurückhalten, Rest live
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["preis.betrag", "15"], ["json:src/content/site.json:hero.neu", "x"]],
      codeDrafts: [],
    });
    ok(r.status === 200, "S4 neuer Schlüssel -> 200 teilveröffentlicht");
    ok(r.commits.length === 1, "S4 nur die gültige Datei geschrieben");
    ok(r.draftsLeft === 1, "S4 fehlerhafter Entwurf bleibt erhalten");
    ok(JSON.parse(r.repo.get("src/content/pages/preise.json")).preis.betrag === 15, "S4 gültige Änderung live");
  }

  // S5: volle Datei außerhalb der Sperre + __proto__-Datei -> 400
  {
    const files = Object.assign({}, BASE_FILES, { "src/content/extra.json": JSON.stringify({ a: 1 }) });
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files,
      drafts: [],
      codeDrafts: [["src/content/extra.json", JSON.stringify({ a: 2 })]],
    });
    ok(r.status === 400 && /erlaubtes Inhaltsziel/.test(r.body.error || ""), "S5 volle Datei außerhalb Sperre -> 400");
    ok(r.commits.length === 0, "S5 kein Repository-Schreibvorgang");
    // __proto__ als reiner Text gebaut: Als Objekt-Literal würde JS den
    // Schlüssel still als Prototyp deuten und der Test wäre wertlos.
    const protoContent = '{"__proto__":{"x":1},"hero":{"title":"A"}}';
    const r2 = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [],
      codeDrafts: [["src/content/pages/home.json", protoContent]],
    });
    ok(r2.status === 400 && r2.commits.length === 0, "S5b __proto__-Datei -> 400 ohne Write");
  }

  // S6: manipuliertes Manifest (Feld auf package.json) -> 400
  {
    const evil = {
      sections: [
        {
          id: "x",
          title: "X",
          fields: [{ id: "evil", label: "Böse", type: "text", file: "package.json", path: "scripts" }],
        },
      ],
    };
    const r = await runScenario({
      manifest: evil,
      files: BASE_FILES,
      drafts: [["evil", "x"]],
      codeDrafts: [],
    });
    ok(r.status === 400 && /package\.json/.test(r.body.error || ""), "S6 Manifest auf package.json -> 400");
    ok(r.commits.length === 0, "S6 kein Repository-Schreibvorgang");
    ok(r.draftsLeft === 1, "S6 Entwurf bleibt erhalten");
  }

  // S7: Manifest-Bannerfeld durch Erstellung im selben Satz abgedeckt
  {
    const withBannerField = {
      sections: [
        {
          id: "firma",
          title: "Firma",
          fields: [{ id: "site.banner.enabled", label: "Banner an", type: "boolean", file: "src/content/site.json", path: "banner.enabled" }],
        },
      ],
    };
    const r = await runScenario({
      manifest: withBannerField,
      files: { "src/content/site.json": JSON.stringify({ titel: "Firma" }) },
      drafts: [
        ["json:src/content/site.json:banner.enabled", "true"],
        ["json:src/content/site.json:banner.variant", "info"],
        ["json:src/content/site.json:banner.text", "Info"],
      ],
      codeDrafts: [],
    });
    const site = JSON.parse(r.repo.get("src/content/site.json"));
    ok(r.status === 200, "S7 Manifestfeld + Erstellung -> 200");
    ok(site.banner && site.banner.enabled === true, "S7 Banner passt zum Manifest-Modell");
  }

  // S8: Manifest-Entwurf + freier Entwurf, verschiedene Werte -> 400 Konflikt
  {
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files: BASE_FILES,
      drafts: [["hero.title", "A"], ["json:src/content/pages/home.json:hero.title", "B"]],
      codeDrafts: [],
    });
    ok(r.status === 400 && r.commits.length === 0, "S8 Zielkonflikt -> 400 ohne Write");
    ok(r.draftsLeft === 2, "S8 Entwürfe bleiben erhalten");
  }

  // S9: freie Duplikate in anderer Schreibweise -> 400
  {
    const files = Object.assign({}, BASE_FILES, {
      "src/content/pages/liste.json": JSON.stringify({ items: [{ t: "a" }] }),
    });
    const r = await runScenario({
      manifest: BASE_MANIFEST,
      files,
      drafts: [
        ["json:src/content/pages/liste.json:items[0].t", "X"],
        ["json:src/content/pages/liste.json:items.0.t", "Y"],
      ],
      codeDrafts: [],
    });
    ok(r.status === 400 && r.commits.length === 0, "S9 Schreibweisen-Duplikat -> 400 ohne Write");
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
      console.log(`\n${passed} Nachprüfungs-Tests bestanden, ${failed} fehlgeschlagen.`);
    }
  });
