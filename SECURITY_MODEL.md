# SECURITY_MODEL – San Andreas Justice Command System

Stand: 2026-09-25 · Status: **freigegeben 2026-09-25**

---

## 1. Schutzziele

1. **Vertraulichkeit mit organisatorischer Trennung:** Jede Institution sieht nur, wozu sie berechtigt ist. SID, Registry und US-SJA sind zusätzlich abgeschottet.
2. **Existenzschutz:** Bei geschützten Vorgängen (Sealed, US-SJA) erfahren Unberechtigte nicht einmal, dass sie existieren.
3. **Integrität:** Signaturen, Chain of Custody, Timeline und Audit Log sind nicht still veränderbar.
4. **Nachvollziehbarkeit:** Jeder sicherheitsrelevante Zugriff, auch ein verweigerter, wird auditiert.
5. **Human-in-the-Loop:** Rechtlich erhebliche Zustandswechsel verlangen eine ausdrückliche Handlung einer berechtigten Person.

---

## 2. Security Levels

Die Stufen sind geordnet und konfigurierbar (Tabelle `security_levels`):

| Rang | Code | Verwendung (Vorschlag) |
|---|---|---|
| 0 | `PUBLIC` | öffentliche Informationen, z. B. Lizenzregister-Auszug |
| 1 | `INTERNAL` | Standard für interne Vorgänge |
| 2 | `RESTRICTED` | eingeschränkter Personenkreis |
| 3 | `CONFIDENTIAL` | vertrauliche Ermittlungen und Verfahren |
| 4 | `SEALED` | versiegelte Verfahren (Sonderregeln, Abschnitt 6) |
| 5 | `CLASSIFIED` | höchste Stufe |

**Regel:** `user.clearance.rank ≥ object.level.rank`

Die Clearance ist eine Eigenschaft des Users und wird von einem Security Admin gesetzt. Sie gewährt allein **keinen** Zugriff, sie ist nur eine von mehreren notwendigen Bedingungen.

## 3. Compartments

Compartments sind getrennte Bereiche nach dem Need-to-know-Prinzip, **zusätzlich** zum Level.

| Code | Bereich | Vergabe durch |
|---|---|---|
| `SID` | Ermittlungsakten der Special Investigations Division | Security Admin mit `SID` |
| `SID_RESTRICTED` | besonders eingeschränkte SID-Akten | Security Admin mit `SID_RESTRICTED` |
| `REGISTRY` | Personenstandsdaten | Security Admin mit `REGISTRY` |
| `USSJA` | United States Special Judicial Authority | Security Admin mit `USSJA` |

**Regel:** `object.compartments ⊆ user.activeCompartments`. Compartments mit abgelaufenem `expires_at` gelten nicht.

**Abbildung der US-SJA-Ebenen aus dem Prompt (4.9):**

| Prompt-Ebene | Level | Compartments |
|---|---|---|
| `US-SJA` | `CONFIDENTIAL` | `USSJA` |
| `US-SJA RESTRICTED` | `CONFIDENTIAL` + Pflicht zur expliziten Aktenbeteiligung | `USSJA` |
| `US-SJA SEALED` | `SEALED` | `USSJA` |
| `US-SJA CLASSIFIED` | `CLASSIFIED` | `USSJA` |

Die Zuordnung ist administrierbar (Tabelle `security_profiles`, die Level und Compartments zu einem benannten Profil bündelt). `US-SJA RESTRICTED` bedeutet: Der Zugriff setzt explizite Beteiligung voraus, auch bei Organisations- oder Supervisor-Rechten.

## 4. Zugriffsentscheidung `can(user, action, resource)`

Reihenfolge der Prüfung. Die erste nicht erfüllte Bedingung führt zur Ablehnung.

