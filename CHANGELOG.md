# CHANGELOG

## 2026-09-26 – Phase 3 (Schritt 3.17)

### Added
- Administration Center II (`/api/admin/config`, Seite „Configuration“): Case Types (anlegen, Mindestprofil, Office-Sichtbarkeit, Bearbeitungsumfang, abschalten, Organisationen und Nummernpräfixe), Dokumenttypen (anlegen, Freigabepflicht, Aussteller, Signatur-Permission), Vorlagen (neue Version statt Überschreiben), Sicherheitsprofile und Compartments (anlegen; Profile danach nur umbenennbar), Systemeinstellungen, Workflow-Definitionen (lesend)
- Vorlagen-HTML wird serverseitig gegen eine Tag-/Attribut-Allowlist geprüft (kein Skript, keine Event-Handler, keine Links, nur `class`)
- Einstellungen mit Schema: Fenster „bald fällig“, Vorlauf der Erinnerungen, Aufbewahrung von Entwürfen, abgeschaltete Benachrichtigungsarten (werden nicht erzeugt); Fristdauern, Gültigkeiten, Gebühren und Aufbewahrungsfristen bleiben bewusst nicht konfigurierbar, bis die Rechtsquellen vorliegen
- Demo-Seed (`SEED_DEMO=1` + `DEMO_PASSWORD`, nie in Production): 20 Demo-Benutzer für alle Rollen, alle als DEMO gekennzeichnet
- Render-Test der Oberfläche ohne Browser: jede Seite wird für sieben Benutzertypen mit echten API-Antworten gerendert; jede Route mindestens einmal, keine Laufzeitfehler, kein „undefined“
- 9 neue Tests (insgesamt 167)

### Changed
- Konstanten für „bald fällig“ (7 Tage), Erinnerungsvorlauf (24 h) und Entwurfsaufbewahrung (30 Tage) sind jetzt Einstellungen mit diesen Standardwerten


## 2026-09-26 – Phase 3 (Schritt 3.16)

### Added
- Audit-Ansicht (`/api/audit`) mit Filtern nach Benutzer, Organisation, Akte, Aktion, Zeitraum, Stufe, IP, Ressource und Ergebnis; Sichtbarkeit nach AUDIT_VIEW-Scope, Clearance und Compartments (A17); das Lesen wird selbst auditiert
- Integritätsprüfung der Hash-Kette für Auditoren (ohne Zahlen über nicht sichtbare Einträge), CSV-Export mit AUDIT_EXPORT (Formeln neutralisiert, auditiert)
- Reports (Akten, Termine, Haftbefehle, Anträge/Workflows, Fristen, Beweismittel, Personal, Audit-Ereignisse) ausschließlich über die Sichtbarkeitsprädikate; CSV-Export mit REPORT_EXPORT; Registrierung weiterer Reports durch Fachmodule
- Aktenexport als JSON (CASE_EXPORT im Scope der Akte, auditiert, nur sichtbare Teile)
- Dashboard-Framework (`/api/dashboard`): Art nach aktivem Bereich (USMS, Prosecution, Judiciary, SID, DCLI, Registry, US-SJA, Constitutional Court), Kennzahlen als Widgets nur aus sichtbaren Daten des aktiven Bereichs; US-SJA ohne bereichsfremde Zahlen
- Migration `009_drafts`: serverseitige Formularentwürfe mit Autosave und Wiederherstellung (neue Akte, neues Dokument, neuer Antrag); Entwürfe verfallen nach 30 Tagen
- Oberfläche: Bereich „Oversight“ (Reports, Audit log), Dashboard-Kacheln aus dem Framework, Export-Schaltfläche in Akten
- 10 neue Tests (insgesamt 158)


## 2026-09-26 – Phase 3 (Schritt 3.15)

