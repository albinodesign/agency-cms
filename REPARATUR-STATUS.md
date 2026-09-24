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