```text
1. Session gültig, User ACTIVE
2. Permission:     user besitzt die Permission für `action` im Scope der besitzenden Organisation
                   (Rolle mit Scope = Org oder Vorfahre · Direktgrant · aktive Delegation)
3. Level:          clearance ≥ resource.level
4. Compartments:   resource.compartments ⊆ user.compartments
5. Objektzugang:   resourceAccess(user, resource)   → siehe unten
6. Zustand:        action ist im aktuellen Workflow-/Objektzustand erlaubt
7. Zusatzregeln:   Sealed (Abschnitt 6), Interessenkonflikt/Recusal (konfigurierbar), Selbstgenehmigung verboten
```

**`resourceAccess` für Cases:** Mindestens eine der folgenden Bedingungen muss zutreffen:

| Zugang | Bedingung |
|---|---|
| Participant Access | User ist als Beteiligter mit Zugang in `case_participants` eingetragen |
| User Access | `case_access` hat einen Eintrag für diesen User (nicht widerrufen, nicht abgelaufen) |
| Role Access | `case_access` hat einen Eintrag für eine Rolle, die der User im passenden Scope hat |
| Office/Department Access | `case_access` hat einen Eintrag für eine Org, in deren Teilbaum der User Mitglied ist |
| Supervisor Access | User hat `CASE_VIEW_ORG` im Scope der besitzenden Org (gilt **nicht** bei Sealed und nicht bei `US-SJA RESTRICTED`) |
| Delegated Access | aktive Delegation, die sich auf diesen Case oder die nötige Permission bezieht |
| Temporary Access | `case_access.expires_at` in der Zukunft |

**Wichtig:**
- **Office-Sichtbarkeit (Entscheidung F9):** Die besitzende Org bekommt bei Anlage einen `case_access`-Eintrag (ORG, VIEW), wenn der Case Type `default_org_access` hat. Das ist im Seed für alle Typen gesetzt. Dieser Zugang gilt nur für das besitzende Office, nicht für die übergeordnete Institution, und nicht bei Sealed oder `requires_explicit_access`. Level und Compartments gelten weiterhin. **Sehen** ist office-weit, **Bearbeiten** verlangt Beteiligung oder `CASE_ASSIGN` (PERMISSIONS.md, Abschnitt 5).
- **System Admin** hat keine Sonderrolle bei Inhalten. Er verwaltet Konfiguration und Benutzer, sieht aber Akten nur wie jeder andere über die obigen Regeln (Entscheidung F6).
- **Rang** gewährt nie direkt Zugriff (Prompt 5.1). Optional lässt sich pro Permission ein Mindestrang konfigurieren (`permission_rank_requirements`). Das ist eine zusätzliche Bedingung, keine Erteilung.

**Documents:** Sichtbar, wenn der zugehörige Case sichtbar ist **und** Level und Compartments des Dokuments erfüllt sind. Ein Dokument kann strenger sein als sein Case, aber nie lockerer. Dokumente ohne Case haben eigenes `document_access`.

**Ausdrückliche Dokumentfreigaben (umgesetzt in 3.11):** Ein einzelnes Dokument kann ausdrücklich für eine Person oder Organisation freigegeben werden, auch wenn es zu einer Akte gehört. So sieht das Gericht die einem Antrag beigefügten Dokumente, der USMS den ausgefertigten Haftbefehl und die Staatsanwaltschaft den Vollstreckungsbericht, ohne Zugriff auf die jeweiligen Akten. Level und Compartments des Dokuments gelten weiterhin. Die Freigabe bleibt bestehen, auch wenn die Akte später versiegelt wird: Sie war eine bewusste Übermittlung und wird auditiert (`DOCUMENT_SHARE`).

**Abgeleitete Objekte** (Evidence, Hearings, Deadlines, Case Messages, Warrants, Decisions) erben die Sichtbarkeit vom Case, plus eigene Permission-Prüfung für die Aktion.

## 5. Antwortverhalten bei Ablehnung

