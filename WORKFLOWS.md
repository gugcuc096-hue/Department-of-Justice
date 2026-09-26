# WORKFLOWS – San Andreas Justice Command System

Stand: 2026-09-25 · Status: **freigegeben 2026-09-25**

Alle Workflows sind **Daten** (`workflow_definitions`), kein fest verdrahteter Code, und damit administrierbar (Prompt 6.5). Die hier beschriebenen Definitionen sind der Seed. Rechtliche Grundlagen: alle `NOT VERIFIED` (siehe `LEGAL_AUTHORITY_MATRIX.md`).

---

## 1. Workflow-Engine

**Definition (JSON):**

```json
{
  "code": "WARRANT_APPLICATION",
  "version": 1,
  "initial": "DRAFT",
  "states": { "DRAFT": {}, "SUBMITTED": {}, "…": {}, "CLOSED": { "final": true } },
  "transitions": [
    {
      "action": "approve",
      "from": ["UNDER_REVIEW"],
      "to": "APPROVED",
      "permission": "WARRANT_APPROVE",
      "actor": "assignedJudge",
      "humanDecision": true,
      "requireComment": false,
      "forbidSameActorAs": ["applicant"],
      "effects": ["notify:applicant", "timeline"]
    }
  ]
}
```

**Regeln der Engine:**
1. Ein Übergang ist nur erlaubt, wenn `from` passt, `can(user, permission, subject)` wahr ist und die Akteursregel (`actor`) erfüllt ist.
2. `humanDecision: true` bedeutet, dass der Übergang nur durch eine ausdrückliche Benutzeraktion ausgelöst wird: nie durch Timer, Automatik oder als Folge-Effekt (Prompt 7.5).
3. `forbidSameActorAs` verhindert Selbstgenehmigung.
4. Jeder Übergang schreibt in **einer Transaktion**: Zustand, `workflow_actions` 🔒, `case_events` 🔒, `audit_log` 🔒, Notifications und Suchindex.
5. Laufende Instanzen behalten ihre Definitionsversion. Neue Versionen gelten nur für neue Instanzen.
6. Automatische Übergänge sind nur für **nicht-rechtliche** Zustände erlaubt (z. B. `ACTIVE → EXPIRED` bei Ablauf einer Lizenz, `OPEN → OVERDUE` bei Fristen). Sie werden als Actor `SYSTEM` auditiert.
7. Unbekannte Aktion oder unzulässiger Zustand ergibt `409 Conflict` ohne Seiteneffekt.

---

## 2. Case-Lebenszyklus (generisch)

```text
OPEN ──► ACTIVE ──► CLOSED ──► ARCHIVED
  │         │          │
  │         └─(reopen, CASE_EDIT + Begründung)◄─┘
  └── seal / unseal (CASE_SEAL / CASE_UNSEAL, Begründung, jederzeit außer ARCHIVED)
```

## 3. Gerichtlicher Antrag (generisch, Prompt 6.5)

```text
DRAFT ──submit──► SUBMITTED ──accept──► UNDER_REVIEW ──┬─approve*──► APPROVED ──sign*──► SIGNED ──issue*──► ISSUED ──► EXECUTED ──► CLOSED
  ▲                   │                      │          ├─deny*─────► DENIED ─────────────────────────────────────────────► CLOSED
  │                   └─withdraw─► WITHDRAWN │          └─request_revision*─► REVISION_REQUESTED ──resubmit──┐
  └──────────────────────────────────────────┴────────────────────────────────────────────────────────────────┘
* = humanDecision (Richter)
```

| Übergang | Actor | Permission |
|---|---|---|
| submit / resubmit / withdraw | Antragsteller | APPLICATION_SUBMIT |
| accept (Eingang, Richterzuweisung) | Court Administration | CASE_ASSIGN |
| approve / deny / request_revision | zugewiesener Richter | APPLICATION_DECIDE |
| sign | zugewiesener Richter | DOCUMENT_SIGN |
| issue | zugewiesener Richter oder Court Administration | APPLICATION_DECIDE |

Nicht jeder Antragstyp nutzt alle Zustände. Zum Beispiel hat ein Antrag ohne Vollstreckung kein `EXECUTED`.

## 4. Haftbefehl und Durchsuchungsbeschluss (Cross-Department, Prompt 6.5)

```text
PROSECUTION                    DISTRICT COURT                          USMS / ausführende Behörde
───────────                    ──────────────                          ──────────────────────────
Case anlegen
Antrag (DRAFT)
  └─submit──────────────────►  SUBMITTED
                               accept → Richter zugewiesen
                               UNDER_REVIEW
                               approve* / deny* / request_revision*
                                 │ approve
                               Beschluss aus Vorlage erzeugt
                               sign* (Signatur an Version + Hash)
                               issue* → Warrant ISSUED ──────────────► Warrant sichtbar für executing_org
                                                                        (Zugriff nur auf Warrant + Minimum)
                                                                       IN_EXECUTION (Operation optional)
                                                                       EXECUTED → Execution Report (Dokument)
                               ◄───────────────────────────────────── RETURNED (Report an Gericht)
                               CLOSED
◄── Benachrichtigung bei jedem Schritt (nur an Berechtigte)
```

