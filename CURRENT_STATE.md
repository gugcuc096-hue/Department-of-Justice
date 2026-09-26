# CURRENT_STATE – San Andreas Justice Command System

Stand: 2026-09-26 · Phase: **3 (Shared Core) abgeschlossen, Phase 4 (USMS) in Arbeit** – siehe Arbeitsstand

Dieses Dokument ist die Übergabe zwischen Sessions. Wer hier weiterarbeitet, liest zuerst den Abschnitt „Arbeitsstand“.

---

## 1. Arbeitsstand

Stand: 2026-09-25 · Branch `phase-3-core`

| Phase / Schritt | Status | Ergebnis |
|---|---|---|
| 1 – Audit | ✅ | dieses Dokument, `ARCHITECTURE.md` |
| 2 – Architektur, Recht, Plan | ✅ freigegeben | alle Architekturdokumente, Entscheidungen F1–F10 (Abschnitt 6) |
| 3.1 Projektgerüst | ✅ | Express, strikte CSP, Fehlerbehandlung, Tests, Lint, Typecheck |
| 3.2 Datenbank & Migrationen | ✅ | `001_core.sql`, `002_cases.sql`, Append-only-Trigger |
| 3.3 Seeds | ✅ | Organisationsbaum, Ränge laut Prompt, Permissions, Rollen, Levels, Compartments, Case Types, Feature Flags |
| 3.4 Audit Log | ✅ | Hash-Kette, `verify()` |
| 3.5 Authentifizierung | ✅ | Sessions, CSRF, Sperre nach Fehlversuchen, erzwungener Passwortwechsel |
| 3.6 Autorisierung | ✅ | Principal, Scopes, Delegationen, Clearance, Compartments |
| 3.7 Administration Center I | ✅ | API und UI: Benutzer, Mitgliedschaften, Rollen, Permissions, Clearance, Compartments, Organisationen, Ränge, Feature Flags, Delegationen |
| 3.8 SPA-Shell | ✅ | Login, Shell, serverseitige Navigation, Department Switcher, Kontextleiste, Dashboard |
| 3.9 Cases | ✅ | Akten inkl. Office-Sichtbarkeit (F9), Sealing, Links, Übergabe, Testmatrix A1–A18 |
| 3.10 Dokumente & Signaturen | ✅ | Vorlagen (Gerichtsbeschluss, Durchsuchungsbeschluss nach Muster des Auftraggebers, Haftbefehl, Vorladung, Urteil, Schriftsatz, Bericht, Vermerk), unveränderliche Versionen, Freigabe, hash-gebundene Signaturen, Ausfertigung, Uploads, Druckansicht mit Institutionskopf |
| 3.11 Workflow-Engine & Antragsverfahren | ✅ | generische Engine; Anträge Prosecution → District Court (Haftbefehl, Durchsuchung, Vorladung); Richterentscheidung, Beschluss aus Vorlage, Signatur, Ausfertigung; Haftbefehl → USMS: Vollstreckung, Bericht, Rückmeldung, Widerruf |
| 3.12 Evidence & Chain of Custody | ✅ | Registrierung in Akten, zweiseitige Übergaben (Einleitung + Empfangsbestätigung), Ablehnung/Rückzug, Ortswechsel, Herausgabe/Vernichtung, Fotos; Kette append-only und hash-verkettet |
| 3.13 Hearings & Deadlines | ✅ | Termine in Gerichtsakten (planen, verlegen, vertagen, absagen, Teilnehmer, Protokoll aus Vorlage), Raum-/Personenkonflikte ohne Preisgabe geschützter Termine; Fristen mit manueller Fälligkeit, berechnetem „überfällig“, protokollierten Verlängerungen; Wochenkalender, Dashboard |
| 3.14 Messaging, Official Requests, Notifications | ✅ | Direkt-, Akten- und Behördenunterhaltungen; offizielle Anfragen mit Zuweisung/Antwort/Ablehnung; Benachrichtigungen aus allen Abläufen (nur an Berechtigte, beim Anzeigen erneut geprüft, neutral bei geschützten Vorgängen); Erinnerungen an Fristen und Termine; Zähler in der Kopfzeile |
| 3.15 Personen, Unternehmen, globale Suche | ✅ | Personenakte mit einzeln geprüften Beziehungen, Unternehmen, FTS5-Suche über zehn Treffertypen (Treffer und Zahlen nur aus Sichtbarem), Personenauswahl in Beteiligten und Anträgen |
| 3.16 Audit-UI, Reports, Exporte, Dashboard | ✅ | Audit-Ansicht mit Filtern, Verify, CSV-Export (A17); Reports und CSV-Export; Aktenexport; Dashboard-Widgets je Bereich; Autosave-Entwürfe |
| 3.17 Administration Center II | ✅ | Case Types, Dokumenttypen, Vorlagen (versioniert, HTML-Allowlist), Sicherheitsprofile, Compartments, Einstellungen, Workflows lesend; Demo-Seed; Render-Test aller Seiten |
| 4 USMS | ⏭ **als Nächstes** | Operationen, Festnahmen, Gefangenentransport, Court Security, Aufgaben, Bewerbungen, Personal, Dashboard |
| 5–9 | ⏸ | Judiciary, Prosecution, Spezialeinheiten, Cross-Department, Security-Audit |

