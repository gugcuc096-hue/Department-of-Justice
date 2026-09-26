-- 002_cases: gemeinsames Case Management (DATA_MODEL.md Abschnitt 2, PERMISSIONS.md Abschnitt 5)

CREATE TABLE case_types (
  code                     TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  default_security_profile TEXT NOT NULL REFERENCES security_profiles(code),
  default_org_access       INTEGER NOT NULL DEFAULT 1 CHECK (default_org_access IN (0,1)),
  edit_scope               TEXT NOT NULL DEFAULT 'PARTICIPANTS_AND_SUPERVISORS' CHECK (edit_scope IN ('PARTICIPANTS','PARTICIPANTS_AND_SUPERVISORS')),
  workflow_code            TEXT,
  feature_flag             TEXT REFERENCES feature_flags(code),
  legal_status             TEXT NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (legal_status IN ('VERIFIED','NOT_VERIFIED')),
  is_enabled               INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
  sort_order               INTEGER NOT NULL DEFAULT 0
);

-- Welche Organisation darf Akten dieses Typs führen, mit welchem Nummernpräfix
CREATE TABLE case_type_orgs (
  type_code     TEXT NOT NULL REFERENCES case_types(code),
  org_id        INTEGER NOT NULL REFERENCES organizations(id),
  number_prefix TEXT NOT NULL,
  PRIMARY KEY (type_code, org_id)
);

CREATE TABLE cases (
  id                       INTEGER PRIMARY KEY,
  case_number              TEXT NOT NULL UNIQUE,
  type_code                TEXT NOT NULL REFERENCES case_types(code),
  title                    TEXT NOT NULL,
  summary                  TEXT NOT NULL DEFAULT '',
  owning_org_id            INTEGER NOT NULL REFERENCES organizations(id),
  security_profile         TEXT NOT NULL REFERENCES security_profiles(code),
  security_level           TEXT NOT NULL REFERENCES security_levels(code),
  requires_explicit_access INTEGER NOT NULL DEFAULT 0 CHECK (requires_explicit_access IN (0,1)),
  is_sealed                INTEGER NOT NULL DEFAULT 0 CHECK (is_sealed IN (0,1)),
  status                   TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACTIVE','CLOSED','ARCHIVED')),
  is_demo                  INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by               INTEGER NOT NULL REFERENCES users(id),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  closed_at                TEXT,
  archived_at              TEXT
);
CREATE INDEX idx_cases_org_status ON cases(owning_org_id, status);
CREATE INDEX idx_cases_type ON cases(type_code);
CREATE INDEX idx_cases_updated ON cases(updated_at);

CREATE TABLE case_compartments (
  case_id          INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  compartment_code TEXT NOT NULL REFERENCES compartments(code),
  PRIMARY KEY (case_id, compartment_code)
);

-- Beteiligte: Benutzer (mit Zugang) oder externe Parteien (Name, später Personenakte)
CREATE TABLE case_participants (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id),
  person_id     INTEGER,
  party_name    TEXT,
  role          TEXT NOT NULL,
  grants_access INTEGER NOT NULL DEFAULT 1 CHECK (grants_access IN (0,1)),
  sealed_access INTEGER NOT NULL DEFAULT 0 CHECK (sealed_access IN (0,1)),
  is_presiding  INTEGER NOT NULL DEFAULT 0 CHECK (is_presiding IN (0,1)),
  added_by      INTEGER REFERENCES users(id),
  added_at      TEXT NOT NULL,
  removed_at    TEXT,
  removed_by    INTEGER REFERENCES users(id),
  CHECK (user_id IS NOT NULL OR person_id IS NOT NULL OR party_name IS NOT NULL)
);
CREATE INDEX idx_case_participants_case ON case_participants(case_id);
CREATE INDEX idx_case_participants_user ON case_participants(user_id);

CREATE TABLE case_access (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('USER','ROLE','ORG')),
  subject_id    INTEGER NOT NULL,
  level         TEXT NOT NULL DEFAULT 'VIEW' CHECK (level IN ('VIEW','EDIT','MANAGE')),
  sealed_access INTEGER NOT NULL DEFAULT 0 CHECK (sealed_access IN (0,1)),
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  granted_by    INTEGER REFERENCES users(id),
  reason        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  revoked_at    TEXT,
  revoked_by    INTEGER REFERENCES users(id)
);
CREATE INDEX idx_case_access_case ON case_access(case_id);
CREATE INDEX idx_case_access_subject ON case_access(subject_type, subject_id);

-- Timeline (append-only)
CREATE TABLE case_events (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER NOT NULL REFERENCES cases(id),
  type          TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  summary       TEXT NOT NULL DEFAULT '',
  payload       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_case_events_case ON case_events(case_id, id);
CREATE TRIGGER case_events_no_update BEFORE UPDATE ON case_events
BEGIN SELECT RAISE(ABORT, 'case_events is append-only'); END;
CREATE TRIGGER case_events_no_delete BEFORE DELETE ON case_events
BEGIN SELECT RAISE(ABORT, 'case_events is append-only'); END;

CREATE TABLE case_links (
  id           INTEGER PRIMARY KEY,
  from_case_id INTEGER NOT NULL REFERENCES cases(id),
  to_case_id   INTEGER NOT NULL REFERENCES cases(id),
  link_type    TEXT NOT NULL CHECK (link_type IN ('ESCALATED_TO','APPEAL_OF','REVIEW_OF','RELATED','ORIGINATED_FROM')),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  removed_at   TEXT,
  CHECK (from_case_id <> to_case_id)
);
CREATE INDEX idx_case_links_from ON case_links(from_case_id);
CREATE INDEX idx_case_links_to ON case_links(to_case_id);
