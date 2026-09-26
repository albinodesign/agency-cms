# CMS-REFERENCE.md — Verbindlicher Contract: Agency CMS ↔ Website

- **Version:** 1.0 · **Stand:** 2026-09-26 · **CMS-Kompatibilität:** `main` ab Merge-PR #1
- **Diese Datei gewinnt:** Bei Widerspruch zwischen dieser Referenz, `AGENTS.md` und `README.md` gilt **immer diese Datei**.
- **Adressat:** KI-Coding-Agenten und Entwickler, die eine Website **neu** CMS-kompatibel bauen. Kein Vorwissen über das CMS nötig.

## 1. Überblick & Zweck

Das Agency CMS lässt nicht-technische Kunden Texte, Bilder und Blog-Artikel ihrer Website selbst bearbeiten. Das CMS schreibt Änderungen per GitHub-API als Commits auf den Branch `main`; Vercel deployed automatisch. Die Website muss dafür drei Dinge liefern: (a) ein **Manifest**, das alle editierbaren Felder beschreibt, (b) **Content-Dateien** in festem Format, (c) eine **Vorschau-Brücke** (Script + DOM-Marker), damit Tippen sofort sichtbar wird und Klicks Felder finden.

**Wer die Referenz missachtet:** Felder erscheinen nicht im Editor (falsche Pfade), Publish schlägt fehl (falsche Typen/Listen), die Vorschau bleibt stumm (fehlende Marker/Brücke) oder wird manipulierbar (fehlende Origin-Checks).

## 2. Quick Reference

| Was | Wert |
|---|---|
| Manifest-Pfad (im Website-Repo) | `src/content/cms.manifest.json` |
| Einzeldatei | `src/content/site.json` |
| Seiten-Dateien | `src/content/pages/[name].json` (nur `[A-Za-z0-9][A-Za-z0-9._-]*`, max. 200 Zeichen, kein `..`) |
| Blog-Artikel | `src/content/blog/[slug].md`, nur `[a-z0-9-]` |
| Branch | `main` (Vercel-Produktion **muss** `main` deployen) |
| JSON-Format beim Zurückschreiben | `JSON.stringify(data, null, 2)` — unbekannte Schlüssel **niemals** entfernen |
| Nachrichten CMS → Website | `CMS_FIELD_UPDATE`, `CMS_SELECT_MODE` |
| Nachricht Website → CMS | `CMS_FIELD_SELECT` |
| DOM-Marker | `data-cms-section="[sektion-id]"`, `data-cms-field="[feld-id]"` |
| Iframe-Erkennung | nur wenn `window.self !== window.top` |
| Banner-Objekt | `site.banner` = `{ enabled, variant, text }` |
| Bild-URLs aus dem CMS | öffentliche `https://…`-URLs (Supabase-Bucket `cms-media`) |
| Maxima | Pfad: 20 Segmente / 500 Zeichen / Index ≤ 9999 · `maxLength` ≤ 10000 · Banner-Text ≤ 160 · Blog: Titel ≤ 200, Excerpt ≤ 500, Alt ≤ 200, Inhalt ≤ 100.000 |

## 3. Manifest-Format

```json
{
  "sections": [
    {
      "id": "hero",
      "title": "Hero-Bereich",
      "page": "Startseite",
      "fields": [
        { "id": "hero.title", "label": "Titel", "type": "text", "file": "src/content/pages/home.json", "path": "hero.title", "placeholder": "Willkommen …", "maxLength": 90 },
        { "id": "hero.bild", "label": "Hintergrundbild", "type": "image", "file": "src/content/pages/home.json", "path": "hero.image", "aspectRatio": "16:9" },
        { "id": "preis.betrag", "label": "Preis (€)", "type": "number", "file": "src/content/pages/preise.json", "path": "preis.betrag" }
      ]
    }
  ],
  "features": { "blog": true },
  "listenmodelle": [
    { "datei": "src/content/pages/referenzen.json", "pfad": "items", "felder": { "titel": "text", "text": "text", "sterne": "number" } }
  ]
}
```

