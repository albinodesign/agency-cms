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
- Hinweis (durch 1c überholt): Die 1b-Aussagen „Listen-Ergänzung am Ende“ und
  „Vorabprüfung gegen Live-Dateien“ galten nur vorläufig – seit 1c gilt:
  Ergänzungen nur modellvollständig/typgerecht, Prüfung gegen den Kandidaten
  mit effektivem Manifest (Details unten).

---

## Schritt 1c – Einheitliche Zielregeln, Kandidaten-Prüfung, Chat-Anbindung, Alias-Aufräumen, große Bestände (Branch: `reparatur-1-content-guard`)

### Einheitliche Regeln für dasselbe Inhaltsziel (behoben)
Ein Manifestfeld und ein freier Alias desselben normalisierten Ziels nutzen
jetzt dieselbe Auflösung (`resolveTargetType`): Der Alias erbt Typ, maxLength
und Label des deklarierten Felds; Banner-Pfade folgen den Banner-Regeln;
sonst gilt Text. Umwandlung nur noch zieltypabhängig (`convertStoredValue`):
„true“ bleibt in Textfeldern Text, wird in Boolean-Feldern Boolean; „19,90“
wird auf Zahlfeldern (auch per Alias) zur Zahl 19.9. Banner-Werte gelten auf
vorhandenen Pfaden genauso wie beim Anlegen (z. B. `variant="party"` und
Überlängen werden überall abgelehnt). Belegt durch U1–U10 und R-U1–R-U4.

### Kandidat wird vor dem ersten Write vollständig geprüft (behoben)
Der Publish baut zuerst den gesamten Kandidaten (Live + Voll-Datei-Entwürfe +
alle Feldänderungen) und prüft erst diesen: effektives Manifest (ein
Manifest-Entwurf im Satz ersetzt die Live-Definition) streng gegen den
Kandidaten – so fallen `{}`-Voll-Dateien (Ziele entfallen) und
Manifest-Entwürfe mit `package.json`-Ziel auf. Werte je deklariertem Typ
einheitlich für Feld-, Alias- und Voll-Datei-Inhalte. Banner-Dreifaltigkeit
(an braucht Stil + Text). Listen-Ergänzungen brauchen alle Pflichtschlüssel
der Geschwister in typgerechter Form (Geschwistertyp-Übernahme, z. B. rating
als Zahl), keine fremden Schlüssel, keine Löcher, keine Tiefe; leere oder
uneinheitliche Listen lehnen Ergänzungen ehrlich ab (keine globale
Demo-Regel, keine MODEL-Hardcodes – das Demo-Modell steckt nur in der
Test-Fixture). Zusammengehörige Manifest- und Inhaltsänderungen im selben
Satz bleiben möglich. Belegt durch R-R1–R-R4 mit der unverfälschten
testimonials-Fixture aus der Demo-Website.

### Chat und Publish abgestimmt (behoben)
Die KI-Werkzeuge leben jetzt in `src/lib/ai-tools.ts` (`buildAiTools`, echte
Funktionen, lokale Adapter testbar). `schreibeInhalt` nutzt die gemeinsame
Prüfung gegen Live-Stand plus gespeicherte Entwürfe (zusammengehörige
Änderungen): Unzulässiges (z. B. `hero.neu`) wird mit Fehler abgelehnt statt
still gespeichert; unvollständige Ergänzungen werden mit ehrlichem `hinweis`
(fehlende Schlüssel) gespeichert, aber erst vollständig veröffentlichbar.
`maxLength` steht jetzt in `AiFieldContext` und wird im Werkzeug geprüft.
`leseDatei` seitenweise mit `gekuerzt`/`weiterAb`-Kennzeichnung, neu
`leseFeld` für einzelne volle Feldwerte, `listeFelder` weiter ungekürzt (500
IDs belegt). Der Prompt erklärt Kürzung + Nachladeweg. Belegt durch P-P1/P-P2.

### Alias-Abschluss (behoben)
Gleiche Werte (Manifest + Alias) veröffentlichen erfolgreich, und der erfüllte
Alias wird danach aufgeräumt – aber nur nach Wert-Rückprüfung (kein
Pauschal-Löschen). Verschiedene Werte bleiben ein 400-Konflikt. Belegt durch
R-R5 (und S8 aus 1b). Grenze: parallele Veröffentlichungen bleiben ein
eigenes Thema.

### Tests 1c und Ergebnisse (lokal ausgeführt)
- `npm run lint` → sauber (0 Fehler, 0 Warnungen).
- `npm run build` → erfolgreich (alle 13 Seiten).
- `npm run test` → 32/32 (1) + 40/40 (1b) + 40/40 (1c: 13 Regel-, 17
  Routen-, 10 Werkzeug-Assertions). Exit-Code-Weitergabe per Absicht-Fehler
  bewiesen (1 → Fehler, 0 → sauber).

---

