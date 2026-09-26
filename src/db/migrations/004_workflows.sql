-- 004_workflows: Workflow-Engine, Anträge an Gerichte, Haft-/Durchsuchungsbefehle (WORKFLOWS.md 1, 3, 4)

CREATE TABLE workflow_definitions (
  code        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  definition  TEXT NOT NULL,          -- JSON: { initial, states, transitions[] }
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (code, version)
);

CREATE TABLE workflow_instances (
  id                 INTEGER PRIMARY KEY,
  definition_code    TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  subject_type       TEXT NOT NULL,
  subject_id         INTEGER NOT NULL,
  state              TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (definition_code, definition_version) REFERENCES workflow_definitions(code, version),
  UNIQUE (subject_type, subject_id)
);

CREATE TABLE workflow_actions (
  id            INTEGER PRIMARY KEY,
  instance_id   INTEGER NOT NULL REFERENCES workflow_instances(id),
  from_state    TEXT NOT NULL,
  to_state      TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),   -- NULL = System (nur nicht-rechtliche Übergänge)
  comment       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_workflow_actions_instance ON workflow_actions(instance_id, id);
CREATE TRIGGER workflow_actions_no_update BEFORE UPDATE ON workflow_actions
BEGIN SELECT RAISE(ABORT, 'workflow_actions is append-only'); END;
CREATE TRIGGER workflow_actions_no_delete BEFORE DELETE ON workflow_actions
BEGIN SELECT RAISE(ABORT, 'workflow_actions is append-only'); END;

-- Anträge an Gerichte (Haftbefehl, Durchsuchungsbeschluss, Vorladung)
CREATE TABLE applications (
  id                   INTEGER PRIMARY KEY,
  application_no       TEXT NOT NULL UNIQUE,
  kind                 TEXT NOT NULL CHECK (kind IN ('ARREST_WARRANT','SEARCH_WARRANT','SUBPOENA')),
  title                TEXT NOT NULL,
  source_case_id       INTEGER NOT NULL REFERENCES cases(id),
  applicant_user_id    INTEGER NOT NULL REFERENCES users(id),
  applicant_org_id     INTEGER NOT NULL REFERENCES organizations(id),
  target_org_id        INTEGER NOT NULL REFERENCES organizations(id),
  court_case_id        INTEGER REFERENCES cases(id),
  assigned_judge_id    INTEGER REFERENCES users(id),
  content              TEXT NOT NULL DEFAULT '{}',   -- { subjectName, offense, requestedMeasure, grounds }
  security_level       TEXT NOT NULL REFERENCES security_levels(code),
  status               TEXT NOT NULL,                -- Spiegel des Workflow-Zustands (für Listen/Filter)
  decision_document_id INTEGER REFERENCES documents(id),
  decision_reason      TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  submitted_at         TEXT,
  decided_at           TEXT
);
CREATE INDEX idx_applications_source ON applications(source_case_id);
CREATE INDEX idx_applications_target ON applications(target_org_id, status);
CREATE INDEX idx_applications_court_case ON applications(court_case_id);

-- Dem Antrag ausdrücklich beigefügte Dokumente der Ausgangsakte (nur diese sieht das Gericht)
CREATE TABLE application_documents (
  application_id INTEGER NOT NULL REFERENCES applications(id),
  document_id    INTEGER NOT NULL REFERENCES documents(id),
  PRIMARY KEY (application_id, document_id)
);

CREATE TABLE warrants (
  id                           INTEGER PRIMARY KEY,
  warrant_no                   TEXT NOT NULL UNIQUE,
  kind                         TEXT NOT NULL CHECK (kind IN ('ARREST','SEARCH')),
  application_id               INTEGER NOT NULL UNIQUE REFERENCES applications(id),
  court_case_id                INTEGER NOT NULL REFERENCES cases(id),
  source_case_id               INTEGER NOT NULL REFERENCES cases(id),
  document_id                  INTEGER NOT NULL REFERENCES documents(id),
  subject_name                 TEXT NOT NULL,
  offense                      TEXT NOT NULL,
  measure                      TEXT NOT NULL DEFAULT '',
  issuing_org_id               INTEGER NOT NULL REFERENCES organizations(id),
  issued_by                    INTEGER NOT NULL REFERENCES users(id),
  issued_at                    TEXT NOT NULL,
  executing_org_id             INTEGER NOT NULL REFERENCES organizations(id),
  status                       TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','IN_EXECUTION','EXECUTED','RETURNED','RECALLED')),
  execution_started_at         TEXT,
  executed_at                  TEXT,
  executed_by                  INTEGER REFERENCES users(id),
  execution_report_document_id INTEGER REFERENCES documents(id),
  returned_at                  TEXT,
  recalled_at                  TEXT,
  recall_reason                TEXT NOT NULL DEFAULT '',
  security_level               TEXT NOT NULL REFERENCES security_levels(code)
);
CREATE INDEX idx_warrants_executing ON warrants(executing_org_id, status);

-- Dokumenttypen, die nur über ein Verfahren entstehen dürfen (Haft-/Durchsuchungsbeschluss)
ALTER TABLE document_types ADD COLUMN workflow_only INTEGER NOT NULL DEFAULT 0 CHECK (workflow_only IN (0,1));
UPDATE document_types SET workflow_only = 1 WHERE code IN ('SEARCH_WARRANT', 'ARREST_WARRANT');
