# LEGAL_AUTHORITY_MATRIX – San Andreas Justice Command System

Stand: 2026-09-25 · Status: **Rechtsquellen noch nicht bereitgestellt. Alle Einträge `NOT VERIFIED`.**

Die ModernV-Rechtsquellen werden später geliefert (Prompt 0.2). Bis dahin gilt:

- **Anforderungsquelle** ist die Spezifikation des Auftraggebers (`prompt.txt`, Abschnitt angegeben). Sie belegt, **dass** eine Funktion gewünscht ist, aber keine Rechtsgrundlage.
- **Legal Basis** bleibt `NOT VERIFIED`. Es werden keine Paragraphen eingetragen, bevor sie geprüft sind.
- **Status**:
  - `ENABLED · NOT VERIFIED`: gebaut und aktiv, in der UI mit dem Hinweis „Legal basis not verified“ gekennzeichnet. Permissions konfigurierbar.
  - `DISABLED · NOT VERIFIED`: gebaut, aber per Feature Flag aus, weil schon die Existenz oder Zuständigkeit ungeklärt ist.

Legende Human Decision: **YES** heißt, der Zustandswechsel geschieht nur durch eine ausdrückliche Handlung einer zuständigen Person.

---

## Matrix

| Institution | Funktion | Anforderung (Prompt) | Legal Basis | Permission | Workflow | Human Decision | Status |
|---|---|---|---|---|---|---|---|
| District Court | Haftbefehl prüfen, erlassen, ablehnen | 4.5, 6.5 | NOT VERIFIED (zu prüfen: StPO) | WARRANT_REVIEW / APPROVE / DENY / SIGN / ISSUE | WARRANT_APPLICATION | YES | ENABLED · NOT VERIFIED |
| District Court | Durchsuchungsbeschluss | 4.5, 8.4 | NOT VERIFIED (StPO) | wie oben | WARRANT_APPLICATION | YES | ENABLED · NOT VERIFIED |
| District Court | Vorladung (Subpoena) | 4.5 | NOT VERIFIED (StPO/Gerichtsordnung) | APPLICATION_DECIDE | COURT_APPLICATION | YES | ENABLED · NOT VERIFIED |
| District Court | Beschlüsse, Urteile (Straf- und Zivilsachen) | 4.5 | NOT VERIFIED (StPO, BGB, Gerichtsordnung) | DECISION_CREATE / SIGN | Case | YES | ENABLED · NOT VERIFIED |
| District Court | Anhörungen / Sitzungen | 4.5, 6.6 | NOT VERIFIED (Gerichtsordnung) | HEARING_* | – | YES (Terminierung) | ENABLED · NOT VERIFIED |
| Gerichte (alle) | Versiegeln / Entsiegeln | 5.7 | NOT VERIFIED | CASE_SEAL / UNSEAL | – | YES | ENABLED · NOT VERIFIED |
| Court of Appeals | Berufung / Appeal entscheiden | 4.6 | NOT VERIFIED (Verfassung, Gerichtsordnung) | DECISION_CREATE / SIGN | APPEAL | YES | ENABLED · NOT VERIFIED |
| Supreme Court | Revision / Review, Opinions | 4.7 | NOT VERIFIED (Verfassung) | DECISION_CREATE / SIGN | APPEAL | YES | ENABLED · NOT VERIFIED |
| US-SJA | geheime Anträge, Verfahren, Entscheidungen | 4.9 | NOT VERIFIED (Verfassung) | JUDGE-Rechte im US-SJA-Scope + Compartment USSJA | COURT_APPLICATION | YES | ENABLED · NOT VERIFIED |
| Constitutional Court | Constitutional Review, Gesetzes- und Entwurfsprüfung, Beschwerden, Organstreit | 4.10 | NOT VERIFIED (Verfassung). **Zusammensetzung und Ränge unbekannt.** | CONSTITUTIONAL_* | CONSTITUTIONAL | YES | **DISABLED** · NOT VERIFIED |
| Registry Office | Geburt, Ehe, Scheidung registrieren | 4.8 | NOT VERIFIED (BGB?) | REGISTRY_CREATE / EDIT | REGISTRY_APPLICATION | YES | ENABLED · NOT VERIFIED |
| Registry Office | Adoption registrieren | 4.8 | NOT VERIFIED (gerichtliche Entscheidung nötig?) | REGISTRY_CREATE | REGISTRY_APPLICATION | YES | ENABLED · NOT VERIFIED |
| Registry Office | Urkunden ausstellen | 4.8 | NOT VERIFIED | REGISTRY_CERTIFICATE_ISSUE | – | YES | ENABLED · NOT VERIFIED |
| DA / SA / AG | Anträge an Gerichte stellen | 4.2, 6.5 | NOT VERIFIED (StPO) | APPLICATION_CREATE / SUBMIT | COURT_APPLICATION | YES | ENABLED · NOT VERIFIED |
| DA / SA / AG | Zuständigkeitsabgrenzung zwischen den drei Offices | 4.2 | NOT VERIFIED. **Unbekannt**, bis dahin keine technische Einschränkung, Zuweisung manuell. | CASE_TRANSFER | – | YES | ENABLED · NOT VERIFIED |
| SID | Ermittlungsbefugnisse, Zwangsmaßnahmen | 4.3 | NOT VERIFIED. **Nicht aus dem Namen ableiten.** | SID-Scope + Compartment | – | YES | Aktenführung ENABLED. Eigene Zwangsmaßnahmen **DISABLED**, Anträge nur über Gericht. |
| DCLI | Gewerbe- und Rohstofflizenzen erteilen, versagen | 4.4 | NOT VERIFIED (Gewerbeordnung, Wirtschaftsgesetz) | DCLI_LICENSE_APPROVE | LICENSE_APPLICATION | YES | ENABLED · NOT VERIFIED |
| DCLI | Lizenz aussetzen, widerrufen | 4.4 | NOT VERIFIED (GewO) | DCLI_LICENSE_SUSPEND / REVOKE | LICENSE | YES | ENABLED · NOT VERIFIED |
| DCLI | Kontrollen, Prüfungen, gewerbliche Ermittlungen | 4.4 | NOT VERIFIED (GewO, WirtschaftsG) | DCLI_INSPECTION_MANAGE / DCLI_INVESTIGATION | – | YES | ENABLED · NOT VERIFIED |
| DCLI | Gebühren | 4.4 | NOT VERIFIED. **Beträge nicht erfinden**, Standard leer. | DCLI_FEE_MANAGE | – | YES | ENABLED · NOT VERIFIED |
| USMS | Haftbefehle vollstrecken | 4.1, 6.5 | NOT VERIFIED (StPO, Landespolizeigesetz?) | WARRANT_EXECUTE | WARRANT | YES | ENABLED · NOT VERIFIED |
| USMS | Festnahmen, Gefangenentransport, Court Security | 4.1 | NOT VERIFIED | USMS_* | – | YES | ENABLED · NOT VERIFIED |
| Alle | Fristen (Dauer) | 6.6 | NOT VERIFIED. **Keine Standardfristen**, nur manuell gesetzte. | DEADLINE_MANAGE | – | YES | ENABLED · NOT VERIFIED |
| Alle | Aufbewahrungsfristen | 6.12 | NOT VERIFIED. Standard: unbegrenzt, konfigurierbar. | CONFIG_MANAGE | – | – | ENABLED · NOT VERIFIED |
| Warrants | Gültigkeitsdauer / Ablauf | – | NOT VERIFIED. Standard: kein automatischer Ablauf. | CONFIG_MANAGE | WARRANT | – | ENABLED · NOT VERIFIED |

---

## Nachzuziehen, sobald die Rechtsquellen vorliegen

1. Jede Zeile gegen die Quelle prüfen: Norm eintragen (Gesetz, §, Abs.) oder `NOT FOUND` setzen.
2. Bei `NOT FOUND`: Funktion auf `DISABLED` setzen oder als rein organisatorisch kennzeichnen, nach Rücksprache.
3. Constitutional Court: Zusammensetzung, Ränge und Verfahrensarten aus der Verfassung übernehmen, dann freischalten.
4. SID: Befugnisse belegen, dann gegebenenfalls eigene Maßnahmen freischalten.
5. Fristen, Gültigkeitsdauern und Gebühren aus den Quellen als konfigurierte Werte übernehmen.
6. Legal Reference UI (Prompt 7.4) mit den geprüften Normen befüllen.
