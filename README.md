# San Andreas Justice Command System

Eine Plattform für United States Marshals Service, Prosecution und Judiciary auf einem GTA-RP-Server (ModernV).
Anforderungen: `prompt.txt` · Arbeitsstand: `CURRENT_STATE.md` · Architektur: `ARCHITECTURE.md`

> Roleplay-Software. Keine echten Behördendaten, alle Rechtsfunktionen sind bis zur Prüfung der ModernV-Rechtsquellen als „not verified“ gekennzeichnet.

## Voraussetzungen

- Node.js ≥ 22.13 (getestet mit 24.21)

## Starten

```bash
npm install
cp .env.example .env        # dann BOOTSTRAP_ADMIN_PASSWORD setzen (mind. 12 Zeichen, Buchstaben + Zahl/Symbol)
npm start                   # http://localhost:3000
```

Beim ersten Start werden Datenbank (`data/sjcs.db`), Stammdaten und der erste System Admin angelegt. Das Passwort muss bei der ersten Anmeldung geändert werden.

Der System Admin verwaltet Benutzer, Rollen und Einstellungen, sieht aber **keine Akteninhalte** (Entscheidung F6). Für die fachliche Arbeit legt er Benutzer mit Mitgliedschaft, Rang und Rolle an (z. B. `JUDGE` im Scope District Court).

## Prüfen

```bash
npm run check    # Lint + Typecheck + Tests
npm test         # nur Tests (In-Memory-Datenbank, keine Seiteneffekte)
```

## Aufbau

```text
server.js              Einstieg
src/app.js             Express-App (auch für Tests)
src/db/                Verbindung, Migrationen, Seeds
src/core/              Auth, Autorisierung, Audit, Admin, Cases …
public/branding/       Branding-Paket (Siegel, Schriften, Komponenten)
public/app/            Oberfläche (ES-Module, kein Build)
test/                  node:test – inkl. Autorisierungsmatrix
```
