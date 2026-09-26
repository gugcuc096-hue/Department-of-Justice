# PERMISSIONS – San Andreas Justice Command System

Stand: 2026-09-25 · Status: **freigegeben 2026-09-25**

Die Zugriffsentscheidung selbst ist in `SECURITY_MODEL.md` beschrieben. Dieses Dokument legt fest, **welche** Permissions es gibt, wie sie gebündelt werden und wer sie vergeben darf.

---

## 1. Begriffe

| Begriff | Bedeutung | Gewährt Zugriff? |
|---|---|---|
| **Organisation** | Knoten im Baum Institution → Office/Court → Division | nein |
| **Mitgliedschaft** | User ↔ Organisation (mehrere möglich), mit Rang und Vorgesetztem | nein |
| **Rang** | Hierarchiestufe innerhalb einer Organisation (Seed aus Prompt 3.2) | **nein** (höchstens Mindestvoraussetzung, Abschnitt 6) |
| **Rolle** | benanntes, administrierbares Bündel von Permissions | ja, im zugewiesenen Scope |
| **Scope** | Organisation, für die eine Rolle oder Permission gilt (inkl. Teilbaum). `NULL` = global | – |
| **Permission** | atomares Recht `BEREICH_AKTION` | ja, im Scope |
| **Clearance / Compartment** | siehe SECURITY_MODEL.md | notwendig, nicht hinreichend |
| **Objektzugang** | Case/Document Access, Participant usw. | notwendig für Objekte |

---

## 2. Permission-Katalog

Der Katalog umfasst die Startliste aus dem Prompt (5.2) plus Erweiterungen (**fett** markiert).

### Cases
`CASE_CREATE` · `CASE_VIEW` · `CASE_EDIT` · `CASE_CLOSE` · `CASE_ARCHIVE` · `CASE_SHARE` · `CASE_EXPORT` · **`CASE_VIEW_ORG`** (alle Cases im Org-Scope, Supervisor) · **`CASE_ASSIGN`** (Beteiligte und Bearbeiter zuweisen) · **`CASE_LINK`** · **`CASE_SEAL`** · **`CASE_UNSEAL`** · **`CASE_TRANSFER`** (an andere Org übergeben)

### Documents und Signaturen
`DOCUMENT_CREATE` · `DOCUMENT_VIEW` · `DOCUMENT_EDIT` · `DOCUMENT_DELETE` · `DOCUMENT_SIGN` · `DOCUMENT_APPROVE` · `DOCUMENT_REJECT` · `DOCUMENT_DOWNLOAD` · **`DOCUMENT_TEMPLATE_MANAGE`**

### Evidence
**`EVIDENCE_CREATE`** · **`EVIDENCE_VIEW`** · **`EVIDENCE_TRANSFER`** (Custody-Übergabe) · **`EVIDENCE_DISPOSE`**

### Anträge, Warrants, Entscheidungen
**`APPLICATION_CREATE`** · **`APPLICATION_SUBMIT`** · **`APPLICATION_REVIEW`** · **`APPLICATION_DECIDE`** · `WARRANT_CREATE` · `WARRANT_VIEW` · `WARRANT_REVIEW` · `WARRANT_APPROVE` · `WARRANT_DENY` · `WARRANT_SIGN` · `WARRANT_ISSUE` · **`WARRANT_EXECUTE`** (Vollstreckung dokumentieren) · **`WARRANT_RECALL`** · **`DECISION_CREATE`** · **`DECISION_SIGN`** · **`DECISION_PUBLISH`**

### Hearings und Deadlines
`HEARING_CREATE` · `HEARING_EDIT` · `HEARING_SCHEDULE` · `HEARING_CANCEL` · **`HEARING_PROTOCOL`** · **`DEADLINE_MANAGE`** · **`DEADLINE_EXTEND`**

