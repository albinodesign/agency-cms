/** Unit-Tests: Entwurfs- und Endtyp-Prüfung. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = process.env.UNIT_LIB ?? path.join("..", "..", ".tmp-unit", "lib");
const { validateDraftValue, validateFinalJsonValue, convertStoredValue } = require(
  path.join(lib, "validate.js")
);

test("Zahlen: tolerant im Entwurf, streng im Endstand", () => {
  assert.equal(validateDraftValue("number", "42"), null);
  assert.equal(validateDraftValue("number", "19,90"), null);
  assert.match(validateDraftValue("number", "zwölf") ?? "", /Zahl/);
  assert.equal(validateFinalJsonValue("number", 42), null);
  assert.notEqual(validateFinalJsonValue("number", "42"), null);
  assert.notEqual(validateFinalJsonValue("number", null), null);
  assert.notEqual(validateFinalJsonValue("number", NaN), null);
});

test("Boolean: Text bleibt Text, echt bleibt echt", () => {
  assert.equal(validateDraftValue("boolean", "true"), null);
  assert.match(validateDraftValue("boolean", "ja") ?? "", /An\/Aus/);
  assert.equal(validateFinalJsonValue("boolean", true), null);
  assert.notEqual(validateFinalJsonValue("boolean", "true"), null);
});

test("Text/E-Mail/URL/Datum/Telefon", () => {
  assert.equal(validateDraftValue("text", "Hallo"), null);
  assert.equal(validateDraftValue("text", ""), null);
  assert.equal(validateDraftValue("email", "a@b.de"), null);
  assert.match(validateDraftValue("email", "keine-mail") ?? "", /E-Mail/);
  assert.equal(validateDraftValue("url", "https://x.de"), null);
  assert.match(validateDraftValue("url", "javascript:alert(1)") ?? "", /http|Internetadresse/);
  assert.equal(validateDraftValue("date", "2026-09-26"), null);
  assert.match(validateDraftValue("date", "26.09.2026") ?? "", /Datum/);
  assert.equal(validateDraftValue("phone", "+49 171 123456"), null);
});

test("Bild-URLs: relativ ok, Tricks abgelehnt", () => {
  assert.equal(validateDraftValue("image", "https://cdn.de/b.png"), null);
  assert.equal(validateDraftValue("image", "/bilder/foto.jpg"), null);
  assert.equal(validateDraftValue("image", "logo.png"), null);
  assert.match(validateDraftValue("image", "../geheim.txt") ?? "", /Internetadresse/);
  assert.match(validateDraftValue("image", "data:image/png;base64,xx") ?? "", /http|Internetadresse/);
});

test("maxLength gilt überall", () => {
  assert.match(validateDraftValue("text", "abcdef", 5) ?? "", /zu lang/);
  assert.notEqual(validateFinalJsonValue("text", "abcdef", 5), null);
});

test("convertStoredValue: nur Zahl/Boolean werden umgewandelt", () => {
  assert.equal(convertStoredValue("number", "19,90"), 19.9);
  assert.equal(convertStoredValue("boolean", "true"), true);
  assert.equal(convertStoredValue("boolean", "false"), false);
  assert.equal(convertStoredValue("text", "true"), "true");
  assert.equal(convertStoredValue("text", "42"), "42");
});