### Added
- Migration `008_persons_search`: Personenakte (`persons`, `person_compartments`, `person_links`), Unternehmen (`companies`, `company_people`, `company_links`), betroffene Person an Anträgen und Haftbefehlen, FTS5-Suchindex mit Triggern und Übernahme des Bestands
- Personenakte: Anlegen (PERSON_CREATE), Bearbeiten (PERSON_EDIT), Stufe und Compartments (nur selbst gehaltene); Beziehungen zu Akten, Anträgen, Haftbefehlen werden einzeln gegen die Sichtbarkeit des Gegenstands geprüft
- Akten-Beteiligte aus der Personenakte (Beziehung wird mitgeführt und beim Entfernen beendet); Antrag mit betroffener Person, die in den Haftbefehl übernommen wird
- Unternehmen mit Inhabern, Verantwortlichen und Beschäftigten (COMPANY_VIEW / COMPANY_EDIT)
- Globale Suche (`/api/search`) über Personen, Akten, Dokumente (inkl. Inhalt der aktuellen Version), Unternehmen, Anträge, Haftbefehle, Termine, Beweismittel, offizielle Anfragen und Nachrichten; Treffer und Trefferzahlen in einer Abfrage mit dem Sichtbarkeitsprädikat; Benutzereingaben werden als Präfix-Token formuliert; jede Suche wird auditiert
- Gegenstandsregister (`subjectVisible`, `subjectDescribe`, `searchProviders`) als gemeinsamer Anmeldepunkt für Fachmodule
- Oberfläche: Suchseite (Kopfzeile sucht jetzt global), Personenakte, Unternehmen, Personenauswahl in Beteiligten- und Antragsdialog
- 14 neue Tests (insgesamt 148): u. a. A5 und A8 über die Suche, versiegelte Akten ohne Treffer und ohne Trefferzahl, Compartment-Personen, Beziehungen je Gegenstand


## 2026-09-26 – Phase 3 (Schritt 3.14)

### Added
- Migration `007_communication`: Unterhaltungen, Mitglieder, unveränderliche Nachrichten, Lesestände, offizielle Anfragen mit Anlagen und Verlauf, Benachrichtigungen
- Benachrichtigungen aus allen bisherigen Abläufen (Aktenbeteiligung, Anträge, Haftbefehle, Dokumentprüfung, Beweismittelübergaben, Termine, Fristen, Nachrichten, Anfragen)
- Nur Berechtigte werden benachrichtigt; beim Anzeigen erneut geprüft; neutraler Text bei versiegelten, abgeschotteten oder sehr hoch eingestuften Vorgängen
- Erinnerungsjob (alle 10 Minuten, idempotent): Fristen in 24 h, überfällige Fristen, Termine in 24 h
- Nachrichten: direkt, zu einer Akte (folgt deren Sichtbarkeit), zwischen Organisationen (Schreiben im Namen der Organisation nur mit `MESSAGE_DEPARTMENT`)
- Offizielle Anfragen Institution → Institution: Anlagen werden nur für die Empfängerorganisation freigegeben; Zuweisung, Bearbeitung, Antwort, Ablehnung, Abschluss; Verlauf append-only
- Oberfläche: Zähler für Nachrichten und Benachrichtigungen in der Kopfzeile, Seiten für Benachrichtigungen, Nachrichten, Unterhaltung, Anfragen (Eingang/Ausgang), Tab „Communication“ in Akten
- 12 neue Tests (insgesamt 134), Mutationstests für neutrale Texte und die Empfängerprüfung beim Erstellen

### Fixed
- Ausgeblendete Zähler in der Kopfzeile wurden durch CSS dennoch angezeigt


## 2026-09-26 – Phase 3 (Schritt 3.13)

### Added
- Migration `006_hearings_deadlines`: Termine, Terminbeteiligte, Fristen, Fristverlängerungen (append-only)
- Termine in Gerichtsakten: planen, verlegen, vertagen, absagen (mit Begründung), als abgehalten markieren, Beteiligte (Freigabe geprüft); Sitzungsprotokoll aus neuer Vorlage „Sitzungsprotokoll“
- Eingeladene sehen den Termin, nicht die Gerichtsakte und keine internen Notizen
- Konfliktprüfung Raum/Person; geschützte Termine werden nur anonym als „nicht verfügbar“ gemeldet
- Fristen: Fälligkeit immer manuell (keine erfundenen gesetzlichen Fristen), Zustand offen/bald fällig/überfällig berechnet, Erledigung, Verlängerung mit Begründung, Absage
- Oberfläche: Kalender (Wochenagenda) und eigene Fristen, Termin-Detail, Tab „Schedule“ in Akten, Dashboard mit Terminen und Fristen
- 9 neue Tests (insgesamt 122), Mutationstests für Konflikt-Anonymisierung und „meine Termine“