### Kommunikation
**`MESSAGE_SEND`** · **`MESSAGE_DEPARTMENT`** (im Namen der Org schreiben) · **`REQUEST_CREATE`** · **`REQUEST_RESPOND`** · **`REQUEST_ASSIGN`**

### Personen und Unternehmen
**`PERSON_VIEW`** · **`PERSON_CREATE`** · **`PERSON_EDIT`** · **`COMPANY_VIEW`** · **`COMPANY_EDIT`**

### USMS
**`USMS_OPERATION_CREATE`** · **`USMS_OPERATION_APPROVE`** · **`USMS_OPERATION_VIEW`** · **`USMS_ARREST_RECORD`** · **`USMS_TRANSPORT_MANAGE`** · **`USMS_COURT_SECURITY_MANAGE`** · **`USMS_REPORT_CREATE`** · **`USMS_APPLICATION_REVIEW`** (Bewerbungen) · **`TASK_MANAGE`**

### SID
`SID_ACCESS` · `SID_RESTRICTED_ACCESS`. Beide berechtigen zur **Vergabe** des entsprechenden Compartments, der Zugriff selbst läuft über das Compartment.

### DCLI
`DCLI_LICENSE_CREATE` · `DCLI_LICENSE_REVIEW` · `DCLI_LICENSE_APPROVE` · `DCLI_LICENSE_REVOKE` · **`DCLI_LICENSE_SUSPEND`** · **`DCLI_LICENSE_VIEW`** · **`DCLI_INSPECTION_MANAGE`** · **`DCLI_INVESTIGATION`** · **`DCLI_FEE_MANAGE`**

### Registry
`REGISTRY_VIEW` · `REGISTRY_CREATE` · `REGISTRY_EDIT` · `REGISTRY_CERTIFICATE_ISSUE` · **`REGISTRY_APPLICATION_REVIEW`**

### US-SJA und Constitutional Court
`US_SJA_ACCESS` · `US_SJA_CLASSIFIED_ACCESS` (Vergabe der Compartments bzw. Zulassung zu `CLASSIFIED`) · `CONSTITUTIONAL_REVIEW_CREATE` · `CONSTITUTIONAL_REVIEW_VIEW` · `CONSTITUTIONAL_DECISION_SIGN`

### Administration
`USER_VIEW` · `USER_CREATE` · `USER_EDIT` · `USER_DISABLE` · `ROLE_ASSIGN` · `PERMISSION_ASSIGN` · **`ORG_MANAGE`** · **`RANK_MANAGE`** · **`ROLE_MANAGE`** · **`CLEARANCE_ASSIGN`** · **`COMPARTMENT_ASSIGN`** · **`DELEGATION_APPROVE`** · **`CONFIG_MANAGE`** (Case/Document Types, Workflows, Security Levels, Notification Types) · **`FEATURE_TOGGLE`** (Legal-Basis-Schalter) · **`BRANDING_MANAGE`** · `AUDIT_VIEW` · `AUDIT_EXPORT` · **`REPORT_VIEW`** · **`REPORT_EXPORT`**

---

## 3. Admin-Ebenen (Prompt 5.9)

Alle Admin-Ebenen sind Rollen mit Scope. Die Ebene ergibt sich aus dem Scope.

| Admin-Ebene | Rolle | Scope | Kerninhalt |
|---|---|---|---|
| SYSTEM ADMIN | `SYSTEM_ADMIN` | global | `ORG_MANAGE`, `CONFIG_MANAGE`, `FEATURE_TOGGLE`, `BRANDING_MANAGE`, User-Verwaltung global. **Kein** Akteninhalt, **keine** Compartments. |
| ORGANIZATION ADMIN | `ORG_ADMIN` | Institution (z. B. Judiciary) | User, Ränge, Rollenvergabe im Teilbaum |
| DEPARTMENT ADMIN | `ORG_ADMIN` | Office/Court (z. B. District Court) | wie oben, kleinerer Teilbaum |
| OFFICE ADMIN | `ORG_ADMIN` | Division | wie oben |
| SECURITY ADMIN | `SECURITY_ADMIN` | Org | `CLEARANCE_ASSIGN`, `COMPARTMENT_ASSIGN` (nur Compartments, die er selbst hat), `DELEGATION_APPROVE` |
| AUDIT ADMIN | `AUDIT_ADMIN` | Org | `AUDIT_VIEW`, `AUDIT_EXPORT` (Level- und Compartment-Regel gilt weiter) |

