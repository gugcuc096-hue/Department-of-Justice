# DATA_MODEL – San Andreas Justice Command System

Stand: 2026-09-25 · Status: **freigegeben 2026-09-25** · DB: SQLite (`node:sqlite`), WAL, `foreign_keys=ON`

Konventionen:
- `id INTEGER PRIMARY KEY`
- Zeitstempel als ISO-8601-UTC-Text (`created_at`, `updated_at`)
- `is_demo INTEGER NOT NULL DEFAULT 0` auf allen fachlichen Haupttabellen (Prompt 8.5, Anzeige als `DEMO`)
- Soft-Delete nur, wo fachlich nötig (`archived_at`). Append-only-Tabellen sind mit 🔒 markiert (Trigger gegen UPDATE/DELETE).

---

## 1. Organisation, Benutzer, Rechte

| Tabelle | Wichtige Spalten | Anmerkung |
|---|---|---|
| `organizations` | `parent_id`, `kind` (`PLATFORM`,`INSTITUTION`,`OFFICE`,`COURT`,`DIVISION`,`AUTHORITY`), `code` UNIQUE, `name`, `short_name`, `brand_code`, `is_active` | **ein** Baum statt getrennter Tabellen `departments`/`offices`/`divisions` (ADR-005) |
| `ranks` | `org_id`, `code`, `name`, `level` (höher = höherer Rang), `is_active` | Rangfolge pro Organisation |
| `roles` | `code` UNIQUE, `name`, `description`, `is_system` | |
| `permissions` | `code` PK, `category`, `description` | Katalog aus PERMISSIONS.md |
| `role_permissions` | `role_id`, `permission_code` | |
| `users` | `username` UNIQUE, `display_name`, `badge_no`, `password_hash`, `must_change_password`, `status` (`ACTIVE`,`DISABLED`,`PENDING`), `clearance_level`, `contact`, `last_login_at` | |
| `memberships` | `user_id`, `org_id`, `rank_id`, `supervisor_user_id`, `is_primary`, `starts_at`, `ends_at` | User kann mehreren Orgs angehören |
| `user_roles` | `user_id`, `role_id`, `scope_org_id` (NULL = global), `granted_by`, `granted_at`, `reason` | |
| `user_permissions` | `user_id`, `permission_code`, `scope_org_id`, `granted_by`, `reason`, `expires_at` | Direktgrants |
| `permission_rank_requirements` | `permission_code`, `org_id`, `min_rank_level` | optional, leer im Seed |
| `security_levels` | `code` PK, `rank`, `name` | |
| `compartments` | `code` PK, `name`, `owner_org_id` | |
| `security_profiles` | `code` PK, `level_code`, `compartments` (JSON), `requires_explicit_access` | z. B. `USSJA_RESTRICTED` |
| `user_compartments` | `user_id`, `compartment_code`, `granted_by`, `granted_at`, `expires_at`, `reason` | |
| `delegations` | `from_user_id`, `to_user_id`, `permission_code`, `scope_org_id`, `case_id` NULL, `starts_at`, `ends_at`, `reason`, `approved_by`, `status`, `revoked_at` | |
| `sessions` | `token_hash` PK, `user_id`, `csrf_token`, `active_org_id`, `created_at`, `last_seen_at`, `expires_at`, `ip`, `user_agent` | |

## 2. Cases

| Tabelle | Wichtige Spalten | Anmerkung |
|---|---|---|
| `case_types` | `code` PK, `name`, `owner_org_kind`, `number_prefix`, `default_security_profile`, `default_org_access`, `edit_scope` (`PARTICIPANTS`,`PARTICIPANTS_AND_SUPERVISORS`), `workflow_code`, `legal_status` (`VERIFIED`,`NOT_VERIFIED`), `is_enabled` | konfigurierbar |
| `cases` | `case_number` UNIQUE, `type_code`, `title`, `summary`, `owning_org_id`, `security_level`, `requires_explicit_access`, `is_sealed`, `status`, `created_by`, `closed_at`, `archived_at` | |
| `case_compartments` | `case_id`, `compartment_code` | |
| `case_participants` | `case_id`, `user_id` NULL, `person_id` NULL, `org_id` NULL, `role` (`JUDGE`,`PROSECUTOR`,`INVESTIGATOR`,`DEFENDANT`,`PLAINTIFF`,`COUNSEL`,`WITNESS`,`CLERK`,`DEPUTY`, …), `grants_access`, `sealed_access`, `added_by` | |
| `case_access` | `case_id`, `subject_type` (`USER`,`ROLE`,`ORG`), `subject_id`, `level` (`VIEW`,`EDIT`,`MANAGE`), `granted_by`, `reason`, `expires_at`, `revoked_at` | |
| `case_events` 🔒 | `case_id`, `type`, `actor_user_id`, `payload` JSON, `created_at` | Timeline |
| `case_links` | `from_case_id`, `to_case_id`, `link_type` (`ESCALATED_TO`,`APPEAL_OF`,`REVIEW_OF`,`RELATED`,`ORIGINATED_FROM`), `created_by` | Link gewährt keinen Zugriff |
| `number_sequences` | `prefix`, `year`, `last_value` (PK `prefix,year`) | Vergabe in Transaktion |

