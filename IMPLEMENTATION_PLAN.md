# IMPLEMENTATION_PLAN – San Andreas Justice Command System

Stand: 2026-09-25 · Status: **freigegeben 2026-09-25**

Jeder Schritt endet mit: `npm run lint && npm run typecheck && npm test`, Aktualisierung von `CURRENT_STATE.md` und `CHANGELOG.md` sowie einem Commit (falls F8 = ja). Ein Schritt gilt erst als fertig, wenn er über die UI **und** die API durchgespielt wurde.

---

## Phase 3 – Shared Core

| Schritt | Inhalt | Abnahme |
|---|---|---|
| 3.1 | Projektgerüst: `package.json`, ESLint, `tsc --checkJs`, `node:test`, `.env.example`, `.gitignore`, `server.js`, `src/app.js`, Fehler-Handler, Request-ID, helmet/CSP, statische Auslieferung, SPA-Fallback | `npm start` liefert Shell und `/branding/preview.html` aus, alle Checks grün |
| 3.2 | DB-Schicht und Migrationen (`001_core.sql`), Append-only-Trigger, `schema_migrations` mit Checksumme | Migration idempotent, Trigger-Test grün |
| 3.3 | Seeds: Organisationsbaum, Ränge (Prompt 3.2), Permissions, Rollen, Levels, Compartments, Profile, Feature Flags, Bootstrap-Admin | Seeds idempotent |
| 3.4 | Audit Log mit Hash-Kette und Verify-Endpunkt | Manipulationstest schlägt an |
| 3.5 | Auth: Login/Logout, Sessions, CSRF, Rate Limit, Passwortwechsel | Auth-Tests, Audit von Login und Fehlversuchen |
| 3.6 | Authz: `can()`, Scopes, Delegation, SQL-Sichtbarkeitsfilter, Paritätstest | Testmatrix A9–A18 soweit ohne Fachmodule möglich |
| 3.7 | Administration Center I: Users, Mitgliedschaften, Ränge, Rollen, Clearance, Compartments, Delegationen, Organisationen | Vergaberegeln (A13, A14) |
| 3.8 | SPA-Shell: Header, Sidebar aus `/api/me/navigation`, Kontextleiste, Department Switcher, Router, UI-Kit, Branding mit `institutions` | Navigation unterscheidet sich je User, keine toten Links |
| 3.9 | Cases: Types, Anlage mit Nummernkreis, Participants, Access, Timeline, Links, Sealing, Case Switcher | Testmatrix A1–A3, A12 |
| 3.10 | Documents: Versionen, Templates, Access, Signaturen, Dateien/Uploads, Druckansicht mit Branding-Kopf | Signatur-Invalidierung bei neuer Version |
| 3.11 | Workflow-Engine und Definitionen als Seed | Übergangs- und Selbstgenehmigungstests |
| 3.12 | Evidence und Chain of Custody | Zwei-Seiten-Bestätigung, Append-only |
| 3.13 | Hearings, Deadlines (inkl. Overdue-Job), Kalender | |
| 3.14 | Messaging, Official Requests, Notifications (inkl. Unread Counts) | Notification-Leak-Tests |
| 3.15 | Personen, Unternehmen, globale Suche (FTS5 und Filter) | Such-Leak-Tests (A5, A8) |
| 3.16 | Audit UI, Reports, Exporte, Dashboard-Framework, Formularentwürfe | A17 |
| 3.17 | Administration Center II: Case Types, Dokumenttypen, Vorlagen (neue Version), Sicherheitsprofile, Einstellungen, Aufbewahrungsfristen | Konfiguration ohne Codeänderung, Vorlagenänderung verändert keine signierten Dokumente |

## Phase 4 – USMS

Personal und Ränge (über Core), Operations, Arrests, Prisoner Transport, Court Security, Reports (bestehende Dokumenttypen), Tasks, Bewerbungen, Warrant-Vollstreckung, USMS-Dashboard.

## Phase 5 – Judiciary

District Court (Straf- und Zivilsachen, Anträge, Warrants, Beschlüsse, Urteile, Anhörungen), Court of Appeals (Appeals, Panels, Vorinstanz-Link), Supreme Court (Review, Opinions), Gerichtsvorlagen aus Prompt 8.3 und 8.4, Judiciary-Dashboard.

## Phase 6 – Prosecution

DA, SA und AG mit Rängen, Akten, Anträge an Gerichte, Übergabe zwischen Offices, Prosecution-Dashboard.

## Phase 7 – Spezialeinheiten

SID (Compartment, eigene Akten), DCLI (Register, Lizenzen, Inspektionen, Ermittlungen, Gebühren, Dashboard), Registry (Records, Anträge, Urkunden, Dashboard), US-SJA (Scope, Profile, Dashboard), Constitutional Court (Hülle, deaktiviert).

## Phase 8 – Cross-Department

End-to-End: Warrant Prosecution → District Court → USMS → Court. Appeal-Kette DC → CoA → SC. DCLI → Prosecution → Court. Registry ↔ Court (Adoption). Official Requests aller Richtungen aus Prompt 6.7.

## Phase 9 – Security-Audit

Vollständige Testmatrix, manuelle Prüfung aller Endpunkte auf Object-Level-Authz, Leak-Kanäle aus SECURITY_MODEL.md Abschnitt 7, Header und CSP, Upload-Härtung, Definition of Done (Prompt 12).

---

## Danach

- Rechtsquellen einarbeiten (LEGAL_AUTHORITY_MATRIX.md, Abschnitt „Nachzuziehen“)
- finale Siegel und Logos einsetzen
- Deployment (Staging, dann Production)