## 2026-09-26 – Phase 3 (Schritt 3.12)

### Added
- Migration `005_evidence`: Beweismittel, offene Übergaben, Chain of Custody (append-only, je Beweismittel hash-verkettet), Beweismittelfotos
- Zweiseitige Übergabe: Einleitung durch die Gewahrsamsperson, Empfangsbestätigung durch den Empfänger; Ablehnung und Rückzug werden festgehalten; Empfänger müssen berechtigt und für die Stufe freigegeben sein
- Ortswechsel, Herausgabe und Vernichtung (endgültig, `EVIDENCE_DISPOSE`), Fotos/Dateien zum Beweismittel
- Sichtbarkeit über die Akte oder als aktuelle/vorgesehene Gewahrsamsperson (sieht das Beweismittel, nicht die Akte)
- Integritätsprüfung der Kette in der Oberfläche
- Oberfläche: „Evidence custody“ (eigener Gewahrsam, ausstehende Bestätigungen), Detail mit Kette, Beweismittel-Tab in Akten
- Gemeinsamer Dateizugriff: Module melden ihre Dateibezüge an (`ctx.fileAccessors`)
- 11 neue Tests (insgesamt 113), Mutationstest für „nur der Gewahrsamsinhaber übergibt“

### Changed
- Gerichtsverwaltung und Court Clerks: `EVIDENCE_VIEW`, `EVIDENCE_TRANSFER` (Asservatenkammer)

### Fixed
- Offene Dialoge werden beim Seitenwechsel abgebrochen


## 2026-09-25 – Phase 3 (Schritt 3.11)

### Added
- Migration `004_workflows`: Workflow-Definitionen, -Instanzen, -Historie (append-only), Anträge, Antragsanlagen, Haftbefehle
- Generische Workflow-Engine: zulässige Ausgangszustände, Pflichtbegründungen, System- vs. Personenentscheidungen, vollständige Historie
- Antragsverfahren Haftbefehl / Durchsuchungsbeschluss / Vorladung: Entwurf → Einreichung → Annahme mit Richterzuweisung (Gerichtsakte wird eröffnet) → Überarbeitung / Genehmigung / Ablehnung nur durch den zugewiesenen Richter → Beschluss aus Vorlage → Signatur → Ausfertigung
- Haftbefehle: Vollstreckung und Vollstreckungsbericht durch den USMS, Rückmeldung an das Gericht, Widerruf durch den Richter; Antrag schließt nach Rückmeldung
- Strikte Trennung: Gericht sieht nur Antrag und beigefügte Dokumente, Staatsanwaltschaft nie die Gerichtsakte, USMS nur Haftbefehl und Beschluss
- Ausdrückliche Dokumentfreigaben an Organisationen (auch für Dokumente in Akten)
- Oberfläche: Antragsliste mit „Awaiting my action“, Antragsdetail mit allen Verfahrensschritten, Antrags-Tab in Akten, Haftbefehlsliste und -detail
- 14 neue End-to-End-Tests (insgesamt 102); Mutationstests für Sichtbarkeit und Richterzuweisung

### Changed
- Haft- und Durchsuchungsbeschlüsse können nicht mehr direkt angelegt werden (`workflow_only`)


## 2026-09-25 – Phase 3 (Schritt 3.10)

