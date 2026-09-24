/**
 * Prüfung für POST /api/ai/undo (Rückgängig-Button im KI-Chat).
 *
 * Nutzt die echte Route mit gefakter Supabase-Schicht (kein Netz, keine
 * Produktion). Belegt: Auth/Zugriff, Löschen genau der vermerkten Entwürfe,
 * Löschen der Nachricht, Zähler für bereits Veröffentlichtes und den
 * Gesprächs-Fallback für frische Nachrichten.
 *
 * Start: npm run test:chat-undo
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
const tmp = path.join(root, ".tmp-undo");
const tsconfigPath = path.join(root, ".tmp-undo-tsconfig.json");

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
      include: ["src/app/api/ai/undo/route.ts"],
    })
  );
  execSync(`npx tsc -p ${tsconfigPath}`, { cwd: root, stdio: "inherit" });

  const routeJs = walk(tmp, "route.js").find((p) => p.includes("undo"));
  if (!routeJs) throw new Error("kompilierte Undo-Route nicht gefunden");

  const stubDir = path.join(tmp, "stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "next-server.js"),
    `module.exports = { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body, json: async () => body }) } };\n`
  );
  fs.writeFileSync(
    path.join(stubDir, "supabase-server.js"),
    `function rows(db, t) { return db.tables[t] || []; }
class Q {
  constructor(db, t) { this.db = db; this.t = t; this.filters = []; this.op = "select"; this.sortKey = null; this.sortAsc = true; this.limitN = null; }
  select() { return this; }
  eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
  in(k, a) { this.filters.push((r) => a.includes(r[k])); return this; }
  order(k, o) { this.sortKey = k; this.sortAsc = !o || o.ascending !== false; return this; }
  limit(n) { this.limitN = n; return this; }
  match(r) { return this.filters.every((f) => f(r)); }
  run() {
    let out = rows(this.db, this.t).filter((r) => this.match(r));
    if (this.sortKey) out = [...out].sort((a, b) => (a[this.sortKey] < b[this.sortKey] ? -1 : 1) * (this.sortAsc ? 1 : -1));
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return out;
  }
  async maybeSingle() { const h = this.run()[0]; return { data: h || null }; }
  async single() { const h = this.run()[0]; return h ? { data: h, error: null } : { data: null, error: { message: "nichts gefunden" } }; }
  delete() { this.op = "delete"; return this; }
  then(res, rej) {
    try {
      if (this.op === "delete") {
        const arr = rows(this.db, this.t);
        this.db.tables[this.t] = arr.filter((r) => !this.match(r));
        res({ error: null });
      } else {
        res({ data: this.run(), error: null });
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

  const STUB_NEXT = path.join(stubDir, "next-server.js");
  const STUB_SUPA = path.join(stubDir, "supabase-server.js");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "next/server") return require(STUB_NEXT);
    if (request === "@/lib/supabase/server") return require(STUB_SUPA);
    return origLoad.call(this, request, parent, isMain);
  };

  const route = require(routeJs);

  function seed({ userId = "u1", withAccess = true, messages = [], drafts = [], codeDrafts = [] }) {
    globalThis.__FAKE_DB__ = {
      user: userId ? { id: userId } : null,
      tables: {
        user_sites: withAccess ? [{ user_id: "u1", site_id: "site-1" }] : [],
        ai_conversations: [{ id: "conv-1", site_id: "site-1" }],
        ai_messages: messages,
        drafts: drafts.map((d, i) => ({ id: `d-${i}`, site_id: "site-1", field_id: d, value: "x" })),
        code_drafts: codeDrafts.map((c, i) => ({ id: `c-${i}`, site_id: "site-1", file_path: c, content: "x" })),
      },
    };
  }

  async function post(body) {
    const req = new Request("http://test/api/ai/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await route.POST(req);
    return { status: res.status, body: res.body, db: globalThis.__FAKE_DB__.tables };
  }

  const assistantMsg = (id, entwuerfe, code = [], conv = "conv-1") => ({
    id,
    conversation_id: conv,
    role: "assistant",
    content: { text: "Gemacht.", entwuerfe, codeEntwuerfe: code },
  });

  // U1: ohne Login -> 401
  seed({ userId: null, messages: [] });
  {
    const r = await post({ messageId: "m1" });
    ok(r.status === 401, "U1 ohne Login -> 401");
  }

  // U2: ohne Zugriff -> 403
  seed({ withAccess: false, messages: [assistantMsg("m1", ["f1"])] });
  {
    const r = await post({ messageId: "m1" });
    ok(r.status === 403, "U2 ohne Zugriff -> 403");
  }

  // U3: unbekannte Nachricht -> 404, Fremd-Rolle -> 404
  seed({ messages: [{ id: "mu", conversation_id: "conv-1", role: "user", content: { text: "Hi" } }] });
  {
    const r = await post({ messageId: "nix" });
    ok(r.status === 404, "U3 unbekannte Nachricht -> 404");
    const r2 = await post({ messageId: "mu" });
    ok(r2.status === 404, "U3 Nutzer-Nachricht nicht rückgängig -> 404");
  }

  // U4: Erfolg – genau die vermerkten Entwürfe + Nachricht weg, Rest bleibt
  seed({
    messages: [assistantMsg("m1", ["f1", "f2"], ["src/components/X.astro"])],
    drafts: ["f1", "f2", "fremd"],
    codeDrafts: ["src/components/X.astro", "src/components/Anderes.astro"],
  });
  {
    const r = await post({ messageId: "m1" });
    const restDrafts = r.db.drafts.map((d) => d.field_id);
    const restCode = r.db.code_drafts.map((d) => d.file_path);
    ok(r.status === 200, "U4 Erfolg -> 200");
    ok(r.body.geloeschteEntwuerfe === 3 && r.body.bereitsLive === 0, "U4 Zähler stimmen");
    ok(
      restDrafts.length === 1 && restDrafts[0] === "fremd" && restCode.length === 1,
      "U4 nur vermerkte Entwürfe gelöscht, Fremde bleiben"
    );
    ok(r.db.ai_messages.length === 0, "U4 Nachricht gelöscht");
  }

  // U5: bereits veröffentlicht – Nachricht weg, Zähler ehrlich
  seed({ messages: [assistantMsg("m1", ["f1"], ["src/components/X.astro"])], drafts: [], codeDrafts: [] });
  {
    const r = await post({ messageId: "m1" });
    ok(r.status === 200 && r.body.geloeschteEntwuerfe === 0 && r.body.bereitsLive === 2, "U5 veröffentlichte Änderungen ehrlich gezählt");
    ok(r.db.ai_messages.length === 0, "U5 Nachricht trotzdem gelöscht");
  }

  // U6: Gesprächs-Fallback – neueste Antwort mit Entwürfen
  seed({
    messages: [
      assistantMsg("m-alt", []),
      assistantMsg("m-neu", ["f9"]),
    ],
    drafts: ["f9"],
  });
  {
    const r = await post({ conversationId: "conv-1" });
    ok(r.status === 200 && r.body.geloeschteEntwuerfe === 1, "U6 Fallback trifft neueste Antwort mit Entwürfen");
    ok(r.db.ai_messages.length === 1 && r.db.ai_messages[0].id === "m-alt", "U6 nur diese Nachricht gelöscht");
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
      console.log(`\n${passed} Undo-Tests bestanden, ${failed} fehlgeschlagen.`);
    }
  });