**Qualität:** `npm run check` → Lint ✅ · Typecheck ✅ · 167 Tests ✅. Die Autorisierungsmatrix ist per Mutationstest abgesichert (CHANGELOG.md).

**Im Browser geprüft (2026-09-25):** Login, erzwungener Passwortwechsel, Benutzer anlegen (Startpasswort einmalig), Rolle zuweisen, Organisations-, Rollen- und Feature-Seiten, Akte anlegen, Beteiligte über Personalsuche, Versiegeln durch Richterin, Existenzschutz für die Erstellerin (404), lückenloser Audit-Trail mit intakter Hash-Kette.

**Bewusst zurückgestellt:** ModernV-Rechtsquellen (alle Funktionen `NOT VERIFIED`), USMS-Ränge (im Prompt nicht vorgegeben, vom Admin zu pflegen), finale Siegel.

**Im Browser geprüft (3.10):** Durchsuchungsbeschluss über den Dialog angelegt, Vorschau nach Muster des Auftraggebers, Signatur mit Hash, Druckansicht mit „Hochachtungsvoll“-Block, PDF-Upload als Anlage, geschützter Download (Sandbox-CSP), Dokumentereignisse in der Akten-Timeline.

**Im Browser geprüft (3.11):** Staatsanwältin stellt Durchsuchungsantrag aus der Akte (mit Zeugenvermerk als Anlage) → Gerichtsverwaltung sieht ihn im Eingang, nimmt an und weist die Richterin zu (Gerichtsakte DC-W-2026-0001) → Richterin genehmigt, Beschluss aus Vorlage vorbefüllt, signiert, ausgefertigt → Haftbefehl W-2026-0001 beim USMS (sieht nur Haftbefehl und Beschluss) → Vollstreckungsbericht → Gericht bestätigt Rückmeldung → vollständige Timeline in der Ausgangsakte.

**Haft- und Durchsuchungsbeschlüsse** entstehen nur noch über das Antragsverfahren (Direktweg gesperrt).

**Im Browser geprüft (3.12):** Deputy registriert Tatbeute in einer USMS-Akte → Übergabe an die Gerichtsverwaltung eingeleitet (Personalsuche) → Gerichtsverwaltung sieht das Beweismittel unter „Awaiting your confirmation“, nicht aber die Akte → Empfang bestätigt → Kette mit FROM/TO/Zeit/Ort/Grund/Bestätigung/Hash. Dabei gefunden und behoben: offene Dialoge blieben beim Seitenwechsel stehen.

**Hinweis Entwicklungsdatenbank:** Rollen werden vom Seed nie überschrieben. Neue Standardrechte (z. B. Beweismittelrechte für Gerichtsverwaltung und Court Clerks) gelten nur für neue Datenbanken – bestehende Rollen passt ein Admin unter „Roles & permissions“ an.

**Im Browser geprüft (3.13):** Richterin plant Haftprüfung in der Gerichtsakte, lädt die Staatsanwältin ein, setzt eine Frist → Wochenagenda und Fristenliste der Richterin, Dashboard der Staatsanwältin zeigt den Termin (ohne Zugang zur Gerichtsakte). Dabei verbessert: „Meine Termine“ umfasst auch Termine der Akten, denen man zugewiesen ist.

**Im Browser geprüft (3.14):** Staatsanwältin schreibt der Deputy (Zähler in der Kopfzeile, Benachrichtigung, Antwort im Verlauf) und stellt aus der Akte eine offizielle Anfrage mit Anlage an den District Court → Gerichtsverwaltung sieht Anfrage und Anlage (nicht die Akte) und antwortet. Dabei behoben: ausgeblendete Zähler blieben als „0“ sichtbar.