| Schlüssel | Pflicht | Regeln |
|---|---|---|
| `sections[].id` | ja (Fallback `section-N` + Warnung) | beliebig, seitenweit eindeutig empfohlen |
| `sections[].title` | ja (Fallback-Kette + Warnung) | Anzeigetext im Editor |
| `sections[].page` | nein | Gruppiert Tabs; ohne Angabe rät der Editor per Heuristik |
| `sections[].fields[]` | ja | leere Sektionen werden ausgeblendet + Warnung |
| `fields[].id` | ja | **global eindeutig** — Duplikat bricht den **gesamten** Publish ab (400) |
| `fields[].label` | ja (Fallback `title` → `id`) | Anzeigetext |
| `fields[].type` | ja | einer der 9 Typen (Abschnitt 4); unbekannt → `text` + Warnung |
| `fields[].file` | ja | nur `src/content/site.json` oder `src/content/pages/*.json`, sonst 400 |
| `fields[].path` | ja | Dot-Path, `items[0].x` ≡ `items.0.x`; verboten: `__proto__`/`constructor`/`prototype`, leere Segmente, nicht-numerische Klammern |
| `fields[].placeholder` | nein | Beispieltext |
| `fields[].maxLength` | nein | ganze Zahl 1–10000; Überlänge blockiert Publish dieser Datei |
| `fields[].aspectRatio` | nein | nur Hinweis im Editor (`"16:9"`, `"1:1"`, `"4:3"`) |
| `features.blog` | nein | `true` oder `{ "enabled": true }` zeigt den Blog-Tab |
| `listenmodelle[]` | nein | siehe Abschnitt 8; Fehler brechen den gesamten Publish ab |

Alternative Wurzelformen (`[ … ]`, `{ "fields": […] }`) werden akzeptiert. Das Manifest muss nach Normalisierung **mindestens eine Sektion mit Feldern** ergeben, sonst gilt es als ungültig.

## 4. Unterstützte Feldtypen

| Typ | Editor | Beispielwert in JSON | Validierung (Entwurf → Publish) |
|---|---|---|---|
| `text` | einzeilig | `"Willkommen"` | beliebig (leer ok); `"true"` bleibt Text |
| `textarea` | mehrzeilig | `"Zeile 1\nZeile 2"` | wie `text` |
| `image` | Upload + URL | `"https://….supabase.co/…/foto.jpg"` | http(s) oder sicherer relativer Pfad (`/bilder/x.jpg`, `logo.png`); verboten: `javascript:`/`data:`, `..`, Leerzeichen/Quotes |
| `number` | Eingabe | `19.9` (echte Zahl!) | Entwurf: `"42"`, `"19,90"` ok; Publish: **echte endliche Zahl**, leeres Feld blockiert |
| `email` | Eingabe | `"info@beispiel.de"` | Form `a@b.cc` |
| `phone` | Eingabe | `"+49 171 123456"` | beginnt mit `+(`/Ziffer, mind. 5 Zeichen |
| `url` | Eingabe | `"https://beispiel.de"` | wie `image`, zusätzlich `http://` ok |
| `date` | Datum | `"2026-09-26"` | exakt `JJJJ-MM-TT` + echtes Kalenderdatum |
| `boolean` | An/Aus-Schalter | `true` (echt!) | Entwurf: `"true"`/`"false"`; Publish: **echter Boolean**, leer blockiert |

Regel für alle Typen: Der Endstand nach Publish enthält **niemals** `null`, falsche Typen oder überlange Texte in deklarierten Feldern — sonst wird die Datei zurückgehalten (400 je Datei, Rest geht trotzdem live).

## 5. Content-Datei-Struktur

`src/content/site.json` (flach; `banner` exakt so — der Editor schreibt `banner.enabled|variant|text`):

```json
{
  "firma": { "name": "Malerbetrieb Schmidt", "telefon": "+49 171 123456" },
  "banner": { "enabled": false, "variant": "info", "text": "" }
}
```

`src/content/pages/home.json` (beliebig tief; Listen-Sonderregeln in Abschnitt 8):

```json
{
  "hero": { "title": "Willkommen", "image": "https://….supabase.co/…/hero.jpg" },
  "faq": { "items": [{ "frage": "Wie schnell?", "antwort": "In 48h." }] }
}
```

`src/content/blog/willkommen.md` (Frontmatter exakt diese Schlüssel):

```markdown
---
title: "Willkommen im Blog"
slug: "willkommen"
date: "2026-09-26"
coverImage: "https://….supabase.co/…/cover.jpg"
coverImageAlt: "Werkstatt von innen"
excerpt: "Erster Artikel in zwei Sätzen."
draft: false
---

Artikeltext in Markdown …
```

Regeln: `slug` aus Titel (klein, ä→ae/ö→oe/ü→ue/ß→ss, nur `[a-z0-9-]`, max. 80 Zeichen). `coverImageAlt` leer → Titel gilt. `draft: true` = nicht öffentlich. **Website-Pflicht:** Content-Dateien nie umformatieren, nie Schlüssel löschen, fremde Schlüssel stehen lassen.

## 6. DOM-Marker

