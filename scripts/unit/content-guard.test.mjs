/** Unit-Tests: Inhaltsprüfung (Dateisperre, Banner, Payload, feste Listen). */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = process.env.UNIT_LIB ?? path.join("..", "..", ".tmp-unit", "lib");
const guard = require(path.join(lib, "content-guard.js"));

test("Dateisperre: nur site.json und pages-JSONs", () => {
  assert.equal(guard.isAllowedFieldJsonFile("src/content/site.json"), true);
  assert.equal(guard.isAllowedFieldJsonFile("src/content/pages/home.json"), true);
  assert.equal(guard.isAllowedFieldJsonFile("src/content/cms.manifest.json"), false);
  assert.equal(guard.isAllowedFieldJsonFile("package.json"), false);
  assert.equal(guard.isAllowedFieldJsonFile("src/content/pages/../site.json"), false);
  assert.equal(guard.isAllowedFieldJsonFile("src/content/blog/a.md"), false);
});

test("kanonische Ziele: Schreibweisen sind gleich", () => {
  assert.equal(
    guard.canonicalTarget("f.json", "items[0].x"),
    guard.canonicalTarget("f.json", "items.0.x")
  );
  assert.equal(guard.canonicalTarget("f.json", "__proto__.x"), null);
});

test("Banner: Stil-Enum, Länge, Dreifaltigkeit", () => {
  assert.deepEqual(guard.getBannerProblems({ enabled: true, variant: "info", text: "Hallo" }), []);
  assert.ok(guard.getBannerProblems({ enabled: true, variant: "info", text: "" }).length > 0);
  assert.ok(guard.getBannerProblems({ enabled: true, variant: "party", text: "x" }).length > 0);
  assert.ok(guard.getBannerProblems({ enabled: false, variant: "party", text: "x".repeat(161) }).length > 1);
  assert.deepEqual(guard.getBannerProblems({ enabled: false, variant: "info", text: "ok" }), []);
  assert.equal(guard.validateBannerValue("text", "x".repeat(161)) !== null, true);
});

test("Voll-Datei und gefährliche Schlüssel", () => {
  assert.equal(guard.validateFullJsonDraft('{"a":1}'), null);
  assert.match(guard.validateFullJsonDraft("[1,2]") ?? "", /Objekt/);
  assert.match(guard.validateFullJsonDraft('{"__proto__":{}}') ?? "", /verbotene/);
  assert.deepEqual(guard.findDangerousKeys({ a: { b: 1 } }), []);
  // Angriffsweg ist JSON-Text (dort wird __proto__ ein eigener Schlüssel)
  assert.ok(guard.findDangerousKeys(JSON.parse('{"a":{"__proto__":1}}')).length > 0);
});

test("freie Entwurfs-IDs: Format, Sperre, Pfad", () => {
  const ok = guard.parseFreeDraftIdSafe("json:src/content/pages/home.json:hero.title");
  assert.equal(ok.ok, true);
  assert.equal(guard.parseFreeDraftIdSafe("json:package.json:x").ok, false);
  assert.equal(guard.parseFreeDraftIdSafe("falsch").ok, false);
});

test("Alle Listen sind fest: Wachstum und Kürzen werden abgelehnt", () => {
  // (Referenz 1.1: kein dynamisches Modell mehr – auch FAQ nicht.)
  const live = new Map([["src/content/pages/faq.json", { items: [{ frage: "F?", antwort: "A." }] }]]);
  const gewachsen = new Map([
    ["src/content/pages/faq.json", { items: [{ frage: "F?", antwort: "A." }, { frage: "Neu?", antwort: "Ja." }] }],
  ]);
  const wachstum = guard.validateListStructures(live, gewachsen, () => false);
  assert.ok(wachstum.length > 0 && /fest/.test(wachstum.join(" ")));
  const gekuerzt = new Map([["src/content/pages/faq.json", { items: [] }]]);
  const schrumpf = guard.validateListStructures(live, gekuerzt, () => false);
  assert.ok(schrumpf.length > 0 && /gekürzt/.test(schrumpf.join(" ")));
  // Gleicher Stand bleibt ok, normale Textänderung auch
  assert.deepEqual(guard.validateListStructures(live, live, () => false), []);
  const geaendert = new Map([["src/content/pages/faq.json", { items: [{ frage: "F?", antwort: "Anders." }] }]]);
  assert.deepEqual(guard.validateListStructures(live, geaendert, () => false), []);
});

test("Freie Ergänzung neuer Pfade wird abgelehnt (nur Bestand + Banner)", () => {
  const live = { items: [{ frage: "F?" }] };
  const neu = guard.classifyFreeTarget("src/content/pages/faq.json", "items[1].frage", live, "Neu?");
  assert.equal(neu.ok, false);
  const bestand = guard.classifyFreeTarget("src/content/pages/faq.json", "items[0].frage", live, "Neu?");
  assert.equal(bestand.ok, true);
});