**Vergaberegeln (umgesetzt in `src/core/admin/users.js`):**
1. **Rollen:** `ROLE_ASSIGN` im Ziel-Scope. Rollen ohne Scope (global) nur mit globalem `ROLE_ASSIGN`. Der Empfänger muss Mitglied im Scope oder einer Untereinheit sein. Der Vergebende muss die Rechte der Rolle **nicht** selbst besitzen, sonst könnte kein Admin je eine Richterrolle vergeben. Die Begrenzung ergibt sich aus dem Scope.
2. **Direkte Permissions:** `PERMISSION_ASSIGN` im Ziel-Scope **und** die Permission selbst im Ziel-Scope (keine Eskalation).
3. **Clearance:** `CLEARANCE_ASSIGN` für alle Mitgliedschaften des Ziels, höchstens die eigene Clearance.
4. **Compartments:** `COMPARTMENT_ASSIGN` im Scope der besitzenden Organisation **und** das Compartment selbst halten. Ausnahme ist die Erstvergabe, solange es niemand hält (Bootstrap). Der Empfänger braucht die fachliche Voraussetzung (`SID` → `SID_ACCESS`, `SID_RESTRICTED` → `SID_RESTRICTED_ACCESS`, `REGISTRY` → `REGISTRY_VIEW`, `USSJA` → `US_SJA_ACCESS`).
5. **Benutzerweite Änderungen** (Status, Clearance, Passwort-Reset, Stammdaten) verlangen die Permission für **alle** Mitgliedschaften des Ziels. Mitgliedschafts- und Rollenänderungen verlangen sie nur für die betroffene Organisation.
6. Niemand ändert die eigenen Rechte, die eigene Clearance, die eigenen Compartments, Mitgliedschaften oder den eigenen Status.
7. Alle Vergaben werden mit Begründung auditiert.

**Vertrauensgrenze:** Ein System Admin kann Rollen vergeben, also auch einem anderen Konto Richterrechte geben. Er kann sich aber nicht selbst berechtigen, und jede Vergabe steht im Audit Log. Compartments kann er nach der Erstvergabe nicht mehr vergeben.

---

## 4. Funktionale Standardrollen (Seed, administrierbar)

Die Rollen sind **Vorschläge** für den Seed. Rollen sind Systemkonstrukte und keine Ränge. Welche Rolle ein User bekommt, entscheidet ein Admin. Der Rang ist dabei nur Orientierung.