| Situation | Antwort |
|---|---|
| Objekt existiert nicht | `404` |
| Objekt existiert, User darf es **nicht sehen** | `404` (identisch mit „existiert nicht“, auch Body und Timing-Pfad) |
| Objekt sichtbar, Aktion nicht erlaubt | `403` |
| Ungültige Eingabe | `400` mit Feldfehlern (keine internen Details) |

Jede Ablehnung bei Schritt 2 bis 7 schreibt ein Audit-Event `outcome=DENIED`. Level und Compartments des Objekts werden mitgespeichert, sodass nur entsprechend berechtigte Auditoren es sehen (Abschnitt 8).

## 6. Sealed Records

- Sealing ist eine eigene Aktion (`CASE_SEAL`/`CASE_UNSEAL`) mit Pflichtbegründung. Beides wird auditiert.
- Ein versiegelter Case ignoriert Supervisor Access und Org-Access-Einträge. Zugriff haben nur ausdrücklich eingetragene User, Teilnehmer mit `sealed_access=1` und Delegationen darauf.
- Ohne Zugriff gilt: kein Inhalt, keine Dokumente, keine Teilnehmer, keine Suchtreffer, keine Trefferzahlen, keine Verknüpfungen, keine inhaltlichen Notifications.

## 7. Informationslecks – Kanäle und Gegenmaßnahmen

| Kanal | Maßnahme |
|---|---|
| Suche | FTS-Treffer werden in derselben SQL-Abfrage mit dem Sichtbarkeitsprädikat gefiltert. Trefferzahl nur über gefilterte Menge. |
| Listen und Zähler (Dashboards, Unread Counts) | nur über Sichtbarkeitsprädikat |
| Case-Verknüpfungen | nur anzeigen, wenn **beide** Enden sichtbar sind |
| Personenakte | jede Verknüpfung einzeln prüfen, unsichtbare fallen weg (kein „3 weitere verborgen“) |
| Notifications | Empfänger nur, wenn er zum Erstellungszeitpunkt sehen darf. Beim Anzeigen erneut prüfen. Ab `SEALED` oder bei Compartment nur generischer Text („Neue Aktivität in einer Ihrer Akten“). |
| Aktenzeichen | Nummernkreise pro Präfix. US-SJA, SID und Registry haben **eigene Präfixe**, damit Lücken in öffentlichen Nummernkreisen nichts verraten. |
| Fehlermeldungen | 404 statt 403 bei Unsichtbarkeit. Validierungsfehler verraten keine fremden IDs (z. B. „Verknüpfter Case nicht gefunden“ statt „kein Zugriff“). |
| Audit-Ansicht | Level- und Compartment-Filter auch für Auditoren |
| Exporte und Reports | gleiche Prädikate, zusätzlich `*_EXPORT`-Permission, Audit |
| Uploads | nie unter `public/`, Auslieferung nur über `/api/files/:id` mit Prüfung des Elternobjekts |
| Caching | `Cache-Control: no-store` für alle API-Antworten. Kein serverseitiger Cache über Berechtigungsgrenzen. |

## 8. Audit Log

- Tabelle `audit_log`, **append-only**: SQLite-Trigger verhindern `UPDATE` und `DELETE` (geprüft: funktioniert mit `node:sqlite`).
- **Hash-Kette:** `hash = sha256(prev_hash ‖ canonical_json(entry))`. `GET /api/audit/verify` prüft die Kette, und ein täglicher Job schreibt das Ergebnis ins System Log.
- Inhalt: Zeit, Actor, Session, aktive Org, Aktion, Ressourcentyp und -ID, Level und Compartments der Ressource, IP, User-Agent, Outcome (`SUCCESS`, `DENIED`, `FAILURE`), Details (ohne Passwörter oder Token).
- Sichtbarkeit: `AUDIT_VIEW` im Org-Scope, dazu Level- und Compartment-Regel auf den Eintrag. US-SJA-Einträge sehen nur Auditoren mit `USSJA`.
- Das Audit Log wird in derselben Transaktion wie die Fachänderung geschrieben. Ohne Audit-Eintrag gibt es keine Änderung.