## 3. Dokumente, Signaturen, Dateien

| Tabelle | Wichtige Spalten | Anmerkung |
|---|---|---|
| `document_types` | `code` PK, `name`, `issuer_brand_code`, `template_id`, `number_prefix`, `sign_permission`, `legal_status` | |
| `document_templates` | `code`, `version`, `body` (HTML mit Platzhaltern), `is_active` | aus den Vorlagen des Auftraggebers |
| `documents` | `doc_number`, `type_code`, `case_id` NULL, `title`, `owning_org_id`, `security_level`, `is_sealed`, `status` (`DRAFT`,`IN_REVIEW`,`APPROVED`,`SIGNED`,`ISSUED`,`ARCHIVED`), `current_version`, `created_by` | |
| `document_compartments` | `document_id`, `compartment_code` | |
| `document_versions` 🔒 | `document_id`, `version`, `content` (strukturiertes JSON und gerendertes HTML), `file_id` NULL, `sha256`, `created_by`, `created_at` | unveränderlich |
| `document_access` | wie `case_access`, für Dokumente ohne Case oder mit zusätzlicher Einschränkung | |
| `document_signatures` 🔒 | `document_id`, `version`, `sha256`, `signer_user_id`, `signer_name`, `signer_rank`, `signer_org`, `signed_at`, `capacity` (z. B. „Issuing judge“), `status` | Name, Rang und Org als **Snapshot** |
| `signature_revocations` 🔒 | `signature_id`, `reason`, `revoked_by`, `revoked_at` | statt Update der Signatur |
| `files` | `storage_name`, `original_name`, `mime`, `size`, `sha256`, `uploaded_by`, `created_at` | Dateien liegen außerhalb von `public/` |
| `drafts` | `user_id`, `form_key`, `payload`, `updated_at` | Autosave |

Eine Signatur ist gültig, wenn `status=VALID`, keine Revocation existiert und `sha256` gleich dem Hash der signierten Version ist. Eine neue Version erzeugt keine Signatur, die alten bleiben an ihrer Version.

## 4. Nummernkreise (Vorschlag)

| Präfix | Verwendung |
|---|---|
| `USMS-2026-0001` | USMS-Dokumente (bestehendes Format) |
| `OPS-2026-0001` | USMS-Operationen |
| `DA-2026-0001`, `SA-…`, `AG-…` | Prosecution-Akten |
| `SID-2026-0001` | SID (eigener Kreis) |
| `DC-CR-2026-0001`, `DC-CV-…`, `DC-MISC-…` | District Court (Straf-, Zivil-, sonstige Sachen) |
| `COA-2026-0001`, `SC-2026-0001` | Court of Appeals, Supreme Court |
| `W-2026-0001` | Warrants |
| `DCLI-L-2026-0001`, `DCLI-I-…` | Lizenzen, DCLI-Ermittlungen |
| `REG-2026-0001`, `CERT-…` | Registry, Urkunden |
| `SJA-2026-0001` | US-SJA (eigener Kreis) |
| `CC-2026-0001` | Constitutional Court |
| `REQ-2026-0001` | Official Requests |

Alle Präfixe sind konfigurierbar (`case_types.number_prefix`, `document_types.number_prefix`).

## 5. Evidence

| Tabelle | Wichtige Spalten |
|---|---|
| `evidence` | `evidence_no`, `case_id`, `description`, `category`, `collected_at`, `collected_by`, `current_holder_user_id`, `current_location`, `status` (`IN_CUSTODY`,`IN_TRANSFER`,`RELEASED`,`DISPOSED`), `security_level` |
| `evidence_custody` 🔒 | `evidence_id`, `from_user_id`, `to_user_id`, `transferred_at`, `location`, `reason`, `from_confirmed_at`, `to_confirmed_at`, `entry_hash` |
| `evidence_files` | `evidence_id`, `file_id` |

