# REPARATUR-STATUS

## Schritt 1 – Erlaubte Inhaltsdateien und JSON-Pfade absichern (Branch: `reparatur-1-content-guard`)

### Was war das Problem (einfach erklärt)
Der Veröffentlichen-Knopf hat dem Manifest (der Feldliste aus dem Website-Repo)
und freien Entwürfen fast blind vertraut: Jedes `.json`-Ziel unter `src/content/`
war erlaubt, Pfade wurden nicht auf Tricks (`__proto__`, `..`, verwaiste Ziele)
geprüft, und ein kaputtes Ziel konnte still übersprungen werden. Die Pfadfunktionen
haben fehlende Strukturen beliebig neu erzeugt und Arrays ungefragt ersetzt.

### Was wurde geändert
- **Neu: `src/lib/content-guard.ts`** – gemeinsame serverseitige Prüfung für
  normale JSON-Inhaltsziele. Erlaubt sind nur `src/content/site.json` und
  JSON-Dateien direkt unter `src/content/pages/` (strenge Dateinamen, kein `..`,
  keine absoluten Pfade). Paket-, Config- und Manifestdateien sind keine
  Feldziele. Enthält: Dateisperre, Pfad-Sicherheitscheck, Duplikatcheck
  (schreibweisen-normiert: `items[0].x` == `items.0.x`), Roh-Manifestprüfung
  (eindeutige IDs, unterstützte Typen inkl. `boolean`, sinnvolle `maxLength`,
  tatsächliche Pfad-Existenz in der geladenen Datei), Free-Draft-Parser und
  Voll-Datei-Check (Objekt, kein Array, keine `__proto__`-Schlüssel).
- **`src/lib/json-path.ts`** – neu geschrieben und gehärtet: `parsePathSafe`
  lehnt `__proto__`/`constructor`/`prototype`, leere Abschnitte,
  nicht-numerische Klammern und zu tiefe/zu lange Pfade ab. `getByPath` liest
  nur eigene, vorhandene Eigenschaften (Array nur in den Grenzen). `setByPath`
  erzeugt fehlende Zwischenebenen nur als reine Objekte (niemals Arrays/Listen);
  Listen müssen existieren, gültig sind vorhandene Indizes und das exakte
  Anhängen am Ende. Fehler werfen statt still falsch zu schreiben.
- **`src/lib/github.ts`** – neu: `getManifestRaw` (ein Abruf: Rohtext +
  geparste Definition für die Server-Prüfung).
- **`src/app/api/publish/route.ts`** – nutzt die Server-Definition aus
  `getManifestRaw`; prüft Roh-Manifest, freie Entwürfe (Dateisperre + Pfad +
  kein Doppel mit Feldzielen), Werte gegen Server-Typen, volle JSON-Entwürfe
  gegen Dateisperre + Objekt-Regel. **Alle** Fehler werden vor dem ersten
  Repository-Schreibvorgang gesammelt und als eine verständliche 400-Meldung
  zurückgegeben; es wird dann nichts geschrieben und alle Entwürfe bleiben
  erhalten. Erfolgsantworten ohne Arbeit sind ehrlich formuliert.
- **`src/app/api/ai/chat/route.ts`** – Werkzeug `schreibeInhalt` (freie Pfade)
  nutzt dieselbe Dateisperre + Pfadprüfung; Feld-Typ wird erst nach Prüfung
  genutzt (vorher wurde immer als `text` geprüft – mitkorrigiert).
- **`src/lib/ai.ts`** – System-Prompt ohne Feldanzahl-Limit (nur noch
  Zeichen-Budget, kein Abschneiden nach 100 Feldern).
- **Tests: `scripts/reparatur1-check.mjs`** (+ `npm run test:reparatur1`) –
  kompiliert die Prüf-Libs mit dem Projekt-TypeScript und führt 32 lokale
  Abnahme-Assertions aus (kein Netz, keine Produktion).