## 9. Parität von Policy und SQL-Filter

**Umsetzung:** Es gibt nur **eine** Implementierung der Sichtbarkeitsregel, das SQL-Prädikat in `src/core/cases/visibility.js`. Einzelprüfung (`canViewCase` bzw. `… AND c.id = ?`), Listen, Zähler, Verknüpfungen und Suche verwenden alle dieses Prädikat. Damit können sie nicht auseinanderlaufen.

Zusätzlich enthält `test/authz/cases.test.js` eine **unabhängige, bewusst naive Referenz-Implementierung** in JavaScript. Der Test prüft für **alle** Test-Benutzer × **alle** Test-Akten:

```text
id ∈ list(user)  ⇔  canViewCase(user, case)  ⇔  referenceCanView(user, case)
```

Schlägt er fehl, ist der Build rot. Per Mutationstest bestätigt: Wird die Compartment-Prüfung oder die Sealing-Regel im Prädikat ausgehebelt, schlagen die Matrix und der Paritätstest fehl.

## 10. Authentifizierung und Sessions

- Passwörter: bcrypt (Kosten 12), Mindestlänge 12, kein Maximum unter 72 Byte. Beim ersten Login ist ein Passwortwechsel Pflicht, wenn der Admin das Passwort gesetzt hat.
- Sessions: 32-Byte-Zufallstoken. In der DB wird nur `sha256(token)` gespeichert. Cookie `sjcs_sid` mit `HttpOnly`, `SameSite=Strict`, `Secure` in Production, `Path=/`.
- Laufzeit: Idle 120 min, absolut 12 h (konfigurierbar). Beim Login wird die Session-ID erneuert. Beim Logout und bei Deaktivierung werden alle Sessions gelöscht.
- CSRF: `SameSite=Strict` **und** Header `X-CSRF-Token` (pro Session) bei allen zustandsändernden Requests.
- Brute Force: Rate Limit pro IP und pro Benutzername, schrittweise Verzögerung. Fehlgeschlagene Logins werden auditiert, der Benutzername nur, wenn er existiert. Die Antwort ist immer „Anmeldedaten ungültig“.
- Rechteänderungen (Rolle, Compartment, Clearance, Deaktivierung) wirken **sofort**, weil Berechtigungen pro Request frisch geladen werden. Es gibt keine Permissions im Cookie.

## 11. Weitere Maßnahmen (Prompt 10.3)

| Thema | Maßnahme |
|---|---|
| XSS | CSP `default-src 'self'`, kein Inline-Script. Escape-Helper im Frontend. Branding escaped bereits. |
| SQL Injection | ausschließlich Prepared Statements. Dynamische Teile (Sortierfelder) nur über Allowlist. |
| Input Validation | zod-Schema für jeden Endpunkt: Body, Query, Params. Unbekannte Felder werden verworfen. |
| File Uploads | Allowlist (PDF, PNG, JPEG, WebP), Magic-Bytes-Prüfung, Größenlimit, Zufallsname, SHA-256, `Content-Disposition: attachment`, `nosniff` |
| Header | helmet: HSTS (Production), `frame-ancestors 'none'`, `Referrer-Policy: same-origin` |
| Secrets | nur ENV, `.env` gitignored, niemals im Audit Log oder System Log |
| Selbstgenehmigung | Wer einen Antrag stellt oder erstellt, darf ihn nicht selbst genehmigen oder signieren (Workflow-Regel `forbidSameActorAs`). |
| Delegation | kann nie mehr übertragen, als der Delegierende zum Nutzungszeitpunkt selbst hat. Compartments und Clearance sind **nicht** delegierbar. |
| Admin-Eskalation | Rollen, Permissions und Compartments darf nur vergeben, wer sie selbst im Scope besitzt. Niemand kann sich selbst Rechte geben. |