Jede Sektion trägt die Sektions-ID, jedes editierbare Element die Feld-ID aus dem Manifest. Mehrfachvorkommen derselben Feld-ID sind erlaubt (alle werden aktualisiert). Verhalten pro Tag: `IMG` → `src` neu + `srcset` entfernen; `SOURCE` → `srcset` neu; alles andere → `textContent` neu.

```astro
---
// fellowship: data-cms-field MUSS exakt die Manifest-ID sein
import { getEntry } from "astro:content";
const home = await getEntry("pages", "home");
---
<section data-cms-section="hero">
  <h1 data-cms-field="hero.title">{home.data.hero.title}</h1>
  <img data-cms-field="hero.bild" src={home.data.hero.image} alt="Hero" />
  <a data-cms-field="kontakt.mail" href={`mailto:${site.data.kontakt.mail}`}>
    <span data-cms-field="kontakt.mailtext">E-Mail schreiben</span>
  </a>
</section>
```

Hinweis: `data-cms-section` dient der Struktur und ist für künftige Sprünge reserviert — aktuell springt das CMS nur zu `data-cms-field`. Beide Marker trotzdem immer setzen.

## 7. Preview-Protokoll

Drei Nachrichten, zwei Richtungen. **Niemals** `postMessage(…, "*")` — immer konkrete Origins (Agentur trägt CMS-Domain + `http://localhost:3000` für lokal ein).

```html
<script is:inline>
  if (window.self !== window.top) {
    const CMS_ORIGINS = ["https://cms.deine-agentur.de", "http://localhost:3000"];
    let selectMode = true; // true = „Finden", false = „Surfen"
    window.addEventListener("message", (event) => {
      if (!CMS_ORIGINS.includes(event.origin)) return;   // 1. Origin
      if (event.source !== window.parent) return;        // 2. Quelle
      if (event.data?.type === "CMS_SELECT_MODE") { selectMode = event.data.enabled !== false; return; }
      if (event.data?.type !== "CMS_FIELD_UPDATE") return;
      if (typeof event.data.field !== "string" || typeof event.data.value !== "string") return; // 3. Form
      if (/[<>"'`]/.test(event.data.field)) return;      // 4. keine Injection
      document.querySelectorAll(`[data-cms-field="${CSS.escape(event.data.field)}"]`).forEach((el) => {
        if (el.tagName === "IMG") { el.src = event.data.value; el.removeAttribute("srcset"); }
        else if (el.tagName === "SOURCE") { el.srcset = event.data.value; }
        else { el.textContent = event.data.value; }
      });
    });
    function cmsTargetOrigin() {
      try { const ref = new URL(document.referrer); if (CMS_ORIGINS.includes(ref.origin)) return ref.origin; }
      catch { /* nichts senden */ } return null;
    }
    document.addEventListener("click", (event) => {
      if (!selectMode) return;
      const el = event.target.closest("[data-cms-field]"); if (!el) return;
      const target = cmsTargetOrigin(); if (!target) return;
      event.preventDefault(); event.stopPropagation();
      document.querySelectorAll(".cms-selected").forEach((n) => n.classList.remove("cms-selected"));
      el.classList.add("cms-selected");
      window.parent.postMessage({ type: "CMS_FIELD_SELECT", field: el.getAttribute("data-cms-field") }, target);
    }, true);
    const style = document.createElement("style");
    style.textContent = `[data-cms-field]:hover{outline:2px solid #2563eb;outline-offset:2px;cursor:pointer}.cms-selected{outline:2px solid #2563eb!important;outline-offset:2px}`;
    document.head.appendChild(style);
  }