| Rolle | typischer Scope | Permissions (Auszug) |
|---|---|---|
| `USMS_DEPUTY` | USMS | CASE_CREATE/VIEW/EDIT, DOCUMENT_CREATE/VIEW/EDIT, EVIDENCE_*, USMS_OPERATION_VIEW, USMS_ARREST_RECORD, USMS_REPORT_CREATE, WARRANT_VIEW, WARRANT_EXECUTE, MESSAGE_SEND, PERSON_VIEW |
| `USMS_SUPERVISOR` | USMS | + CASE_VIEW_ORG, CASE_ASSIGN, USMS_OPERATION_CREATE/APPROVE, USMS_TRANSPORT_MANAGE, USMS_COURT_SECURITY_MANAGE, TASK_MANAGE, REQUEST_CREATE/RESPOND |
| `USMS_RECRUITER` | USMS | USMS_APPLICATION_REVIEW |
| `PROSECUTOR` | DA / SA / AG | CASE_CREATE/VIEW/EDIT/CLOSE, DOCUMENT_*, EVIDENCE_VIEW, APPLICATION_CREATE/SUBMIT, WARRANT_CREATE/VIEW, HEARING_*(Teilnahme), REQUEST_CREATE, PERSON_VIEW/CREATE |
| `PROSECUTION_SUPERVISOR` | DA / SA / AG | + CASE_VIEW_ORG, CASE_ASSIGN, CASE_TRANSFER, DOCUMENT_APPROVE, REQUEST_ASSIGN |
| `SID_INVESTIGATOR` | SID | Case-/Document-/Evidence-Rechte im SID-Scope. Das Compartment `SID` wird separat vergeben. |
| `DCLI_OFFICER` | DCLI | DCLI_LICENSE_VIEW/CREATE/REVIEW, DCLI_INSPECTION_MANAGE, DCLI_INVESTIGATION, COMPANY_VIEW/EDIT |
| `DCLI_SUPERVISOR` | DCLI | + DCLI_LICENSE_APPROVE/SUSPEND/REVOKE, DCLI_FEE_MANAGE, CASE_VIEW_ORG |
| `JUDGE` | DC / CoA / SC | CASE_VIEW, APPLICATION_REVIEW/DECIDE, WARRANT_REVIEW/APPROVE/DENY/SIGN/ISSUE, DECISION_CREATE/SIGN, HEARING_*, DOCUMENT_SIGN, CASE_SEAL |
| `COURT_ADMINISTRATION` | DC / CoA / SC | CASE_VIEW_ORG, CASE_ASSIGN (Geschäftsverteilung), HEARING_SCHEDULE, DEADLINE_MANAGE |
| `COURT_CLERK` | Court | HEARING_PROTOCOL, DOCUMENT_CREATE, DEADLINE_MANAGE. **Kein** Entscheidungsrecht. (Die Vorlage nennt einen „Schriftführer“, der Rang selbst ist nicht definiert.) |
| `REGISTRAR` | Registry | REGISTRY_VIEW/CREATE/EDIT, REGISTRY_APPLICATION_REVIEW, REGISTRY_CERTIFICATE_ISSUE. Das Compartment `REGISTRY` wird separat vergeben. |
| `USSJA_MEMBER` | US-SJA | JUDGE-Rechte im US-SJA-Scope. Das Compartment `USSJA` wird separat vergeben. |
| `CONSTITUTIONAL_JUDGE` | Constitutional Court | CONSTITUTIONAL_REVIEW_VIEW, CONSTITUTIONAL_DECISION_SIGN. **Deaktiviert**, bis die Verfassung geprüft ist. |

---

## 5. Sichtbarkeit innerhalb des eigenen Office (entschieden, F9)

**Grundsatz:** Alle Mitglieder des besitzenden Office mit `CASE_VIEW` sehen dessen Akten. Umgesetzt wird das über `default_org_access = 1`. Bei Anlage bekommt die besitzende Org einen `case_access`-Eintrag (ORG, VIEW), bei Übergabe (`CASE_TRANSFER`) wandert er mit.

Grenzen:
- nur das **besitzende Office** (inkl. Unter-Divisionen), nicht die übergeordnete Institution und nicht Nachbar-Offices
- **versiegelte** Akten und Profile mit `requires_explicit_access` (`SID_RESTRICTED`, `USSJA_RESTRICTED`) nur für ausdrücklich Beteiligte
- Security Level und Compartments gelten immer zusätzlich
- Bearbeiten (`CASE_EDIT`) verlangt die Beteiligung an der Akte oder `CASE_ASSIGN`. Sehen ist office-weit, Bearbeiten nicht (siehe `edit_scope`).