**Erinnerungen** laufen serverseitig alle 10 Minuten (Fristen in 24 h, überfällige Fristen, Termine in 24 h) und werden je Frist/Termin nur einmal verschickt.

**Nächster Schritt:** Phase 4 – USMS.

**Browserprüfung 3.15–3.17:** nicht möglich, die Chrome-Erweiterung war nicht verbunden. Ersatzweise rendert `test/http/views.test.js` jede Seite für sieben Benutzertypen mit echten API-Antworten. Eine Sichtprüfung im Browser steht für diese Schritte noch aus.

**Demo-Umgebung:** `SEED_DEMO=1` und `DEMO_PASSWORD=<mind. 12 Zeichen>` in `.env` legt Demo-Benutzer an (`demo.da`, `demo.judge`, `demo.courtadmin`, `demo.marshal`, `demo.deputy`, `demo.sid`, `demo.dcli`, `demo.registrar`, `demo.sja`, `demo.chief` (ohne US-SJA), `demo.auditor` …; vollständige Liste in `src/db/seeds/demo.js`).

**Arbeitsweise (Entscheidung 2026-09-26):** Der Auftraggeber hat alle verbleibenden Schritte ohne Zwischenfreigabe freigegeben. Jeder Schritt wird weiterhin getestet, dokumentiert und einzeln committet.

## 2. Befund des Audits

Der Projektordner `C:\Users\Lne´´\Desktop\usms-branding` enthält **keine Anwendung**, sondern nur:

```text
usms-branding/
├── prompt.txt              Master-Prompt (Anforderungen)
├── prompt.original.txt     ursprüngliche Fassung des Prompts
└── public/branding/        Branding-Paket (16 Dateien, ca. 110 KB)
```

Auf dem Rechner gibt es keine weitere USMS-Anwendung. Geprüft wurden der Desktop und das Benutzerverzeichnis bis Tiefe 4. `pake-scha-server` auf dem Desktop ist ein anderes Projekt (Kanzleiportal).

| Prüfpunkt aus dem Prompt | Befund |
|---|---|
| Framework / Backend | **nicht vorhanden**. Die README setzt Express voraus (`app.use(express.static('public'))`). |
| Frontend | nur Branding-Komponenten (Vanilla JS, kein Build-Schritt) |
| Datenbank / ORM / Migrationen | nicht vorhanden |
| API, Authentifizierung, Autorisierung | nicht vorhanden |
| Benutzer, Rollen, Permissions | nicht vorhanden |
| Routing, Layout, Seiten | nicht vorhanden (nur `preview.html` und zwei Beispieldokumente) |
| USMS-Funktionen, Workflows, Dokumentenverwaltung, Suche, Notifications, Audit | nicht vorhanden |
| Deployment, Umgebungsvariablen, Build, Tests | nicht vorhanden |
| Git | kein Repository |
| Laufzeitumgebung | Node v24.21.0, npm 11.19.0, git 2.55. `node:sqlite` mit FTS5 und Triggern funktioniert (geprüft). |

---

## 3. Inventar des Branding-Pakets

| Datei | Inhalt | Zustand |
|---|---|---|
| `brand.config.js` | Behördenname, Motto, Asset-Pfade, ein Gericht (`court`), 6 Dokumenttypen, Nummernformat `USMS-JJJJ-NNNN`, `rpNotice`. UMD: läuft im Browser und in Node. | funktioniert, aber nur für **eine** Behörde (USMS) |
| `branding.js` | `USMSBrand.html.{seal, lockup, documentHeader, documentFooter}`, `mount()`, `applyFavicon()`. Escaped alle Werte. | funktioniert, sauber |
| `branding.css` | Farben (Navy/Brass), Schriften Public Sans und Merriweather (per Google-Fonts-`@import`), Lockups, Dokumentkopf, A4-Druck | funktioniert |
| `seal.svg/.png`, Favicons | **Platzhalter** (`isPlaceholder: true`) | Mockup |
| `preview.html` | Übersicht aller Einsatzstellen | Demo |
| `examples/report.html`, `examples/warrant.html` | Beispielbericht und Beispiel-Haftbefehl, druckfähig | Demo mit **nicht als DEMO gekennzeichneten** Beispielpersonen |
| `README.md` | Einbindung, Einsatzstellen, PDF-Wege, Nummernvergabe | aktuell |

