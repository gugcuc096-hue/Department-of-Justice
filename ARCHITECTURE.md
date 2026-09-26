# ARCHITECTURE – San Andreas Justice Command System

Stand: 2026-09-25 · Status: **freigegeben 2026-09-25**

Verwandte Dokumente: `DATA_MODEL.md` · `PERMISSIONS.md` · `SECURITY_MODEL.md` · `WORKFLOWS.md` · `LEGAL_AUTHORITY_MATRIX.md` · `ARCHITECTURE_DECISIONS.md` · `IMPLEMENTATION_PLAN.md`

---

## 1. Ist-Zustand

Es existiert nur das Branding-Paket unter `public/branding/`, ohne Server, Datenbank oder Seiten. Details in `CURRENT_STATE.md`. Die Plattform wird in diesem Ordner neu aufgebaut, das Branding-Paket bleibt API-kompatibel erhalten.

---

## 2. Überblick Zielsystem

```text
Browser (SPA, Vanilla JS, kein Build)
   │  HTTPS · Session-Cookie (HttpOnly, SameSite=Strict) · X-CSRF-Token
   ▼
Express-Server (Node ≥ 22.13)
   ├── HTTP-Schicht        helmet/CSP · Rate Limits · Request-ID · zod-Validierung · Fehler-Handler
   ├── Auth                Sessions · Passwörter (bcrypt) · CSRF
   ├── Authz (Policy)      can(user, action, resource) · SQL-Sichtbarkeitsfilter
   ├── Shared Core         Orgs · Users · Cases · Documents · Evidence · Workflows · Hearings
   │                       Deadlines · Messaging · Requests · Notifications · Search · Persons · Audit
   ├── Fachmodule          USMS · Judiciary · Prosecution · SID · DCLI · Registry · US-SJA · Constitutional
   └── Datenzugriff        node:sqlite (WAL) · Migrationen · FTS5
   ▼
data/                      sjcs.db · uploads/ (außerhalb von public/, nur über API)
```

**Grundprinzip:** Fachmodule besitzen keine eigenen Kopien von Users, Cases, Documents usw. Sie nutzen den Shared Core und ergänzen nur fachspezifische Tabellen (z. B. `licenses`, `registry_records`, `operations`). Jede Datenabfrage läuft durch die Autorisierungsschicht.

---

## 3. Technologie-Stack

| Bereich | Wahl | Begründung |
|---|---|---|
| Runtime | Node ≥ 22.13 (lokal 24.21) | vorhanden, `node:sqlite` eingebaut |
| Web | Express 4 | von Branding-README vorausgesetzt, bekannt aus `pake-scha-server` |
| DB | SQLite über `node:sqlite`, WAL, Foreign Keys | keine nativen Builds unter Windows, FTS5 und Trigger vorhanden, ausreichend für RP-Server-Größe. Datenzugriff gekapselt, damit Postgres später möglich bleibt (ADR-003). |
| Validierung | zod | serverseitig für jede Eingabe |
| Sicherheit | helmet, express-rate-limit, bcryptjs, cookie-parser | Standard |
| Frontend | Vanilla-JS-SPA, ES-Module, kein Bundler | passt zum Branding-Paket, keine Build-Kette (ADR-004) |
| Typecheck | `// @ts-check` + JSDoc, `tsc --noEmit` (devDependency) | erfüllt „typecheck“ ohne TS-Build |
| Lint | ESLint (flat config) | |
| Tests | `node:test` + `fetch` gegen einen per `app.listen(0)` gestarteten Server | ohne zusätzliche Test-Frameworks |
| PDF | Druckansicht und `window.print()`. Optional später serverseitig mit Headless-Chromium (Branding-README). | |

---

## 4. Verzeichnisstruktur

