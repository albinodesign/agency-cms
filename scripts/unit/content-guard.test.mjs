/** Unit-Tests: Inhaltsprüfung (Dateisperre, Banner, Payload, Listenmodelle). */
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

test("Standardmodell: nur FAQ wächst", () => {
  assert.notEqual(guard.findListModel("src/content/pages/faq.json", "items"), null);
  assert.equal(guard.findListModel("src/content/pages/home.json", "testimonials.items"), null);
});

test("modelleAusManifest: gültig, fehlerhaft, Standard bleibt", () => {
  const gut = guard.modelleAusManifest({
    sections: [],
    listenmodelle: [
      {
        datei: "src/content/pages/referenzen.json",
        pfad: "items",
        felder: { titel: "text", sterne: "number" },
      },
    ],
  });
  assert.equal(gut.fehler.length, 0);
  assert.equal(gut.modelle.length, 2);
  assert.notEqual(guard.findListModel("src/content/pages/referenzen.json", "items", gut.modelle), null);
  // Standardmodell weiter dabei
  assert.notEqual(guard.findListModel("src/content/pages/faq.json", "items", gut.modelle), null);

  const kaputt = guard.modelleAusManifest({
    sections: [],
    listenmodelle: [
      { datei: "package.json", pfad: "items", felder: { t: "text" } },
      { datei: "src/content/pages/a.json", pfad: "items[0]", felder: { t: "text" } },
      { datei: "src/content/pages/a.json", pfad: "items", felder: { t: "emial" } },
      { datei: "src/content/pages/a.json", pfad: "items", felder: {} },
    ],
  });
  assert.equal(kaputt.fehler.length, 4);
  assert.equal(kaputt.modelle.length, 1);

  const ohne = guard.modelleAusManifest({ sections: [] });
  assert.deepEqual(ohne.fehler, []);
  assert.equal(ohne.modelle.length, 1);
});

test("deklariertes Modell: Wachstum vollständig ok, unvollständig blockiert", () => {
  const { modelle } = guard.modelleAusManifest({
    sections: [],
    listenmodelle: [
      { datei: "src/content/pages/referenzen.json", pfad: "items", felder: { titel: "text" } },
    ],
  });
  const live = new Map([["src/content/pages/referenzen.json", { items: [{ titel: "A" }] }]]);
  const voll = new Map([["src/content/pages/referenzen.json", { items: [{ titel: "A" }, { titel: "B" }] }]]);
  assert.deepEqual(guard.validateListStructures(live, voll, () => false, modelle), []);
  const leer = new Map([["src/content/pages/referenzen.json", { items: [{ titel: "A" }, { titel: "" }] }]]);
  assert.ok(guard.validateListStructures(live, leer, () => false, modelle).length > 0);
  // Feste Liste ohne Modell wächst weiter nicht
  const fest = new Map([["src/content/pages/home.json", { items: ["a", "b"] }]]);
  assert.ok(
    guard.validateListStructures(new Map([["src/content/pages/home.json", { items: ["a"] }]]), fest, () => false, modelle)
      .length > 0
  );
});
