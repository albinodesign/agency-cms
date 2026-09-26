/** Unit-Tests: Vorschau-URLs je CMS-Seite (document.referrer-Falle). */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = process.env.UNIT_LIB ?? path.join("..", "..", ".tmp-unit", "lib");
const { pageSlugFromFile, isHomeSlug, getPagePreviewUrl } = require(
  path.join(lib, "preview-url.js")
);

const page = (...files) => ({
  sections: [{ id: "s", title: "S", fields: files.map((file) => ({ file })) }],
});

test("pageSlugFromFile liest nur pages-JSON", () => {
  assert.equal(pageSlugFromFile("src/content/pages/kontakt.json"), "kontakt");
  assert.equal(pageSlugFromFile("src/content/pages/home.json"), "home");
  assert.equal(pageSlugFromFile("src/content/site.json"), null);
  assert.equal(pageSlugFromFile("src/content/pages/../x.json"), null);
  assert.equal(pageSlugFromFile(null), null);
  assert.equal(pageSlugFromFile(""), null);
});

test("isHomeSlug erkennt Startseiten", () => {
  for (const s of ["home", "index", "start", "startseite", "Home"]) {
    assert.ok(isHomeSlug(s), s);
  }
  assert.ok(!isHomeSlug("kontakt"));
  assert.ok(!isHomeSlug("homepage"));
});

test("getPagePreviewUrl hängt den Slug an", () => {
  assert.equal(
    getPagePreviewUrl("https://klarwerk-fenster.de", page("src/content/pages/kontakt.json")),
    "https://klarwerk-fenster.de/kontakt"
  );
  assert.equal(
    getPagePreviewUrl("https://klarwerk-fenster.de/", page("src/content/pages/kontakt.json")),
    "https://klarwerk-fenster.de/kontakt"
  );
});

test("Startseite und Firmendaten landen auf der Basis-URL", () => {
  assert.equal(
    getPagePreviewUrl("https://klarwerk-fenster.de", page("src/content/pages/home.json")),
    "https://klarwerk-fenster.de"
  );
  assert.equal(
    getPagePreviewUrl("https://klarwerk-fenster.de", page("src/content/site.json")),
    "https://klarwerk-fenster.de"
  );
  assert.equal(
    getPagePreviewUrl("https://klarwerk-fenster.de", { sections: [] }),
    "https://klarwerk-fenster.de"
  );
});

test("Mehrere Dateien: häufigster Slug gewinnt", () => {
  const p = {
    sections: [
      {
        id: "a",
        title: "A",
        fields: [
          { file: "src/content/pages/leistungen.json" },
          { file: "src/content/pages/leistungen.json" },
          { file: "src/content/pages/home.json" },
        ],
      },
    ],
  };
  assert.equal(
    getPagePreviewUrl("https://klarwerk-fenster.de", p),
    "https://klarwerk-fenster.de/leistungen"
  );
});

test("Unsichere Basis bleibt unverändert", () => {
  const p = page("src/content/pages/kontakt.json");
  assert.equal(
    getPagePreviewUrl("https://klarwerk-fenster.de/?x=1", p),
    "https://klarwerk-fenster.de/?x=1"
  );
  assert.equal(getPagePreviewUrl("keine-url", p), "keine-url");
});
