# ARCHITECTURE_DECISIONS – San Andreas Justice Command System

Format: Kontext · Entscheidung · Konsequenzen. ADR-001 bis ADR-013 am 2026-09-25 vom Auftraggeber freigegeben.

---

## ADR-001 – Neuaufbau auf Basis des Branding-Pakets · ACCEPTED

**Kontext:** Das Audit ergab: Außer `public/branding/` existiert keine USMS-Anwendung (CURRENT_STATE.md).
**Entscheidung:** Die Plattform wird in `usms-branding/` neu aufgebaut. Das Branding-Paket bleibt API-kompatibel (`data-brand`, `USMSBrand`, `brand.config.js`) und wird nur erweitert.
**Konsequenzen:** Keine Migration von Altdaten nötig. Regel 1 des Prompts gilt für das Branding-Paket.

## ADR-002 – Stack: Node, Express, Vanilla JS · ACCEPTED

**Kontext:** Die Branding-README setzt Express voraus. Das Branding ist Vanilla JS ohne Build. Der Auftraggeber betreibt mit `pake-scha-server` bereits ein Express- und `node:sqlite`-Projekt (vermutlich auf Render).
**Alternativen:** (a) Next.js/React + Postgres + Prisma: mehr Ökosystem, aber Build-Kette, React-Umbau des Brandings und externe DB. (b) Express + SQLite + Vanilla JS.
**Entscheidung:** (b). Typsicherheit über `// @ts-check` + JSDoc + `tsc --noEmit`.
**Konsequenzen:** Keine Build-Kette, ein Prozess, eine Datei-DB, leicht zu betreiben. UI-Komponenten werden selbst gebaut (kleines internes Set: Tabelle, Formular, Dialog, Tabs, Toast).

## ADR-003 – SQLite über `node:sqlite` · ACCEPTED

**Kontext:** Die erwartete Last (RP-Server, Dutzende bis wenige Hundert Nutzer) ist gering. FTS5 und Trigger sind verfügbar (geprüft mit Node 24.21 / SQLite 3.53.4).
**Entscheidung:** SQLite im WAL-Modus. Zugriff ausschließlich über Repository-Funktionen mit Prepared Statements. SQL ist so ANSI-nah wie möglich.
**Konsequenzen:** Ein Wechsel auf Postgres ist später möglich (Repositories und Migrationen anpassen). Ein einzelner Schreibprozess reicht, horizontale Skalierung erfordert dann Postgres.

## ADR-004 – SPA ohne Build, serverseitig berechnete Navigation · ACCEPTED

**Entscheidung:** Die SPA mit History-API-Router bezieht ihre Navigation aus `/api/me/navigation`. Der Server berechnet sie aus Permissions und aktiver Org.
**Konsequenzen:** Das Frontend enthält keine Rechte-Logik außer zur Benutzerführung. Die API prüft immer selbst.

## ADR-005 – Ein Organisationsbaum statt getrennter Tabellen · ACCEPTED

**Kontext:** Der Prompt nennt `departments`, `offices` und `divisions` als Tabellen, erlaubt aber Anpassung. Die Ebenen sind je nach Institution unterschiedlich tief (SID unter Prosecution, Registry unter Judiciary, US-SJA mit Mitgliedern aus mehreren Gerichten).
**Entscheidung:** Tabelle `organizations` mit `parent_id` und `kind`. Scopes gelten für den Teilbaum.
**Konsequenzen:** Neue Einheiten ohne Schemaänderung. Scope-Prüfung über Vorfahren-Abfrage (rekursives CTE, gecacht pro Request).

## ADR-006 – `decisions` statt `court_orders` und `judgments` · ACCEPTED

**Entscheidung:** Eine Tabelle `decisions` mit `kind` (ORDER, JUDGMENT, OPINION, CONSTITUTIONAL_DECISION). Der Inhalt liegt im signierten Dokument.
**Konsequenzen:** Einheitliche Signatur- und Veröffentlichungslogik.

## ADR-007 – Security Levels + Compartments · ACCEPTED

**Kontext:** Der Prompt führt `US-SJA` als Stufe in derselben Liste wie `CLASSIFIED`. Eine lineare Skala würde bedeuten, dass jeder mit hoher Stufe alles Niedrigere sieht, also auch SID oder Registry.
**Entscheidung:** Geordnete Levels plus unabhängige Compartments (`SID`, `SID_RESTRICTED`, `REGISTRY`, `USSJA`). Benannte `security_profiles` bilden die Prompt-Ebenen ab.
**Konsequenzen:** Ein Chief Justice ohne US-SJA-Compartment sieht keine US-SJA-Akten. Zuweisungen werden expliziter und dadurch sicherer.

## ADR-008 – Existenzschutz durch 404 · ACCEPTED

**Entscheidung:** Nicht sichtbare Objekte liefern dieselbe Antwort wie nicht existierende. Zähler, Suche, Links und Notifications laufen über denselben Sichtbarkeitsfilter.

## ADR-009 – Append-only mit Hash-Kette · ACCEPTED

**Entscheidung:** `audit_log`, `case_events`, `workflow_actions`, `document_versions`, `document_signatures`, `evidence_custody` und `deadline_extensions` sind per Trigger gegen UPDATE und DELETE geschützt. `audit_log` und `evidence_custody` sind zusätzlich hash-verkettet.
**Konsequenzen:** Korrekturen erfolgen nur als neue Einträge (Revocation, Supersede). Ein Admin mit Dateizugriff kann die DB weiterhin manipulieren, das deckt die Hash-Prüfung auf, verhindert es aber nicht (dokumentierte Grenze).

## ADR-010 – Signaturen als gebundener Snapshot · ACCEPTED

**Entscheidung:** Eine Signatur speichert Version, SHA-256 der Version sowie Name, Rang und Org zum Signaturzeitpunkt. Die Gültigkeit wird serverseitig berechnet und nie aus einem UI-Zustand abgeleitet.
**Grenze:** Das ist keine kryptografische Signatur im PKI-Sinn, sondern eine nachvollziehbare, manipulationserkennbare Plattform-Signatur. Das reicht für den RP-Kontext und wird in der UI nicht anders dargestellt.

## ADR-011 – Schriften selbst hosten · ACCEPTED

**Kontext:** `branding.css` lädt Public Sans und Merriweather per `@import` von Google.
**Entscheidung:** Die Schriften (OFL-lizenziert) werden unter `public/branding/fonts/` abgelegt und der `@import` durch `@font-face` ersetzt. Die CSP bleibt dann bei `'self'`.

## ADR-012 – Feature Flags für nicht verifizierte Rechtsfunktionen · ACCEPTED

**Entscheidung:** `feature_flags` mit `legal_status`. Die UI zeigt bei `NOT_VERIFIED` einen Hinweis. Bei `enabled=0` sind die API-Endpunkte gesperrt (`403` mit Code `FEATURE_DISABLED`) und die Menüpunkte deaktiviert, nicht versteckt.

## ADR-013 – Tests ohne zusätzliche Frameworks · ACCEPTED

**Entscheidung:** `node:test` + `node:assert`. Integrationstests starten die App auf einem zufälligen Port mit In-Memory-DB (`:memory:`) und Seed. Die Autorisierungs-Testmatrix (PERMISSIONS.md, Abschnitt 7) und der Paritätstest sind Pflicht im CI-Lauf `npm test`.