**Zugriffsregeln im Ablauf:**
- Mit `submit` erhält das Zielgericht per `case_access` (ORG, VIEW) Zugriff auf den Antrag und die ausdrücklich beigefügten Dokumente, **nicht** automatisch auf die gesamte Prosecution-Akte.
- Mit `issue` erhält die ausführende Behörde Zugriff auf den Warrant und dessen Dokument, nicht auf die Gerichts- oder Prosecution-Akte.
- Das Gericht legt eine **eigene** Gerichtsakte an (`DC-CR-…`), die per `case_links` (`ORIGINATED_FROM`) mit der Prosecution-Akte verbunden wird.

**Warrant-Status:** `ISSUED → IN_EXECUTION → EXECUTED → RETURNED`. Zusätzlich `RECALLED` (Richter, WARRANT_RECALL, humanDecision) und `EXPIRED` (automatisch, **nur** wenn eine Gültigkeitsdauer konfiguriert ist, andernfalls nie).

## 5. Rechtsmittelkette

```text
District Court Case ──appeal filed──► Court of Appeals Case (APPEAL_OF) ──► Supreme Court Case (REVIEW_OF)
```

Zustände für Appeal- und Supreme-Court-Verfahren (generisch, NOT VERIFIED):

```text
FILED → UNDER_REVIEW → HEARING_SCHEDULED → DECIDED* → CLOSED
                   └──► DISMISSED* → CLOSED
```

- Panels: `case_participants` mit Rolle `JUDGE` und Kennzeichnung `presiding`.
- Fristen, Zulässigkeitsprüfung und weitere Stufen werden erst mit den Rechtsquellen ergänzt.

## 6. DCLI-Lizenz (Prompt 4.4)

**Antrag:**

```text
DRAFT → SUBMITTED → UNDER_REVIEW ⇄ ADDITIONAL_INFORMATION_REQUESTED
                         ├─approve* → APPROVED → issue → ISSUED (Lizenz angelegt)
                         └─deny* → DENIED
```

**Lizenz:**

```text
ISSUED → ACTIVE ⇄ SUSPENDED*
            ├─revoke* → REVOKED
            ├─(automatisch bei valid_until) → EXPIRED
            └─renew → neuer Antrag (RENEWAL), verknüpft
```

Permissions: review (DCLI_LICENSE_REVIEW), approve und deny (DCLI_LICENSE_APPROVE), suspend (DCLI_LICENSE_SUSPEND), revoke (DCLI_LICENSE_REVOKE). Revoke und suspend verlangen eine Begründung.

## 7. Registry-Antrag

```text
DRAFT → SUBMITTED → UNDER_REVIEW ⇄ ADDITIONAL_INFORMATION_REQUESTED
                         ├─approve* → REGISTERED (Record angelegt) → certificate issued (REGISTRY_CERTIFICATE_ISSUE)
                         └─deny* → DENIED
```

**Adoptionen:** Die Plattform genehmigt **keine** Adoption selbst. Ob eine gerichtliche Entscheidung vorausgesetzt ist, klären die Rechtsquellen. Bis dahin ist der Adoptionsantrag konfigurierbar mit einem Court Case verknüpfbar, und `approve` verlangt die Angabe der zugrunde liegenden Entscheidung (Feld, keine Automatik).

## 8. Official Request (Prompt 6.7)

```text
OPEN → ASSIGNED → IN_PROGRESS → ANSWERED → CLOSED
  └────────────── DECLINED (Begründung) ──► CLOSED
```

Sender-Org und Empfänger-Org sehen den Request. Beigefügte Dokumente sind für die Empfänger-Org nur über den Request sichtbar.

## 9. USMS-Operation

```text
PLANNED → APPROVED* (USMS_OPERATION_APPROVE) → ACTIVE → COMPLETED → CLOSED
    └──────────────────────────────── CANCELLED
```

After-Action-Report als Dokument (`afterAction`, bestehender Branding-Dokumenttyp).

## 10. USMS-Bewerbung

```text
RECEIVED → IN_REVIEW → INTERVIEW → ACCEPTED* / REJECTED*
```

Bei `ACCEPTED` wird **kein** User automatisch angelegt. Ein Admin legt ihn bewusst an und verknüpft die Bewerbung.

## 11. Evidence Custody (kein Zustandsautomat, Protokoll)

```text
Holder A: transfer initiieren (to, location, reason) → IN_TRANSFER
Holder B: Empfang bestätigen → Custody-Eintrag abgeschlossen, current_holder = B
Holder B: ablehnen → zurück an A, Eintrag mit Ablehnung
```

## 12. US-SJA-Verfahren

Generischer gerichtlicher Antrag (Abschnitt 3) im US-SJA-Scope, mit:
- Security Profile `USSJA` bis `USSJA_CLASSIFIED`
- Notifications immer generisch
- keine Verknüpfung zu normalen Akten, die für Nicht-Mitglieder sichtbar wäre (SECURITY_MODEL.md, Abschnitt 7)

## 13. Constitutional Review

**Deaktiviert** (`feature_flags.CONSTITUTIONAL_REVIEW = false`), bis Zusammensetzung und Zuständigkeiten aus der ModernV-Verfassung belegt sind. Die technische Grundlage (Case Type, Workflow-Hülle `FILED → UNDER_REVIEW → DECIDED* → CLOSED`) wird gebaut, aber nicht freigeschaltet.