| Case Type | besitzendes Office | `default_org_access` | `edit_scope` |
|---|---|---|---|
| `USMS_OPERATION` | USMS | ja | Beteiligte + Supervisor |
| `CRIMINAL`, `CIVIL` (Prosecution) | DA / SA / AG | ja | Beteiligte + Supervisor |
| `CRIMINAL`, `CIVIL`, `WARRANT`, `SUBPOENA` (Gericht) | District Court | ja | Beteiligte (zugewiesene Richter) + Court Administration |
| `APPEAL` | Court of Appeals | ja | wie oben |
| `SUPREME_COURT` | Supreme Court | ja | wie oben |
| `SID_INVESTIGATION` | SID | ja, zusätzlich mit Compartment `SID` | Beteiligte + Supervisor |
| `DCLI_INVESTIGATION`, `LICENSING` | DCLI | ja | Beteiligte + Supervisor |
| `REGISTRY` | Registry Office | ja, zusätzlich mit Compartment `REGISTRY` | Registrars |
| `US_SJA` | US-SJA | ja, zusätzlich mit Compartment `USSJA` | Beteiligte |
| `CONSTITUTIONAL` | Constitutional Court | ja | deaktiviert bis zur Verfassungsprüfung |

`CASE_VIEW_ORG` bleibt für **übergeordnete** Scopes (z. B. ein Admin-Supervisor der Prosecution über alle drei Offices) und gilt nie für versiegelte oder explizit geschützte Akten.

---

## 6. Rang als Mindestvoraussetzung (optional)

Tabelle `permission_rank_requirements (permission, org_id, min_rank_level)`. Beispiel, **nicht** vorkonfiguriert:

```text
WARRANT_SIGN @ District Court  → min. Judge   (Probationary Judge ausgeschlossen)
```

Ob solche Regeln gelten, entscheidet der Auftraggeber. Sie werden nicht ohne Vorgabe gesetzt, weil das eine erfundene Befugnis wäre.

---

## 7. Autorisierungs-Testmatrix (Mindestumfang)

| # | Subjekt | Aktion | Erwartung |
|---|---|---|---|
| A1 | Probationary Prosecutor ohne Zuweisung | `GET /api/cases/:restrictedCourtCase` | 404 |
| A2 | Judge, dem der Case zugewiesen ist | `GET /api/cases/:courtCase` | 200 |
| A3 | Judge, nicht zugewiesen, gleicher Court | `GET` / `PATCH` | 200 / 403 (sehen ja, bearbeiten nein) |
| A3b | Judge des District Court | Case des Court of Appeals | 404 |
| A3c | DA-Prosecutor | Akte des AG-Office | 404 |
| A4 | DCLI Officer | fremder Prosecution-Case | 404 |
| A5 | Prosecutor ohne Compartment SID | SID-Case über Detail, Liste, Suche, Link | unsichtbar |
| A6 | Court User ohne REGISTRY | Registry Record | 404 |
| A7 | US-SJA-Mitglied mit Compartment | US-SJA-Case | 200 |
| A8 | Chief Justice **ohne** Compartment USSJA | US-SJA-Case | 404, auch in Suche, Zählern, Notifications, Links |
| A9 | System Admin | beliebiger Case ohne Zuweisung | 404 |
| A10 | beliebiger User | ausgeblendeter Button, API direkt aufgerufen | 403/404 |
| A11 | Antragsteller | eigenen Antrag genehmigen | 403 |
| A12 | Supervisor mit CASE_VIEW_ORG | versiegelter Case im eigenen Office | 404 |
| A13 | Org Admin | sich selbst eine Rolle geben | 403 |
| A14 | Security Admin ohne USSJA | Compartment USSJA vergeben | 403 |
| A15 | Delegation abgelaufen | delegierte Aktion | 403 |
| A16 | User nach Deaktivierung | laufende Session | 401 |
| A17 | Auditor ohne USSJA | Audit-Einträge zu US-SJA | nicht enthalten |
| A18 | Parität (alle User × alle Cases) | `list` vs. `can` | identisch |