```text
usms-branding/
├── server.js                    Einstieg: Config laden, migrieren, seeden, App starten
├── package.json
├── .env.example
├── src/
│   ├── app.js                   Express-App-Fabrik (für Server und Tests)
│   ├── config.js                ENV lesen und validieren
│   ├── db/
│   │   ├── index.js             Verbindung, Transaktions-Helper
│   │   ├── migrate.js           nummerierte Migrationen, schema_migrations
│   │   ├── migrations/          001_core.sql, 002_cases.sql, …
│   │   └── seeds/               Organisationen, Ränge, Rollen, Permissions, Levels, Compartments,
│   │                            Case Types, Workflows (idempotent), Demo-Daten (nur mit SEED_DEMO=1)
│   ├── http/                    errors.js · validate.js · requestId.js · csrf.js · rateLimits.js
│   ├── core/
│   │   ├── auth/                sessions, passwords, login/logout routes
│   │   ├── authz/               policy.js (can), filters.js (SQL-Prädikate), scopes.js, delegation.js
│   │   ├── audit/               audit.js (Hash-Kette), routes
│   │   ├── orgs/  users/  cases/  documents/  signatures/  evidence/  files/
│   │   ├── workflows/           engine.js, definitions/
│   │   ├── hearings/  deadlines/  messaging/  requests/  notifications/  search/  persons/
│   │   └── admin/               Administration Center (Settings, Types, Templates)
│   └── modules/
│       ├── usms/  judiciary/  prosecution/  sid/  dcli/  registry/  ussja/  constitutional/
│       └── <modul>/{routes.js, service.js, schema.js}
├── public/
│   ├── branding/                unverändert API-kompatibel, erweitert um institutions
│   └── app/
│       ├── index.html           SPA-Shell (Header, Sidebar, Kontextleiste, Main)
│       ├── app.css
│       ├── js/                  api.js · router.js · store.js · ui/ (Tabelle, Formular, Dialog, Toast)
│       └── views/               eine Datei pro Seite / Modul
├── test/                        unit/ · integration/ · authz/ (Testmatrix) · workflows/
└── data/                        (gitignored) sjcs.db, uploads/, backups/
```

Jedes Modul hat dieselbe Form: `routes.js` (HTTP und Validierung), `service.js` (Fachlogik, ruft `can()` auf), `schema.js` (zod). Routes enthalten keine SQL-Abfragen.

---

## 5. Request-Ablauf

```text
Request
 → requestId → helmet → rateLimit
 → cookie → loadSession (user, activeOrg, clearance, compartments, permissions-cache)
 → csrf (bei POST/PUT/PATCH/DELETE)
 → route: zod.parse(body/query/params)
 → service:
      resource = repo.load(id)                          // ohne Filter laden …
      if (!resource || !can(user,'VIEW',resource)) → 404   // … aber Existenz verbergen
      if (!can(user, action, resource))            → 403
      tx { mutate; workflow.transition; audit.write; notify.enqueue; search.reindex }
 → response (nur Felder, die der User sehen darf)
 → errorHandler: generische Meldung + requestId; Details ins System Log
```

Listen und Suche verwenden **nicht** „laden und filtern“, sondern ein SQL-Prädikat aus `authz/filters.js`. Dieselbe Regel steckt in `can()`. Ein Paritätstest stellt sicher, dass beide übereinstimmen (SECURITY_MODEL.md, Abschnitt 9).

---

## 6. Branding-Integration (Mehr-Institutionen)

Die bestehende API bleibt. `brand.config.js` wird **erweitert**:

```js
institutions: {
  USMS:  { name: 'United States Marshals Service', short: 'USMS', seal: BASE+'seal.svg', numberPrefix: 'USMS' },
  DA:    { name: 'Office of the District Attorney', short: 'DA', seal: BASE+'seals/da.svg', numberPrefix: 'DA' },
  DC:    { name: '<siehe F4>', district: '…', seal: BASE+'seals/dc.svg', numberPrefix: 'DC' },
  // SA, AG, SID, DCLI, COA, SC, REG, USSJA, CC
},
documentTypes: {
  warrant: { title: 'Arrest Warrant', issuer: 'DC', executor: 'USMS', … },   // issuer jetzt Institutionscode
  …
}
```