## Schritt 1d – Abschlussreparatur: gemeinsame Inhaltsprüfung, strikte Endtypen, feste Listen, Chat-Parität (Branch: `reparatur-1-content-guard`)

### Fehlender Nachweis (exakt benannt)
Das beauftragte Prüfmaterial `CMS-Reparatur-1c-Pruefung.zip` (Bericht,
ausführbare Gegenprüfungen, Ordner `demo-original-fixture` mit den
unveränderten Website-Regeln) lag im Arbeitsstand nicht vor – gesucht in
`/Users/albinsalihu/Documents/agency-cms/` und `/Users/albinsalihu/Documents/`.
Bearbeitet wurden alle im Auftragstext beschriebenen Fälle; die konkrete
Demo-Schema-Regel (testimonials.items: genau drei Einträge, feste
Bewertungssektion) wurde aus der Auftragsbeschreibung übernommen und als
feste Liste ohne Wachstumsmodell umgesetzt. Ein Abgleich gegen die
Original-Schemadatei war mangels Fixture nicht möglich.

### Gemeinsame Logik für Chat und Publish (behoben)
`src/lib/content-guard.ts` enthält jetzt die gemeinsam verwendete
Zielauflösung (`resolveEditType`: Manifestfeld, Banner-Regel,
Listenmodell oder freier Text), Typumwandlung (`convertEditValue`:
nur Zahl-/Boolean-Felder werden umgewandelt, "true" in Textfeldern bleibt
Text), Kandidatenbildung (umgewandelte Werte) und Inhaltsprüfung
(`validateFinalJsonValue`, `getBannerProblems`, `validateListStructures`,
`missingAppendKeys`, `findListModel`). Publish-Route und `buildAiTools`
rufen dieselben Funktionen auf – für dasselbe Ziel gelten dieselben Regeln
über Manifest-ID, freien Alias, vollständigen Datei-Entwurf und
Kombinationen; jeder Satz wird vor dem ersten GitHub-Write gemeinsam am
fertigen Kandidaten geprüft (Fail-Closed, deutsche Meldung, null Writes,
Entwürfe bleiben). Zulässige unvollständige Arbeitsentwürfe (nur
dynamische Listen, mit Fehlend-Liste) und veröffentlichungsfähige Inhalte
nutzen dieselben Regeln.

### Modellannahmen ersetzt (behoben)
`inferRequiredKeys` und Nachbareinträge begründen keine Entscheidung mehr
(Funktion nur noch Diagnose, Hinweis im Code). Verbindlich sind nur
ausdrückliche Modelle in `DYNAMIC_LIST_MODELS` – derzeit genau ein Fall:
`src/content/pages/faq.json`, Liste `items`, Elemente mit `frage` + `antwort`
als Text. Alle anderen Listen sind fest und dürfen weder wachsen noch
schrumpfen. Es gibt keine globale Drei-Einträge-Regel, kein
Feldanzahl-Limit und keine gelockerten Website-Regeln; Website-Skripte
werden nicht ausgeführt; Kundendaten schwächen ihre Regeln nicht ab. Das
Editor-Manifest erweitert keine Listen (ein Manifest-Entwurf kann Slots
nicht freischalten); die Feldliste selbst ist von der Strukturprüfung
ausgenommen. Korrektur 1d im 1c-Test: R-R3 erwartet für die 4. Bewertung
(auch vollständig) 400 "feste Liste" statt 200.

### Vollständige Dateien ohne Sonderweg (behoben)
Strikte Endtypen im Kandidaten (`validateFinalJsonValue`): Zahlen sind echte
endliche Zahlen, Booleans echte Booleans, Text bleibt Text, null/leer ist
hier kein Wert. Der Banner-Endstand (`getBannerProblems`) gilt immer bei
vorhandenem Banner – auch ausgeschaltet (party-Stil und Überlänge werden
abgewiesen). Belegt: quote-only-Bewertung, hero.title=null, Zahl als "42",
ausgeschalteter Banner mit party/161 Zeichen (je 400 ohne Write, Entwürfe
bleiben), gültige Gegenstücke (200, echte Typen), Voll-Datei+Feld-Kombi.

### Chat-Ablauf mit derselben Logik (behoben)
Feld-ID `banner.variant="party"` wird im Chat abgelehnt (Banner-Regel gilt
auch per Feld-ID und auf deklarierten Pfaden); FAQ-Antwort nach gespeicherter
Frage ist eine Fortsetzung (Bestand inkl. Entwürfe, Eintragsobjekt-Prüfung –
vorhandenes gilt nicht als fehlend), inkl. Korrektur des begonnenen
Entwurfs; Banner-an als String "true" meldet trotzdem fehlenden Stil/Text
(umgewandelter Kandidat plus tolerante Hinweisprüfung). Feste Listen lehnt
der Chat schon beim ersten Schritt ab (nichts gespeichert). Antworten
enthalten zusätzlich `veroeffentlichbar` (Best-Effort-Hinweis; maßgeblich
bleibt Publish). Chat-Entwürfe wurden gespiegelt gemeinsam veröffentlicht
(C-F2b, C-B2c). Die drei Website-Prompts und Werkzeugbeschreibungen sind
unverändert.