Eine Übergabe ist abgeschlossen, wenn beide Seiten bestätigt haben (digitale Bestätigung = Signatur im Sinne von Prompt 6.4). `current_holder` wird nur durch einen abgeschlossenen Custody-Eintrag geändert.

## 6. Workflows, Anträge, Entscheidungen

| Tabelle | Wichtige Spalten |
|---|---|
| `workflow_definitions` | `code`, `version`, `definition` JSON (Zustände, Übergänge, Permissions, Regeln), `is_active` |
| `workflow_instances` | `definition_code`, `definition_version`, `subject_type`, `subject_id`, `state`, `created_at`, `updated_at` |
| `workflow_actions` 🔒 | `instance_id`, `from_state`, `to_state`, `action`, `actor_user_id`, `comment`, `created_at` |
| `applications` | `application_no`, `kind` (`ARREST_WARRANT`,`SEARCH_WARRANT`,`SUBPOENA`,`COURT_ORDER`,`OTHER`), `case_id`, `applicant_user_id`, `applicant_org_id`, `target_org_id` (Gericht), `assigned_judge_id`, `content` JSON, `workflow_instance_id` |
| `warrants` | `warrant_no`, `kind` (`ARREST`,`SEARCH`), `application_id`, `case_id`, `subject_person_id`, `issuing_org_id`, `issued_by_user_id`, `issued_at`, `document_id`, `executing_org_id`, `status` (`ISSUED`,`IN_EXECUTION`,`EXECUTED`,`RETURNED`,`RECALLED`,`EXPIRED`), `executed_at`, `execution_report_document_id` |
| `decisions` | `case_id`, `kind` (`ORDER`,`JUDGMENT`,`OPINION`,`CONSTITUTIONAL_DECISION`), `document_id`, `decided_by`, `decided_at`, `panel` JSON |

`court_orders` und `judgments` aus dem Prompt sind als `decisions.kind` zusammengefasst (ADR-006).

## 7. Hearings und Fristen

| Tabelle | Wichtige Spalten |
|---|---|
| `hearings` | `case_id`, `court_org_id`, `title`, `room`, `starts_at`, `ends_at`, `status` (`SCHEDULED`,`HELD`,`POSTPONED`,`CANCELLED`), `protocol_document_id` |
| `hearing_participants` | `hearing_id`, `user_id` NULL, `person_id` NULL, `role` |
| `deadlines` | `case_id`, `title`, `due_at`, `responsible_user_id`, `status` (`OPEN`,`DONE`,`OVERDUE`,`CANCELLED`), `legal_basis_ref` NULL, `created_by` |
| `deadline_extensions` 🔒 | `deadline_id`, `old_due_at`, `new_due_at`, `reason`, `approved_by` |

## 8. Kommunikation und Notifications

| Tabelle | Wichtige Spalten |
|---|---|
| `conversations` | `kind` (`DIRECT`,`DEPARTMENT`,`CASE`), `case_id` NULL, `subject`, `security_level` |
| `conversation_members` | `conversation_id`, `user_id` NULL, `org_id` NULL |
| `messages` | `conversation_id`, `sender_user_id`, `sender_org_id` NULL, `body`, `created_at` |
| `message_reads` | `message_id`, `user_id`, `read_at` |
| `official_requests` | `request_no`, `sender_org_id`, `receiver_org_id`, `case_id` NULL, `subject`, `body`, `priority`, `due_at`, `status`, `assigned_user_id`, `response`, `responded_at`, `created_by` |
| `official_request_documents` | `request_id`, `document_id` |
| `notification_types` | `code`, `name`, `is_enabled` |
| `notifications` | `user_id`, `type_code`, `title`, `body` (nur nicht-sensibler Text), `subject_type`, `subject_id`, `link`, `created_at`, `read_at` |

## 9. Personen und Unternehmen

| Tabelle | Wichtige Spalten |
|---|---|
| `persons` | `full_name`, `date_of_birth`, `aliases`, `notes`, `is_demo` |
| `person_links` | `person_id`, `subject_type`, `subject_id`, `relation` |
| `companies` | `name`, `registration_no`, `address`, `status` |
| `company_people` | `company_id`, `person_id`, `role` (`OWNER`,`RESPONSIBLE`,`EMPLOYEE`) |