- `documentHeader({ issuer })` liest Aussteller aus `institutions`. Fehlt `issuer`, gilt wie bisher `court`/`agency`.
- Platzhaltersiegel pro Institution unter `public/branding/seals/`, jeweils mit `isPlaceholder`.
- Lockups in Header und Sidebar zeigen die **aktive** Institution (Department Switcher).
- Die Nummernvergabe erfolgt serverseitig pro `(prefix, year)` in einer Transaktion, Format über `formatDocNumber`. Die Präfix-Varianten wie `DC-CR-2026-0001` stehen in DATA_MODEL.md, Abschnitt 4.

---

## 7. Frontend

- **Shell:** Global Header (Lockup, aktive Institution/Office, Suche, Messages, Notifications, User-Menü), Sidebar (aus `/api/me/navigation`, serverseitig anhand der Permissions berechnet), Kontextleiste (Department · Office · Rank · Case · Security Level), Main.
- **Router:** History API. Der Server liefert für alle `/app/*`-Pfade `index.html`. Unbekannte Routen zeigen eine eigene „Nicht gefunden“-Seite, keine leere Seite.
- **Rendering:** Template-Strings mit Pflicht-Escape-Helper `h\`\``. Kein `innerHTML` mit unescaped Daten.
- **Formulare:** Validierung serverseitig mit zod, clientseitig gespiegelt. Autosave von Entwürfen über `drafts`-API (serverseitig, nicht localStorage, damit Entwürfe keine sensiblen Daten im Browser hinterlassen).
- **Deaktivierte Funktionen:** Menüpunkte mit `status: 'disabled'` werden ausgegraut mit Tooltip angezeigt (z. B. „Legal basis not verified – disabled by administrator“).
- **Barrierefreiheit:** semantisches HTML, Fokusmanagement bei Routenwechsel, sichtbare Fokusrahmen, Kontrast ≥ 4.5:1 (Farben aus `branding.css`).

---

## 8. Konfiguration (ENV)

| Variable | Zweck | Standard |
|---|---|---|
| `PORT` | HTTP-Port | 3000 |
| `NODE_ENV` | `development` / `production` | development |
| `DB_PATH` | Pfad der SQLite-Datei | `data/sjcs.db` |
| `UPLOAD_DIR` | Upload-Ablage | neben DB |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | Session-Laufzeiten | 120 / 12 |
| `BOOTSTRAP_ADMIN_USER` / `BOOTSTRAP_ADMIN_PASSWORD` | erster System Admin (nur wenn noch kein User existiert) | – |
| `SEED_DEMO` | Demo-Daten (gekennzeichnet `DEMO`) | 0 |
| `TRUST_PROXY` | hinter Reverse Proxy (Render) | 0 |

Secrets stehen nur in `.env` (gitignored). `.env.example` dokumentiert alle Variablen.

---

## 9. Umgebungen und Betrieb

- `Development → Staging → Production` (Prompt 10.6). Staging ist eine zweite Instanz mit eigener DB.
- Backups: tägliche Kopie der DB über `VACUUM INTO` nach `data/backups/`, vor jeder destruktiven Migration zwingend (`MIGRATION_NOTES.md`).
- Logs: System Log (JSON-Zeilen auf stdout) getrennt vom Audit Log (DB-Tabelle).

---

## 10. Modulgrenzen und Abhängigkeiten

```text
modules/*  ──►  core/*  ──►  db
    │             ▲
    └── nie direkt auf Tabellen anderer Module zugreifen; nur über deren service.js
```

Cross-Department-Vorgänge (z. B. Haftbefehl: Prosecution → Court → USMS) laufen über die Workflow-Engine und `official_requests`, nicht über direkte Tabellenzugriffe zwischen Modulen.