- **Doku:** `AGENTS.md` (Publish-Ablauf, Feldtypen/Ziele) aktualisiert.

### Tests und Ergebnisse (lokal ausgeführt)
- `npm run lint` → sauber (0 Fehler, 0 Warnungen).
- `npm run build` → erfolgreich (alle 13 Seiten).
- `npm run test:reparatur1` → 32/32 bestanden, u. a.: gültiger site.json-Text
  und Array-Feld änderbar; 200-Felder-Manifest vollständig ok; `package.json`
  und Manifest als Ziel abgelehnt; freie Entwürfe umgehen die Sperre nicht;
  Traversal/Prototypsegmente/fehlende Pfade/ungültige Indizes abgelehnt;
  Schreibweisen-Duplikate erkannt; Satz mit unerlaubtem Ziel wird als Ganzes
  abgelehnt; volle Entwürfe (Array/`__proto__`/kaputt) abgelehnt.

### Dokumentierte Grenze (bewusst nicht umgebaut)
- Vollständige Datei-Entwürfe für **Code** (`src/components|pages|layouts|styles`)
  und die **Feldliste** behalten ihre eigenen Regeln (Whitelist, Geheimnis-Scan,
  Brücken-Check, Gültigkeits-Check) – siehe Kommentar in `content-guard.ts`.
- Das **Blog-Format** (Markdown) läuft getrennt über `/api/blog` und ist von
  diesen Regeln unberührt.
- Der KI-Chat speichert Feld-Entwürfe anhand der Client-Feldliste; die
  **entscheidende Prüfung passiert im Publish gegen das Server-Manifest**.
- Freie Entwürfe dürfen fehlende reine Objekt-Ebenen anlegen (z. B. neues
  Banner-Objekt) und Listen exakt am Ende erweitern – Arrays im Bestand werden
  nie ersetzt, Löcher nie erzeugt.

### OFFEN (nicht bearbeitet, nicht als erledigt bezeichnen)
- RLS-Berechtigungen und Policies (Datenbank) – nicht angefasst.
- Speicherrennen/Parallelität beim Veröffentlichen (zwei Publisher gleichzeitig).
- Atomare Multi-Datei-Releases (weiterhin ein Commit pro Datei, kein
  Single-Tree-Commit) – Fail-Closed greift vor dem ersten Commit, aber nach
  Commit 1 von N gibt es kein Transaktions-Rollback.
- Pro-Kunde-Geheimnisse/Token-Trennung (ein GitHub-Token für alle Repos).
- Rate-Limits/Kosten-Leitplanken für den KI-Chat.

---

## Schritt 1b – Nachprüfung: enge Erstellungsregeln, echter Publish-Test, volle Feldverfügbarkeit (Branch: `reparatur-1-content-guard`)

### Befund zu den Ausnahmen aus Schritt 1 (eingeengt)
Der Bericht aus Schritt 1 erlaubte freien Entwürfen allgemein, fehlende
Objekt-Ebenen anzulegen und Listen zu erweitern. Das war zu allgemein: Ein
freier Pfadstring hätte beliebige neue Schlüssel erzeugen können. Eingegrenzt
auf zwei ausdrücklich freigegebene, serverseitig typ- und strukturvalidierte
Operationen (`classifyFreeTarget` in `src/lib/content-guard.ts`):

- **Banner-Modell** (`banner.enabled|variant|text` in `src/content/site.json`):
  darf den `banner`-Behälter anlegen; Werte werden typgeprüft (an/aus,
  Stil-Enum `vacation|emergency|info`, Text max. 160 Zeichen). Besitzer ist der
  CMS-Banner-Schalter, die Website rendert `site.banner`. Aufrufstellen:
  Banner-Schalter im Editor, Publish-Vorabprüfung, KI-Werkzeug `schreibeInhalt`.
