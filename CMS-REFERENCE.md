# CMS-REFERENCE.md — Verbindlicher Contract: Agency CMS ↔ Website

- **Version:** 1.2 · **Stand:** 2026-09-26 · **CMS-Kompatibilität:** `main` ab `fix/preview-referrer` (Nachfolger von `fix/reference-1-1`)
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
| JSON-Schreibformat (CMS-seitig) | `JSON.stringify(data, null, 2)` — die Website darf Dateien **nie** umschreiben; unbekannte Schlüssel immer stehen lassen |
| Nachrichten CMS → Website | `CMS_FIELD_UPDATE`, `CMS_SELECT_MODE` |
| Nachrichten Website → CMS | `CMS_FIELD_SELECT`, `CMS_BRIDGE_READY` (ab Bridge v2) |
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
  "features": { "blog": true }
}
```

| Schlüssel | Pflicht | Regeln |
|---|---|---|
| `sections[].id` | ja (Fallback `section-N` + Warnung) | beliebig, seitenweit eindeutig empfohlen |
| `sections[].title` | ja (Fallback-Kette + Warnung) | Anzeigetext im Editor |
| `sections[].page` | nein | Gruppiert Tabs im Editor (wirksam); ohne Angabe rät der Editor per Heuristik (ID/Titel, sonst Dateiname) |
| `sections[].fields[]` | ja | leere Sektionen werden ausgeblendet + Warnung |
| `fields[].id` | ja | **global eindeutig** — Duplikat bricht den **gesamten** Publish ab (400) |
| `fields[].label` | ja (Fallback `title` → `id`) | Anzeigetext |
| `fields[].type` | ja | einer der 9 Typen (Abschnitt 4); unbekannt → `text` + Warnung |
| `fields[].file` | ja | nur `src/content/site.json` oder `src/content/pages/*.json`, sonst 400 |
| `fields[].path` | ja | Dot-Path, `items[0].x` ≡ `items.0.x`; verboten: `__proto__`/`constructor`/`prototype`, leere Segmente, nicht-numerische Klammern |
| `fields[].placeholder` | nein | Beispieltext |
| `fields[].maxLength` | nein | ganze Zahl 1–10000; Überlänge blockiert Publish dieser Datei |
| `fields[].aspectRatio` | nein | nur Hinweis im Editor, und nur bei exakt `"16:9"` (andere Werte werden ignoriert) |
| `features.blog` | nein | `true` oder `{ "enabled": true }` zeigt den Blog-Tab |

**Feld-IDs:** Nur `[a-z0-9._-]` verwenden (klein, ohne Leerzeichen). IDs mit Leerzeichen, Quotes oder `<>"'` werden vom CMS **stillschweigend verworfen** (kein Fehler, kein Hinweis) — der Klick aus der Vorschau landet dann im Leeren. IDs außerdem global eindeutig halten (Duplikat bricht den gesamten Publish ab).

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

`src/content/site.json` (`banner` exakt so — flach heißt hier nur: die Banner-Pfade `banner.enabled`, `banner.variant`, `banner.text` liegen direkt unter `banner`; der Rest der Datei darf beliebig strukturiert sein):

```json
{
  "firma": { "name": "Malerbetrieb Schmidt", "telefon": "+49 171 123456" },
  "banner": { "enabled": false, "variant": "info", "text": "" }
}
```

`src/content/pages/home.json` (beliebig tief; **Listen sind fest** — kein Wachstum, kein Kürzen per Entwurf; bestehende Einträge wie normale Felder änderbar, neue legt die Agentur im Repo an):

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

Regeln: `slug` aus Titel (klein, ä→ae/ö→oe/ü→ue/ß→ss, nur `[a-z0-9-]`, max. 80 Zeichen). `date` ist **optional** (leer = heute). `coverImage` max. 2000 Zeichen, nur http(s) oder interner `/`-Pfad. `coverImageAlt` leer → Titel gilt. `draft` wird tolerant gelesen (fehlend = nicht öffentlich). **Website-Pflicht:** Content-Dateien nie umformatieren, nie Schlüssel löschen, fremde Schlüssel stehen lassen.

## 6. DOM-Marker

Jede Sektion trägt die Sektions-ID, jedes editierbare Element die Feld-ID aus dem Manifest. Mehrfachvorkommen derselben Feld-ID sind erlaubt (alle werden aktualisiert). Verhalten pro Tag: `IMG` → `src` neu + `srcset` entfernen; `SOURCE` → `srcset` neu; alles andere → `textContent` neu.

```astro
---
// Regel: data-cms-field sitzt IMMER am innersten editierbaren Element.
// Kein Marker auf einem Wrapper, der noch einen anderen Marker enthält –
// die Bridge setzt textContent und würde innere Marker dabei löschen.
import { getEntry } from "astro:content";
const home = await getEntry("pages", "home");
---
<section data-cms-section="hero">
  <h1 data-cms-field="hero.title">{home.data.hero.title}</h1>
  <img data-cms-field="hero.bild" src={home.data.hero.image} alt="Hero" />
  <a href={`mailto:${site.data.kontakt.mail}`}>
    <span data-cms-field="kontakt.mail">{site.data.kontakt.mail}</span>
  </a>
  <p data-cms-field="kontakt.mailtext">Antwort in 48 Stunden</p>
</section>
```

Hinweis: `data-cms-section` dient der Struktur und ist für künftige Sprünge reserviert — aktuell springt das CMS nur zu `data-cms-field`. Beide Marker trotzdem immer setzen.

## 7. Preview-Protokoll

Vier Nachrichten, zwei Richtungen. **Niemals** `postMessage(…, "*")` — immer konkrete Origins (Agentur trägt CMS-Domain + `http://localhost:3000` für lokal ein).

```html
<script is:inline>
  if (window.self !== window.top) {
    const CMS_ORIGINS = ["https://cms.deine-agentur.de", "http://localhost:3000"];
    let selectMode = true; // true = „Finden", false = „Surfen"
    // Gemerkte CMS-Herkunft aus geprüften CMS-Nachrichten (stärker als
    // document.referrer): Nach Navigation über einen In-Preview-Link ist der
    // Referrer die Website-Seite, der gemerkte Origin bleibt die CMS-Domain.
    let cmsOrigin = null;
    let bridgeBereitGemeldet = false;
    function meldeBridgeBereit() {
      if (bridgeBereitGemeldet || !cmsOrigin) return;
      bridgeBereitGemeldet = true;
      window.parent.postMessage({ type: "CMS_BRIDGE_READY", version: 2 }, cmsOrigin);
    }
    window.addEventListener("message", (event) => {
      if (!CMS_ORIGINS.includes(event.origin)) return;   // 1. Origin
      if (event.source !== window.parent) return;        // 2. Quelle
      cmsOrigin = event.origin; meldeBridgeBereit();
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
      if (cmsOrigin) return cmsOrigin;
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

Nachrichten: `CMS_FIELD_UPDATE { field, value }` (CMS→Seite, sofort beim Tippen), `CMS_SELECT_MODE { enabled }` (CMS→Seite, auch bei jedem Iframe-Neuladen), `CMS_FIELD_SELECT { field }` (Seite→CMS, nur Feld-ID, nie Inhalte), `CMS_BRIDGE_READY { version: 2 }` (Seite→CMS, einmal je geladener Seite nach der ersten geprüften CMS-Nachricht — damit das CMS weiß, dass diese Bridge Klicks auch nach In-Preview-Navigation zustellt). Unbekannte/ungültige Nachrichten werden **still ignoriert** (keine Fehler, kein Fallback).

**Fallen, die still bleiben (gewollt, aber wissen):** Das Antwort-Ziel für `CMS_FIELD_SELECT` ist der **gemerkte Origin aus geprüften CMS-Nachrichten** (`event.origin`, vom Browser garantiert, gegen `CMS_ORIGINS` geprüft) — `document.referrer` dient nur noch als Fallback für die erste Nachricht. Kam noch keine CMS-Nachricht an (direkter Aufruf ohne CMS, strenge Referrer-Policy), sendet das Script **nichts** — Finden-Klicks versanden lautlos. `CMS_ORIGINS` muss **Scheme + Host + Port exakt** enthalten (`https://cms.deine-agentur.de` ≠ `http://…`, Port `:3000` zählt mit), sonst bricht jeweils eine Richtung still. Umgekehrt deaktiviert der Editor bei ungültiger Preview-URL (kein https, Tippfehler) Vorschau **und** Empfang kommentarlos — das ist Absicht (Sicherheit), kein Bug. Brücken ohne `CMS_BRIDGE_READY` (vor v1.2) verlieren Finden-Klicks nach In-Preview-Navigation weiterhin still — das CMS warnt dann per Hinweis.

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
  ((f.date ?? "") === "" || (/^\d{4}-\d{2}-\d{2}$/.test(f.date) && !Number.isNaN(Date.parse(f.date)))) &&
  (f.coverImage ?? "").length <= 2000 &&
  (f.excerpt ?? "").length <= 500 && (f.coverImageAlt ?? "").length <= 200 &&
  (f.draft === undefined || typeof f.draft === "boolean") && BLOG_RE.test(`src/content/blog/${f.slug}.md`);
```

Content: Pfade ≤ 20 Segmente / 500 Zeichen / Index ≤ 9999; Dateien ≤ 200 Zeichen Pfadlänge; freie Werte ≤ 20.000 Zeichen. Fehlerverhalten: Publish prüft je Datei — fehlerhafte Dateien bleiben Entwurf (400 je Datei mit Grund), saubere gehen live (`partial: true` möglich).

## 11. Website-Kompatibilitäts-Checkliste

**Ablage:** Diese Datei gehört ins **Root des Website-Repos** (nicht verlinken, sondern als Datei kopieren oder per Template ausrollen) — dort findet sie jeder Website-Agent.

- [ ] Manifest unter `src/content/cms.manifest.json`, ≥ 1 Sektion mit Feldern, IDs global eindeutig, nur `[a-z0-9._-]` (klein, ohne Leerzeichen)
- [ ] Alle `file`-Ziele erlaubt, alle `path`-Pfade existieren in den Dateien
- [ ] Alle Typen aus Abschnitt 4, Zahlen/Booleans als echte JSON-Typen in den Dateien
- [ ] `site.json` mit gültigem `banner`-Objekt (Abschnitt 8)
- [ ] Jede Sektion `data-cms-section`, jedes editierbare Element `data-cms-field` (exakte IDs, Marker immer am innersten Element, nie verschachtelt)
- [ ] Brücken-Script aus Abschnitt 7 verbatim mit echten `CMS_ORIGINS` (Scheme + Host + Port exakt), nur im Iframe aktiv
- [ ] Kein `postMessage("*")`, `CSS.escape` verwendet, Klick nur mit gültigem Ziel-Origin (gemerkter CMS-Origin, Fallback `document.referrer`), `CMS_BRIDGE_READY` (v2) wird gesendet
- [ ] Vorschau-URL ist `https://…` (sonst bleibt die Editor-Vorschau stumm)
- [ ] Blog: Frontmatter-Schlüssel + Grenzen, Slugs `[a-z0-9-]` ≤ 80, `draft`-Flag beachtet
- [ ] Branch `main` wird von Vercel als Produktion deployed; Content-Dateien werden nie umgeschrieben/gelöscht
- [ ] Listen: **keine darf wachsen oder schrumpfen**; bestehende Einträge wie normale Felder pflegen, neue legt die Agentur im Repo an

## 12. Häufige Fehler

| Fehler | Konsequenz | Richtig |
|---|---|---|
| `postMessage(…, "*")` / fehlender Origin-Check | fremde Seiten schreiben Vorschau um | Abschnitt 7 verbatim |
| Feld-ID-Typo im Template | Feld nicht klickbar/aktualisierbar | IDs aus Manifest kopieren, nie tippen |
| `type: "emial"` im Manifest | wird still `text` (+ Warnung) | Typen aus Abschnitt 4 |
| Zahl als `"19,90"` in JSON-Datei | Publish blockiert Datei | echte Zahl `19.9` schreiben |
| Liste per Entwurf verlängert/gekürzt | Publish blockiert Datei („feste Liste") | Einträge im Website-Repo anlegen (Agentur) |
| Banner-Stil `"party"` erfunden | Publish blockiert `site.json` | nur `vacation`/`emergency`/`info` |
| Content-Datei neu formatiert/gelöscht | Diff/History unbrauchbar, Publish-Fehler | Dateien nur lesen, nie schreiben |
| `data-cms-field` auf Wrapper statt Ziel | falsches Element blinkt / innere Marker werden gelöscht | Marker ans innerste editierbare Element, nie verschachteln |

## 13. Änderungshistorie

- **1.0 (2026-09-26):** Ersterstellung aus CMS-`main` (Merge-PR #1 + Verlauf-Hotfix). Abgedeckt: Manifest, 9 Feldtypen, Content-Dateien, Marker, sicheres Preview-Protokoll, Banner, Bilder, Blog-Validierung, Listenmodelle.
- **1.2 (2026-09-26):** Bridge v2 gegen die `document.referrer`-Falle: Antwort-Ziel für `CMS_FIELD_SELECT` ist der gemerkte Origin aus geprüften CMS-Nachrichten (Referrer nur Fallback), neue Nachricht `CMS_BRIDGE_READY { version: 2 }` je geladener Seite; CMS warnt nur noch bei Brücken ohne READY.
- **1.1 (2026-09-26):** `page` funktioniert jetzt wirklich; `listenmodelle` und FAQ-Feature komplett entfernt (alle Listen fest, Einträge normal änderbar); DOM-Marker-Beispiel korrigiert; Feld-ID-/Preview-/`aspectRatio`-Hinweise ergänzt; Blog-Validierung präzisiert (`date` optional, `coverImage`-Regel, `draft` tolerant); Sicherheitshinweise zu `document.referrer` und `CMS_ORIGINS` ergänzt; Ablageort festgelegt (Root des Website-Repos).
- TODOs: Alt-Texte für Content-Bilder (CMS-Konzept fehlt); `data-cms-section`-Auswertung (reserviert, CMS springt nur zu Feldern).
