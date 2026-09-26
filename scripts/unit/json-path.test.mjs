/** Unit-Tests: Pfadfunktionen (getByPath/setByPath/parsePathSafe). */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = process.env.UNIT_LIB ?? path.join("..", "..", ".tmp-unit", "lib");
const { getByPath, setByPath, parsePathSafe } = require(path.join(lib, "json-path.js"));

test("parsePathSafe: gültige Pfade", () => {
  const ok = parsePathSafe("hero.title");
  assert.equal(ok.ok, true);
  const idx = parsePathSafe("items[0].frage");
  assert.equal(idx.ok, true);
  assert.deepEqual(idx.segments, ["items", 0, "frage"]);
  assert.equal(idx.canonical, "items[0].frage");
});

test("parsePathSafe: Schreibweisen werden kanonisch gleich", () => {
  const a = parsePathSafe("items[0].x");
  const b = parsePathSafe("items.0.x");
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.canonical, b.canonical);
});

test("parsePathSafe: Tricks werden abgelehnt", () => {
  for (const p of ["__proto__.x", "a.constructor.b", "a..b", "", "items[foo].x"]) {
    const r = parsePathSafe(p);
    assert.equal(r.ok, false, `Pfad "${p}" muss abgelehnt werden`);
  }
});

test("getByPath: liest Werte, keine Prototypen", () => {
  const json = { hero: { title: "Hallo" }, items: [{ frage: "F?" }] };
  assert.equal(getByPath(json, "hero.title"), "Hallo");
  assert.equal(getByPath(json, "items[0].frage"), "F?");
  assert.equal(getByPath(json, "fehlt.nicht"), undefined);
  assert.equal(getByPath(json, "__proto__.x"), undefined);
  assert.equal(getByPath(json, "items[5].frage"), undefined);
});

test("setByPath: schreibt Bestand, legt nur reine Objekte an", () => {
  const json = { hero: { title: "Alt" } };
  setByPath(json, "hero.title", "Neu");
  assert.equal(json.hero.title, "Neu");
  const leer = {};
  setByPath(leer, "neu.bereich.titel", "T");
  assert.equal(leer.neu.bereich.titel, "T");
  assert.throws(() => setByPath({ items: ["a"] }, "items[5]", "x"));
  assert.throws(() => setByPath({}, "__proto__.x", "y"));
});
