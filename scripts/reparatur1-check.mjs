/**
 * Abnahme-Tests für REPARATUR 1 (Inhaltsziele + JSON-Pfade absichern).
 *
 * Kein Test-Framework nötig: Das Script kompiliert die reinen Prüf-Libs
 * (json-path, content-guard, validate) mit dem vorhandenen TypeScript in
 * einen Temp-Ordner und prüft die Abnahmefälle mit einfachen Assertions.
 * Keine Netzaufrufe, keine Produktion – nur lokale Logik.
 *
 * Start: npm run test:reparatur1
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = path.join(root, ".tmp-rep1");

fs.rmSync(tmp, { recursive: true, force: true });

// Eigene Test-tsconfig: strict wie im Projekt + @/*-Alias auflösen.
const tsconfigPath = path.join(tmp + "-tsconfig.json");
fs.writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      baseUrl: root,
      paths: { "@/*": ["src/*"] },
      outDir: tmp,
      module: "commonjs",
      target: "es2020",
      moduleResolution: "node",
      skipLibCheck: true,
      strict: true,
      esModuleInterop: true,
    },
    include: [
      "src/lib/json-path.ts",
      "src/lib/content-guard.ts",
      "src/lib/validate.ts",
      "src/types/cms.ts",
    ],
  })
);
try {
  execSync(`npx tsc -p ${tsconfigPath}`, { cwd: root, stdio: "inherit" });
} finally {
  fs.rmSync(tsconfigPath, { force: true });
}

const jp = require(path.join(tmp, "lib", "json-path.js"));
const guard = require(path.join(tmp, "lib", "content-guard.js"));

let passed = 0;
function ok(condition, name) {
  if (!condition) {
    console.error(`FEHLGESCHLAGEN: ${name}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`ok: ${name}`);
  }
}

// 1) Gültiger Text in site.json lässt sich ändern
{
  const site = { banner: { enabled: false, text: "alt" } };
  ok(jp.getByPath(site, "banner.text") === "alt", "site.json lesen");
  jp.setByPath(site, "banner.text", "neu");
  ok(site.banner.text === "neu", "site.json Text ändern");
}

// 2) Gültiges Array-Feld in Seiten-JSON (beide Schreibweisen)
{
  const page = { faq: { items: [{ frage: "Q1" }, { frage: "Q2" }] } };
  ok(jp.getByPath(page, "faq.items[0].frage") === "Q1", "Array lesen mit [0]");
  ok(jp.getByPath(page, "faq.items.0.frage") === "Q1", "Array lesen mit .0");
  jp.setByPath(page, "faq.items[1].frage", "Q2 neu");
  ok(page.faq.items[1].frage === "Q2 neu", "Array-Eintrag ändern");
  ok(
    guard.canonicalTarget("f", "faq.items[0].frage") ===
      guard.canonicalTarget("f", "faq.items.0.frage"),
    "Schreibweisen sind dasselbe Ziel"
  );
}

// 3) Großes gültiges Manifest (200 Felder) wird vollständig verarbeitet
{
  const fields = [];
  const items = [];
  for (let i = 0; i < 200; i += 1) {
    fields.push({
      id: `feld.${i}`,
      label: `Feld ${i}`,
      type: "text",
      file: "src/content/pages/gross.json",
      path: `items[${i}].titel`,
    });
    items.push({ titel: `Titel ${i}` });
  }
  const contents = new Map([["src/content/pages/gross.json", { items }]]);
  const errors = guard.validateFieldTargets(fields, contents);
  ok(errors.length === 0, `200-Felder-Manifest ohne Fehler (${errors.slice(0, 2).join(" | ")})`);
}

// 4) Manifestfeld mit Ziel package.json oder Manifest wird abgelehnt
{
  const contents = new Map([["src/content/site.json", { titel: "x" }]]);
  const pkg = guard.validateFieldTargets(
    [{ id: "böse", label: "Böse", type: "text", file: "package.json", path: "scripts" }],
    contents
  );
  ok(pkg.length > 0 && /package\.json/.test(pkg[0]), "package.json als Ziel abgelehnt");
  const mani = guard.validateFieldTargets(
    [{ id: "m", label: "M", type: "text", file: "src/content/cms.manifest.json", path: "sections" }],
    contents
  );
  ok(mani.length > 0, "Manifest als Ziel abgelehnt");
}

// 5) Freier Entwurf kann die Sperre nicht umgehen
{
  const bad = guard.parseFreeDraftIdSafe("json:package.json:scripts");
  ok(!bad.ok, "freier Entwurf auf package.json abgelehnt");
  const trav = guard.parseFreeDraftIdSafe("json:src/content/pages/../../x.json:a");
  ok(!trav.ok, "freier Entwurf mit Traversal abgelehnt");
  const good = guard.parseFreeDraftIdSafe("json:src/content/site.json:banner.enabled");
  ok(good.ok && good.file === "src/content/site.json", "freier Entwurf auf site.json ok");
}

// 6) Traversal, Prototypsegmente, fehlende Eigenschaften, ungültige Indizes
{
  ok(!guard.isAllowedFieldJsonFile("src/content/pages/../../etc/x.json"), "Traversal-Datei abgelehnt");
  ok(!guard.isAllowedFieldJsonFile("/src/content/site.json"), "absoluter Pfad abgelehnt");
  ok(!jp.parsePathSafe("__proto__.x").ok, "__proto__ abgelehnt");
  ok(!jp.parsePathSafe("a.constructor.b").ok, "constructor abgelehnt");
  ok(!jp.parsePathSafe("a.prototype").ok, "prototype abgelehnt");
  ok(!jp.parsePathSafe("a[foo]").ok, "nicht-numerische Klammer abgelehnt");
  const page = { items: [{ t: "a" }] };
  ok(jp.getByPath(page, "items[5].t") === undefined, "ungültiger Index liefert undefined");
  ok(jp.getByPath(page, "fehlt.tief") === undefined, "fehlende Eigenschaft liefert undefined");
  let appendOk = true;
  try {
    jp.setByPath(page, "items[1].t", "neu");
  } catch {
    appendOk = false;
  }
  ok(appendOk && page.items[1].t === "neu", "Anhängen am Listen-Ende erlaubt");
  let farOutRejected = false;
  try {
    jp.setByPath(page, "items[5].t", "x");
  } catch {
    farOutRejected = true;
  }
  ok(farOutRejected, "weit entfernter Index wird abgelehnt");
  let arrayCreated = true;
  try {
    jp.setByPath({}, "neu.items[0].t", "x");
  } catch {
    arrayCreated = false;
  }
  ok(!arrayCreated, "kein Array aus Kundeneingabe erzeugt");
  const missing = guard.validateFieldTargets(
    [{ id: "x", label: "X", type: "text", file: "src/content/pages/a.json", path: "gibt.es.nicht" }],
    new Map([["src/content/pages/a.json", { anders: 1 }]])
  );
  ok(missing.length > 0 && /existiert nicht/.test(missing[0]), "fehlender Pfad wird gemeldet");
}

// 7) Unterschiedliche Schreibweisen = Duplikat
{
  const dup = guard.validateFieldTargets(
    [
      { id: "a", label: "A", type: "text", file: "src/content/pages/a.json", path: "items[0].t" },
      { id: "b", label: "B", type: "text", file: "src/content/pages/a.json", path: "items.0.t" },
    ],
    new Map([["src/content/pages/a.json", { items: [{ t: "x" }] }]])
  );
  ok(dup.length > 0 && /dasselbe Ziel/.test(dup[0]), "Duplikat über Schreibweisen erkannt");
}

// 8) Unerlaubtes Ziel im Satz -> Fehlerliste nicht leer (Route schreibt dann nichts)
{
  const errors = guard.validateFieldTargets(
    [
      { id: "gut", label: "Gut", type: "text", file: "src/content/site.json", path: "titel" },
      { id: "böse", label: "Böse", type: "text", file: "package.json", path: "scripts" },
    ],
    new Map([["src/content/site.json", { titel: "x" }]])
  );
  ok(errors.length > 0, "Satz mit unerlaubtem Ziel wird als Ganzes abgelehnt");
}

// 9) Volle Datei-Entwürfe: Objekt ok, Array und Tricks abgelehnt
{
  ok(guard.validateFullJsonDraft('{"a":1}') === null, "gültiges JSON-Objekt ok");
  ok(guard.validateFullJsonDraft('[1,2]') !== null, "JSON-Array abgelehnt");
  ok(guard.validateFullJsonDraft('{"__proto__":{"x":1}}') !== null, "__proto__-Schlüssel abgelehnt");
  ok(guard.validateFullJsonDraft('kein json') !== null, "kaputtes JSON abgelehnt");
}

// 10) Typen und doppelte IDs
{
  const errors = guard.validateFieldTargets(
    [
      { id: "doppelt", label: "A", type: "text", file: "src/content/site.json", path: "titel" },
      { id: "doppelt", label: "B", type: "regenbogen", file: "src/content/site.json", path: "titel" },
    ],
    new Map([["src/content/site.json", { titel: "x" }]])
  );
  ok(errors.some((e) => /doppelt/.test(e)), "doppelte ID gemeldet");
  ok(errors.some((e) => /nicht unterstützt/.test(e)), "unbekannter Typ gemeldet");
}

fs.rmSync(tmp, { recursive: true, force: true });
if (process.exitCode) {
  console.log(`\nFEHLER: ${passed} bestanden, mindestens ein Test ist fehlgeschlagen.`);
} else {
  console.log(`\n${passed} Abnahme-Tests bestanden.`);
}