</script>
```

Nachrichten: `CMS_FIELD_UPDATE { field, value }` (CMS→Seite, sofort beim Tippen), `CMS_SELECT_MODE { enabled }` (CMS→Seite, auch bei jedem Iframe-Neuladen), `CMS_FIELD_SELECT { field }` (Seite→CMS, nur Feld-ID, nie Inhalte). Unbekannte/ungültige Nachrichten werden **still ignoriert** (keine Fehler, kein Fallback).

## 8. Banner-System

`site.banner` in `src/content/site.json`: `{ "enabled": boolean, "variant": "vacation"|"emergency"|"info", "text": string ≤ 160 Zeichen }`. Regeln: `enabled: true` braucht Stil **und** Text; vorhandene Werte müssen **auch bei `enabled: false`** gültig sein; unbekannte Schlüssel verboten. Standard für neue Websites: `{ "enabled": false, "variant": "info", "text": "" }`.

```astro
{site.data.banner?.enabled && (
  <div class={`banner banner--${site.data.banner.variant}`}>
    {site.data.banner.text}
  </div>
)}
```

## 9. Bild-Handling

Das CMS lädt hoch (lange Seite ≤ 1600 px, ≤ ~500 KB, Original ≤ 15 MB, **kein SVG**), die Website rendert nur: normale `<img src="https://…">`, keine Build-Config nötig. `coverImageAlt` aus dem Blog-Frontmatter als `alt`, Fallback Titel. TODO: Alt-Texte für Content-Bilder kennt das CMS derzeit nicht — dort sprechende Dateinamen oder festen `alt` im Template verwenden.

## 10. Validierung & Schemas (Kurzform für Templates)

```ts
const BLOG_RE = /^src\/content\/blog\/[a-z0-9-]+\.md$/;
const blogOk = (f: any) =>
  typeof f.title === "string" && f.title.trim().length <= 200 &&
  /^\d{4}-\d{2}-\d{2}$/.test(f.date ?? "") && !Number.isNaN(Date.parse(f.date)) &&
  (f.excerpt ?? "").length <= 500 && (f.coverImageAlt ?? "").length <= 200 &&
  typeof f.draft === "boolean" && BLOG_RE.test(`src/content/blog/${f.slug}.md`);
```

Content: Pfade ≤ 20 Segmente / 500 Zeichen / Index ≤ 9999; Dateien ≤ 200 Zeichen Pfadlänge; freie Werte ≤ 20.000 Zeichen. Fehlerverhalten: Publish prüft je Datei — fehlerhafte Dateien bleiben Entwurf (400 je Datei mit Grund), saubere gehen live (`partial: true` möglich).

## 11. Website-Kompatibilitäts-Checkliste

- [ ] Manifest unter `src/content/cms.manifest.json`, ≥ 1 Sektion mit Feldern, IDs global eindeutig
- [ ] Alle `file`-Ziele erlaubt, alle `path`-Pfade existieren in den Dateien
- [ ] Alle Typen aus Abschnitt 4, Zahlen/Booleans als echte JSON-Typen in den Dateien
- [ ] `site.json` mit gültigem `banner`-Objekt (Abschnitt 8)
- [ ] Jede Sektion `data-cms-section`, jedes editierbare Element `data-cms-field` (exakte IDs)
- [ ] Brücken-Script aus Abschnitt 7 verbatim mit echten `CMS_ORIGINS`, nur im Iframe aktiv
- [ ] Kein `postMessage("*")`, `CSS.escape` verwendet, Klick nur mit gültigem Ziel-Origin
- [ ] Blog: Frontmatter-Schlüssel + Grenzen, Slugs `[a-z0-9-]` ≤ 80, `draft`-Flag beachtet
- [ ] Branch `main` wird von Vercel als Produktion deployed; Content-Dateien werden nie umgeschrieben/gelöscht
- [ ] Listen: nur modellierte wachsen (`listenmodelle` oder FAQ); feste Listen unangetastet lassen

## 12. Häufige Fehler

| Fehler | Konsequenz | Richtig |
|---|---|---|
| `postMessage(…, "*")` / fehlender Origin-Check | fremde Seiten schreiben Vorschau um | Abschnitt 7 verbatim |
| Feld-ID-Typo im Template | Feld nicht klickbar/aktualisierbar | IDs aus Manifest kopieren, nie tippen |
| `type: "emial"` im Manifest | wird still `text` (+ Warnung) | Typen aus Abschnitt 4 |
| Zahl als `"19,90"` in JSON-Datei | Publish blockiert Datei | echte Zahl `19.9` schreiben |
| Liste ohne Modell per Code verlängert | Publish blockiert Datei („feste Liste") | `listenmodelle` ins Manifest |
| Banner-Stil `"party"` erfunden | Publish blockiert `site.json` | nur `vacation`/`emergency`/`info` |
| Content-Datei neu formatiert/gelöscht | Diff/History unbrauchbar, Publish-Fehler | Dateien nur lesen, nie schreiben |
| `data-cms-field` auf Wrapper statt Ziel | falsches Element blinkt | Marker ans innerste editierbare Element |

## 13. Änderungshistorie

- **1.0 (2026-09-26):** Ersterstellung aus CMS-`main` (Merge-PR #1 + Verlauf-Hotfix). Abgedeckt: Manifest, 9 Feldtypen, Content-Dateien, Marker, sicheres Preview-Protokoll, Banner, Bilder, Blog-Validierung, Listenmodelle.
- TODOs: Alt-Texte für Content-Bilder (CMS-Konzept fehlt); `data-cms-section`-Auswertung (reserviert, CMS springt nur zu Feldern).