### Added
- Migration `003_documents`: Vorlagen, Dokumenttypen, Dokumente, unveränderliche Versionen, Signaturen und Widerrufe (append-only), Dateien
- Vorlagen auf Deutsch (F5): Gerichtsbeschluss und Durchsuchungsbeschluss nach den Mustern des Auftraggebers; Haftbefehl, Vorladung, Urteil, Schriftsatz, Bericht, Vermerk im selben Stil
- Dokumente in Akten erben deren Sichtbarkeit (versiegelt = unsichtbar), eigene Stufe nie lockerer als die Akte; Dokumente ohne Akte mit Office-Sichtbarkeit
- Ablauf Entwurf → Prüfung (keine Selbstfreigabe) → Signatur (an Version + SHA-256 gebunden, Name/Rang/Institution als Momentaufnahme) → Ausfertigung → Archiv; Signaturwiderruf mit Begründung
- Integritätsprüfung: manipulierte Versionen machen Signaturen „INVALID“, Signieren wird verweigert
- Uploads (PDF/PNG/JPEG/WebP, Magic-Bytes, 10 MB), Ablage außerhalb von `public/`, Download nur über sichtbare Dokumente, `Content-Disposition: attachment` + Sandbox-CSP
- Oberfläche: Dokumentliste, Dokument-Tab in Akten, Anlage-Dialog mit Vorlagenfeldern bzw. Upload, Detail mit Vorschau/Signaturen/Versionen, Druckansicht (PDF über den Browser)
- Branding: `documentHeader` mit ausstellender Institution, eigenem Titel, Nummernbeschriftung und ausführender Behörde (rückwärtskompatibel); `documentFooter` mit Institution
- 17 neue Tests (insgesamt 88)

### Changed
- Rollen mit dem Basis-Bündel dürfen eigene Dokumente signieren (`DOCUMENT_SIGN`)
- `server.js`: verständliche Meldung, wenn der Port belegt ist


## 2026-09-25 – Phase 3 (Schritte 3.1–3.9)

### Added
- Projektgerüst: Express 4, `node:sqlite`, zod, helmet (CSP nur `'self'`), Tests mit `node:test`, ESLint, Typecheck per `tsc --checkJs`
- Migrationen `001_core` (Organisation, Benutzer, Rechte, Sicherheit, Sessions, Audit, Flags, Nummernkreise) und `002_cases`
- Idempotenter Seed; Bootstrap-System-Admin mit erzwungenem Passwortwechsel
- Audit Log: append-only (Trigger) und hash-verkettet, mit Prüfung
- Authentifizierung: gehashte Session-Token, Idle- und Absolut-Ablauf, Session-Rotation, CSRF, Rate Limit, Kontosperre
- Autorisierung: Principal mit Org-Baum-Scopes, Direktgrants, Delegationen, Clearance, Compartments, optionalen Mindesträngen
- Administration Center (API und UI) mit Eskalationsschutz
- Case Management mit Sichtbarkeitsprädikat als einziger Quelle, Office-Sichtbarkeit (F9), Sealing, Explicit-Access-Profilen, Links, Übergabe, akten-gebundener Delegation
- SPA ohne Build: Login, Shell, Kontextleiste, Department Switcher, Dashboard, Akten, Delegationen, Profil, Admin-Seiten
- Branding: Institutionen mit Platzhaltersiegeln, vereinbarte Gerichtsbezeichnung (F4), selbst gehostete Schriften, Beispiele als SAMPLE markiert
- Tests: 71, darunter Autorisierungsmatrix A1–A18 mit Paritätstest gegen unabhängige Referenz-Implementierung

### Changed
- `branding.js`: Lockups akzeptieren optional `institution` (rückwärtskompatibel); `brand.config.js` um `institutions` erweitert
- `branding.css`: Google-Fonts-Import durch lokale `@font-face` ersetzt (ADR-011)
- Vorschau- und Beispielseiten ohne Inline-Skripte, Inline-Styles und Inline-Handler (CSP)

### Security
- Mutationstests bestätigen: Aushebeln der Compartment-Prüfung oder der Sealing-Regel lässt die Testmatrix fehlschlagen


## 2026-09-25

### Added
- Master-Prompt überarbeitet (`prompt.txt`, Original in `prompt.original.txt`)
- Phase 1 (Audit): `CURRENT_STATE.md`, Ist-Teil von `ARCHITECTURE.md`
- Phase 2 (Architektur, Entwurf): `ARCHITECTURE.md`, `DATA_MODEL.md`, `PERMISSIONS.md`, `SECURITY_MODEL.md`, `WORKFLOWS.md`, `LEGAL_AUTHORITY_MATRIX.md` (alle Einträge NOT VERIFIED), `ARCHITECTURE_DECISIONS.md` (ADR-001 bis ADR-013), `IMPLEMENTATION_PLAN.md`, `MIGRATION_NOTES.md`

### Changed
- keine Codeänderungen, Branding-Paket unverändert