### Tests 1d und Ergebnisse (lokal ausgeführt)
- `npm run lint` → sauber (0 Fehler, 0 Warnungen).
- `npm run build` → erfolgreich (alle 13 Seiten).
- `npm run test` → 32/32 (1) + 40/40 (1b) + 40/40 (1c mit korrigiertem R-R3)
  + 77/77 (1d: Baustein-, Publish-, Chat- und E-Restlücken-Assertions). Jede
  fehlgeschlagene Assertion erzeugt Fehler-Exit-Code (ok-Muster).
- Vor der Reparatur reproduziert: 15/40 bestanden (25 Fehler: alle vier
  Voll-Datei-Umgehungen, 4. Bewertung angenommen, FAQ-Antwort abgewiesen,
  Banner-party per Feld-ID angenommen, feste Liste im Chat gespeichert,
  Banner-Hinweis bei "true" unterschlagen); nach 29f6da5 zusätzlich 10
  E-Fehler (Modell-Lücke ohne Wachstum, Typwechsel außerhalb Feldliste,
  Strukturvarianten, Status nach Korrektur).

### Nachtrag nach 29f6da5: zwei unabhängig nachgewiesene Restlücken (behoben)
1. **Bestehende Inhalte vollständig:** Bekannte Modelle gelten für ALLE
   endgültigen Elemente (`validateNewListElement` je Element, auch ohne
   Wachstum – volle FAQ ohne `antwort` → 400). Feste Listenelemente behalten
   exakt ihre Form (`compareFixedShape`: fremde/fehlende Schlüssel und
   Typwechsel wie Zahl→Text abgewiesen, inkl. Objekt↔Wert-Tausch).
   Typtreue außerhalb der Feldliste (`validateScalarTypePreservation` für den
   ganzen Kandidaten). Abgedeckte Pfade (Manifestfeld, Banner-Bereich,
   Modellliste via `makeCoveragePredicate`) sind ausgenommen – für sie gelten
   ihre eigenen Kandidaten-Regeln, sodass legitime Korrekturen (z. B.
   deklariertes Zahlfeld) nicht blockieren. Gültige normale Bearbeitungen
   (gleichartige Wertänderungen, auch außerhalb der Feldliste) bleiben
   möglich. Dokumentierte Grenzen: neue Skalarschlüssel in reinen Objekten,
   Kürzen dynamischer Listen und Entfall nicht deklarierter Schlüssel bleiben
   zulässig bzw. Entwurf.
2. **Entwurfsstatus nach jeder Änderung:** `statusAfterStore` bestimmt den
   Status aus dem zusammengesetzten Stand (Live + alle Entwürfe) in beiden
   Chat-Zweigen (Feld-ID und datei+pfad): fehlende Modellschlüssel,
   Struktur-/Typabweichungen und Banner-Lücken ergeben `hinweis` +
   `veroeffentlichbar=false` – auch bei Korrekturen (Frage korrigiert ohne
   Antwort, Banner-Einschalten ohne Text, Typwechsel Zahl→Text). Ein
   fehlender Hinweis beweist keine Veröffentlichungsfähigkeit; maßgeblich
   bleibt Publish. Belegt: E-S1–E-S6 (+E-S2b), E-C1–E-C4 mit Endzustand
   (Repo-Inhalt, Commits, Entwurfsmengen), Erfolgsgegenstücke und
   Chat→Publish-Spiegel (E-C4b).

### Tatsächlich unterstützte Modellregeln und verbleibende Einschränkungen
- Unterstützt: Dateisperre, sichere Pfade, Manifest-Ziele, deklarierte
  Typen/Längen (Aliase erben), Banner-Modell (Enum, 160 Zeichen,
  Dreifaltigkeit, immer gültig), genau ein dynamisches Listenmodell (FAQ),
  Alias-Aufräumen nach Wert-Rückprüfung, 500+-Felder-Bestände mit Nachladen.
- Einschränkungen (ehrlich): Listenwachstum nur für ausdrücklich
  modellierte Listen (Erweiterung nur im Code durch die Agentur); zusätzliche
  Skalar-Schlüssel in Voll-Dateien ohne Modell und gleichlange
  Formänderungen nicht deklarierter Elemente sind außer Reichweite (Manifest
  ist nicht das volle Datenmodell); Kürzen dynamischer Listen zulässig (kein
  Mindestmaß modelliert); leere Zahl-/Boolean-Felder sind erst nach Befüllen
  veröffentlichbar; `veroeffentlichbar` ist eine Chat-Einschätzung.
- Weiter offen (separate Pakete, wie bisher): RLS/Policies, parallele
  Publisher, atomare Multi-Datei-Releases nach dem ersten Commit,
  Token-Trennung, KI-Kostenlimits. Keine pauschale Produktionsfreigabe.