---

## 4. Einordnung nach Prompt-Vorgabe

**Funktioniert:**
- Siegel, Lockups (login, sidebar, header, compact), Dokumentkopf und -fuß, Favicon, A4-Druck-CSS
- `formatDocNumber()` im Browser und in Node
- Escaping aller Werte in den Branding-Komponenten

**Funktioniert teilweise:**
- Dokumentkopf für gerichtliche Dokumente: Es gibt genau ein fest konfiguriertes Gericht. Mehrere Gerichte (District Court, CoA, Supreme Court, US-SJA, Constitutional Court) und Ausstellerinstitutionen (DA, SA, AG, DCLI, Registry) fehlen.
- Nummernformat: nur ein Präfix (`USMS`). Die Plattform braucht Präfixe pro Institution und Aktentyp.

**Nur Mockup:**
- Siegel und Favicons (Platzhalter)
- Beispieldokumente (statische Demo-Daten)

**Fehlt vollständig:**
- die gesamte Anwendung: Server, Datenbank, Auth, Autorisierung, alle Module aus dem Prompt

**Wiederverwendbar (bleibt erhalten, API-kompatibel):**
- `branding.js` und `branding.css` vollständig
- `brand.config.js`: die bestehenden Top-Level-Felder bleiben, damit `USMSBrand` weiter funktioniert

**Zu refaktorieren (erweitern, nicht ersetzen):**
- `brand.config.js`: neuer Block `institutions` (je Institution Name, Kurzname, Siegel, Nummernpräfix, Unterzeile), Dokumenttypen mit `issuer: '<institution-code>'` statt nur `'court'`. Details in ARCHITECTURE.md, Abschnitt 6.
- `documentHeader()`: Aussteller aus `institutions` statt aus dem Einzelfeld `court`. Der Fallback auf `court` bleibt.
- Beispieldokumente: als `SAMPLE` kennzeichnen (Prompt 8.5)

**Zu ersetzen:** nichts

---

## 5. Technische Schulden und Auffälligkeiten

1. **Google Fonts per `@import`:** Das ist eine externe Abhängigkeit. Die CSP muss `fonts.googleapis.com` und `fonts.gstatic.com` erlauben, und jeder Seitenaufruf überträgt die IP an Google. Empfehlung: Schriften selbst hosten (`public/branding/fonts/`). ADR-011.
2. **Widersprüchliche Gerichtsbezeichnung:** `brand.config.js` nennt „United States District Court for the District of San Andreas“, die Vorlagen im Prompt nennen „District Court of the United States of America“. Entschieden (F4), siehe Abschnitt 6.
3. **Kein Git-Repository:** Prompt 10.6 verlangt Git. Entschieden (F8): Repository wird angelegt.
4. Die README beschreibt einen Express-Server, der noch nicht existiert. Wird mit Phase 3 Realität.

---

## 6. Entscheidungen des Auftraggebers (Checkpoint 2026-09-25)

| Nr. | Thema | Entscheidung |
|---|---|---|
| F1 | Stack | Node + Express + SQLite (`node:sqlite`) + Vanilla-JS-SPA ohne Build (ADR-002) |
| F2 | Hosting | vorerst lokal, Render-fähig bauen |
| F3 | Login | Benutzername und Passwort. Discord eventuell später. |
| F4 | Gerichtsbezeichnung | „District Court / Court of Appeals / Supreme Court **of the United States of America** · **for the District of San Andreas**“ (Name und Unterzeile, zentral in `brand.config.js`) |
| F5 | Sprache | UI Englisch, Dokumentvorlagen Deutsch wie vom Auftraggeber |
| F6 | System Admin | kein automatischer Zugriff auf Akteninhalte |
| F7 | US-SJA | ausdrückliche Zuweisung, Rang nur Voraussetzung |
| F8 | Git | Repository im Projektordner, Commit nach jedem Schritt/jeder Phase |
| F9 | Sichtbarkeit | **Alle Akten im eigenen Office sichtbar** (weniger Bürokratie). Bearbeiten nur für Beteiligte und Supervisor. Nicht office-übergreifend, nicht bei Sealed oder explizit geschützten Profilen. Compartments gelten zusätzlich. |
| F10 | Siegel | Platzhalter pro Institution, bis finale Assets geliefert werden |