## 10. Fachmodule

**USMS**

| Tabelle | Wichtige Spalten |
|---|---|
| `operations` | `op_no`, `case_id`, `title`, `status`, `lead_user_id`, `planned_start`, `approved_by` |
| `operation_members` | `operation_id`, `user_id`, `role` |
| `arrests` | `person_id`, `warrant_id` NULL, `case_id`, `arrested_by`, `arrested_at`, `location`, `report_document_id` |
| `prisoner_transports` | `person_id`, `from_location`, `to_location`, `scheduled_at`, `status`, `escort` JSON |
| `court_security_assignments` | `hearing_id`, `user_id`, `post` |
| `tasks` | `org_id`, `case_id` NULL, `title`, `assignee_user_id`, `due_at`, `status` |
| `job_applications` | `org_id`, `applicant_name`, `contact`, `payload` JSON, `workflow_instance_id` |

**DCLI**

| Tabelle | Wichtige Spalten |
|---|---|
| `license_types` | `code`, `category` (`COMMERCIAL`,`RESOURCE`), `name`, `validity_days` NULL, `fee` NULL, `legal_status` |
| `license_applications` | `application_no`, `license_type_code`, `company_id`/`person_id`, `resource_kind`, `payload`, `workflow_instance_id` |
| `licenses` | `license_no`, `type_code`, `holder_company_id`/`holder_person_id`, `resource_kind`, `status`, `valid_from`, `valid_until`, `conditions`, `application_id` |
| `inspections` | `license_id`/`company_id`, `case_id`, `inspector_user_id`, `scheduled_at`, `result`, `findings`, `report_document_id` |
| `violations` | `company_id`, `license_id`, `inspection_id`, `description`, `measure`, `status` |
| `fees` | `subject_type`, `subject_id`, `amount`, `status`, `due_at`, `paid_at` |

**Registry**

| Tabelle | Wichtige Spalten |
|---|---|
| `registry_records` | `record_no`, `kind` (`BIRTH`,`MARRIAGE`,`DIVORCE`,`ADOPTION`), `status`, `data` JSON, `registered_at`, `registered_by`, `supersedes_id`, `case_id` NULL |
| `registry_record_persons` | `record_id`, `person_id`, `role` |
| `registry_applications` | `application_no`, `kind`, `payload`, `workflow_instance_id` |
| `certificates` | `certificate_no`, `record_id`, `issued_to`, `issued_by`, `issued_at`, `document_id`, `status` |

Registry-Historie: Korrekturen erzeugen einen neuen Record mit `supersedes_id`. Alte Records bleiben erhalten.

**US-SJA und Constitutional Court:** keine eigenen Tabellen. Sie nutzen `cases` (Case Types `US_SJA`, `CONSTITUTIONAL`), `applications`, `decisions`, `hearings` sowie Security Profile und Compartments.

## 11. Suche, Audit, System

| Tabelle | Wichtige Spalten |
|---|---|
| `search_index` (FTS5) | `resource_type`, `resource_id`, `title`, `body`. Die Sichtbarkeit wird per JOIN über die Quelltabelle geprüft, nie über den Index selbst. |
| `audit_log` 🔒 | `ts`, `actor_user_id`, `session_hash`, `active_org_id`, `action`, `resource_type`, `resource_id`, `resource_level`, `resource_compartments`, `ip`, `user_agent`, `outcome`, `details` JSON, `prev_hash`, `hash` |
| `settings` | `key` PK, `value` JSON, `updated_by`, `updated_at` |
| `feature_flags` | `code` PK, `enabled`, `legal_status`, `note`. Schaltet NOT-VERIFIED-Funktionen. |
| `retention_policies` | `resource_type`, `days` NULL (NULL = unbegrenzt), `legal_basis_ref` |
| `schema_migrations` | `version`, `applied_at`, `checksum` |

## 12. Wichtige Indizes

- `cases(owning_org_id, status)`, `cases(type_code)`, `case_participants(user_id)`, `case_access(subject_type, subject_id)`
- `documents(case_id)`, `document_versions(document_id, version)`
- `notifications(user_id, read_at)`, `messages(conversation_id, created_at)`
- `audit_log(ts)`, `audit_log(actor_user_id)`, `audit_log(resource_type, resource_id)`
- `memberships(user_id)`, `user_roles(user_id)`, `user_compartments(user_id)`
- `deadlines(due_at, status)`, `hearings(starts_at)`, `licenses(valid_until, status)`
