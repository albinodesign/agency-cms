/** Unit-Tests: Slug-Erzeugung. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = process.env.UNIT_LIB ?? path.join("..", "..", ".tmp-unit", "lib");
const { slugify } = require(path.join(lib, "slugify.js"));

test("Umlaute und Sonderzeichen", () => {
  assert.equal(slugify("Bäder & Küche – Hannover!"), "baeder-kueche-hannover");
  assert.equal(slugify("Größe prüfen"), "groesse-pruefen");
  assert.equal(slugify("  Hallo  Welt  "), "hallo-welt");
});

test("Grenzen", () => {
  assert.equal(slugify(""), "");
  assert.ok(slugify("a".repeat(200)).length <= 80);
});
