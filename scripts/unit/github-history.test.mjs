/** Unit-Tests: Manifest-Hinweise, GitHub-Fehlertexte, Commit-Retry, History-Fallbacks. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = process.env.UNIT_LIB ?? path.join("..", "..", ".tmp-unit", "lib");
const github = require(path.join(lib, "github.js"));
const history = require(path.join(lib, "history.js"));

test("normalizeManifestWithWarnings: deutet und meldet", () => {
  const { manifest, hinweise } = github.normalizeManifestWithWarnings({
    sections: [
      {
        id: "hero",
        title: "Hero",
        fields: [
          { id: "a", label: "A", type: "emial", file: "src/content/pages/h.json", path: "a" },
          { id: "", label: "Ohne", type: "text", file: "src/content/pages/h.json", path: "x" },
        ],
      },
      { id: "leer", title: "Leer", fields: [{ id: "n", type: "text" }] },
    ],
  });
  // Verhalten unverändert: unbekannter Typ wird Text, leere Sektion fällt weg
  assert.equal(manifest.sections.length, 1);
  assert.equal(manifest.sections[0].fields[0].type, "text");
  // …aber nichts mehr still
  assert.ok(hinweise.some((h) => h.includes('"a"') && h.includes("Text")), JSON.stringify(hinweise));
  assert.ok(hinweise.some((h) => h.includes("weggelassen")), JSON.stringify(hinweise));
  assert.ok(hinweise.some((h) => h.includes("ausgeblendet")), JSON.stringify(hinweise));
});

test("normalizeManifest bleibt verhaltensgleich", () => {
  const m = github.normalizeManifest({ fields: [{ id: "a", type: "text", file: "src/content/pages/h.json", path: "a" }] });
  assert.equal(m.sections.length, 1);
  assert.equal(m.sections[0].id, "content");
});

test("githubFehlerGrund: bekannt konkret, Rest allgemein", () => {
  assert.match(github.githubFehlerGrund({ status: 404 }), /gelöscht oder verschoben/);
  assert.match(github.githubFehlerGrund({ status: 409 }), /erneut versuchen/);
  assert.match(github.githubFehlerGrund({ status: 429 }), /Minute/);
  const allgemein = github.githubFehlerGrund(new Error("rate limit exceeded for token abc123"));
  assert.match(allgemein, /Server-Protokoll/);
  assert.ok(!allgemein.includes("abc123"), "kein Rohtext an den Client");
  assert.equal(github.isShaConflictError(new Error("sha does not match")), true);
  assert.equal(github.isShaConflictError(new Error("ganz anderer Fehler")), false);
});

test("commitFileWithRetry: Erfolg, dann Retry bei Konflikt", async () => {
  let aufrufe = 0;
  const fake = {
    repos: {
      createOrUpdateFileContents: async () => {
        aufrufe += 1;
        if (aufrufe === 1) {
          const e = new Error("sha does not match");
          e.status = 409;
          throw e;
        }
        return { data: { commit: { sha: "neu" } } };
      },
    },
  };
  const ergebnis = await github.commitFileWithRetry(
    fake,
    "o",
    "r",
    "msg",
    { file: "f.json", text: "{}", sha: "alt" },
    async () => "frisch"
  );
  assert.equal(ergebnis.ok, true);
  assert.equal(aufrufe, 2);

  const kaputt = {
    repos: {
      createOrUpdateFileContents: async () => {
        throw new Error("boom geheim-token-xyz");
      },
    },
  };
  const fehler = await github.commitFileWithRetry(kaputt, "o", "r", "msg", { file: "f.json", text: "{}", sha: "" }, async () => "s");
  assert.equal(fehler.ok, false);
  assert.ok(!fehler.error.includes("xyz"), "kein Rohtext an den Client");
});

test("beschraenkeVerlauf: behält die neuesten 50, löscht den Rest", async () => {
  const historyMod = require(path.join(lib, "history.js"));
  assert.equal(historyMod.MAX_HISTORY_ENTRIES, 50);
  const zeilen = Array.from({ length: 60 }, (_, i) => ({
    id: `id-${i}`,
    created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
  }));
  let geloescht = null;
  const fake = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: zeilen, error: null }) }),
      delete: () => ({ eq: () => ({ in: async (k, ids) => { geloescht = ids; return { error: null }; } }) }),
    }),
  };
  await historyMod.beschraenkeVerlauf(fake, "site-1");
  assert.equal(geloescht.length, 10);
  // Weg sind genau die 10 ältesten (nach Datum), die 50 neuesten bleiben
  const nachDatum = [...zeilen].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const behalten = new Set(nachDatum.slice(0, 50).map((z) => z.id));
  assert.ok(geloescht.every((id) => !behalten.has(id)));
  assert.deepEqual([...geloescht].sort(), nachDatum.slice(50).map((z) => z.id).sort());
});

test("insertPublishHistory: Fallback-Kette für alte Tabellen", async () => {
  const aufrufe = [];
  const fakeAlt = {
    from: () => ({
      insert: async (row) => {
        aufrufe.push(Object.keys(row).sort());
        if ("files" in row) return { error: { message: 'column "files" does not exist' } };
        if ("note" in row) return { error: { message: 'column "note" does not exist' } };
        return { error: null };
      },
    }),
  };
  const res = await history.insertPublishHistory(
    fakeAlt,
    { site_id: "s", published_by: null, commit_sha: null, payload: {}, note: "Rollback" },
    ["a.json"]
  );
  assert.equal(res.error, null);
  assert.equal(aufrufe.length, 3);

  const fakeOk = { from: () => ({ insert: async () => ({ error: null }) }) };
  const res2 = await history.insertPublishHistory(
    fakeOk,
    { site_id: "s", published_by: null, commit_sha: null, payload: {} },
    ["a.json"]
  );
  assert.equal(res2.error, null);

  const fakeDefekt = { from: () => ({ insert: async () => ({ error: { message: "datenbank kaputt" } }) }) };
  const res3 = await history.insertPublishHistory(
    fakeDefekt,
    { site_id: "s", published_by: null, commit_sha: null, payload: {} },
    []
  );
  assert.match(res3.error ?? "", /kaputt/);
});