- **Listen-Ergänzung**: Anhängen exakt am Ende einer bestehenden Liste –
  entweder als einzelner Wert oder als neues Element mit genau einem Feld
  (z. B. `items[3].frage` bei Länge 3 für eine neue FAQ-Frage). Löcher und
  tiefere Strukturen werden abgelehnt. Aufrufstellen: wie oben.
- Alles andere Neue (beliebige Schlüssel wie `hero.neu`, tiefe Ketten,
  unbekannte Banner-Felder, falsche Stile, Überlängen) wird abgelehnt.
- Modell-Passung: Nach dem Zusammenbauen prüft der Publish eine Endkontrolle –
  jeder Entwurfspfad muss im fertigen Datei-Stand auflösbar sein. So ist
  belegt, dass neue Inhalte zum Content-Modell passen (nicht nur valides JSON).
  Manifestfeld-Pfade, die erst durch eine akzeptierte Erstellung im selben Satz
  entstehen (z. B. Banner-Init auf frischer `site.json`), gelten als abgedeckt.
- Doppel-Schreibweisen (`items[0].x` vs. `items.0.x`) zwischen freien Entwürfen
  sowie gegen Manifest-Entwürfe desselben Satzes werden als Konflikt mit 400
  abgelehnt (gleicher Wert = überflüssig und entfällt stilllos zugunsten des
  Manifest-Entwurfs).

### Befund zum echten Veröffentlichungsweg (mit Testadaptern belegt)
`scripts/reparatur1b-publish-check.mjs` ruft den tatsächlichen Publish-Handler
(kompilierte Route) mit gefakten GitHub-/Supabase-Adaptern auf (kein Netz,
keine Produktion). Belegt (Szenarien S1–S9): Gemischte Sätze (gültig +
unerlaubt) lösen **keinen** Repository-Schreibvorgang aus und löschen **keine**
Entwürfe. Gültige Manifestfeld-, Frei- und Banner-Erstellungs-Sätze schreiben
korrekt (inkl. Boolean/Zahl-Typen). Manipulierte Manifeste, volle Dateien
außerhalb der Sperre, `__proto__`-Dateien, Zielkonflikte und
Schreibweisen-Duplikate werden mit 400 ohne Write abgelehnt.
Ausdrücklich unterschieden: **Vorabprüfung** (dieses Paket: verhindert alle
Writes bei ungültigen Eingaben) vs. **atomare Veröffentlichung** (späteres
Paket: weiterhin ein Commit pro Datei, kein Transaktions-Rollback nach dem
ersten Commit – nicht als gelöst bezeichnen).

### Befund zur vollständigen Feldverfügbarkeit
- **Editor:** rendert alle Manifestfelder ohne Anzahl-Schnitt (nur
  Anzeige-Kürzungen einzelner langer Werte im Diff, keine Feld-Unterschlagung).
- **Speicherung:** `drafts` pro `(site_id, field_id)` ohne Limit.
- **KI:** arbeitet jetzt gegen die **Server-Feldliste** (ein Manifest-Abruf pro
  Nachricht in `src/app/api/ai/chat/route.ts`) statt der Client-Liste – damit
  sind Prompt-Kontext, `listeFelder` und `schreibeInhalt` garantiert
  vollständig und identisch zur Publish-Prüfung. Das Zeichen-Budget im Prompt
  (12.000) schneidet nie dauerhaft ab: Die KI erfährt ausdrücklich, dass die
  Liste unvollständig sein kann, und lädt den Rest serverseitig über
  `listeFelder`/`leseDatei`/`projektUebersicht` nach. Budgets wurden nicht
  erhöht, sondern durch Nachladewege ergänzt.

### Tests 1b und Ergebnisse (lokal ausgeführt)
- `npm run lint` → sauber (0 Fehler, 0 Warnungen).
- `npm run build` → erfolgreich (alle 13 Seiten).
- `npm run test` → `test:reparatur1`: 32/32 bestanden; `test:reparatur1b`:
  40/40 bestanden (12 Regel-Tests + 28 Publish-Szenario-Assertions S1–S9).
