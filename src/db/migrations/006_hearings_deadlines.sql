-- 006_hearings_deadlines: Anhörungen/Termine und Fristen (prompt.txt 6.6, DATA_MODEL.md Abschnitt 7)

CREATE TABLE hearings (
  id                   INTEGER PRIMARY KEY,
  hearing_no           TEXT NOT NULL UNIQUE,
  case_id              INTEGER NOT NULL REFERENCES cases(id),
  court_org_id         INTEGER NOT NULL REFERENCES organizations(id),
  title                TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('HEARING','TRIAL_SESSION','STATUS_CONFERENCE','OTHER')),
  room                 TEXT NOT NULL,
  starts_at            TEXT NOT NULL,
  ends_at              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','HELD','POSTPONED','CANCELLED')),
  notes                TEXT NOT NULL DEFAULT '',
  status_reason        TEXT NOT NULL DEFAULT '',
  protocol_document_id INTEGER REFERENCES documents(id),
  security_level       TEXT NOT NULL REFERENCES security_levels(code),
  created_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_hearings_case ON hearings(case_id);
CREATE INDEX idx_hearings_time ON hearings(court_org_id, starts_at);

CREATE TABLE hearing_participants (
  id           INTEGER PRIMARY KEY,
  hearing_id   INTEGER NOT NULL REFERENCES hearings(id),
  user_id      INTEGER REFERENCES users(id),
  party_name   TEXT,
  role         TEXT NOT NULL CHECK (role IN ('JUDGE','PROSECUTOR','COUNSEL','DEFENDANT','PLAINTIFF','WITNESS','CLERK','SECURITY','OBSERVER')),
  is_presiding INTEGER NOT NULL DEFAULT 0 CHECK (is_presiding IN (0,1)),
  added_by     INTEGER NOT NULL REFERENCES users(id),
  added_at     TEXT NOT NULL,
  removed_at   TEXT,
  CHECK (user_id IS NOT NULL OR party_name IS NOT NULL)
);
CREATE INDEX idx_hearing_participants_hearing ON hearing_participants(hearing_id);
CREATE INDEX idx_hearing_participants_user ON hearing_participants(user_id);

-- Fristen: Dauer wird nie automatisch berechnet (Rechtsgrundlagen nicht verifiziert) – Fälligkeit immer manuell
CREATE TABLE deadlines (
  id                  INTEGER PRIMARY KEY,
  case_id             INTEGER NOT NULL REFERENCES cases(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  due_at              TEXT NOT NULL,
  responsible_user_id INTEGER NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CANCELLED')),
  legal_basis_ref     TEXT NOT NULL DEFAULT '',
  status_reason       TEXT NOT NULL DEFAULT '',
  completed_at        TEXT,
  completed_by        INTEGER REFERENCES users(id),
  created_by          INTEGER NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_deadlines_due ON deadlines(status, due_at);
CREATE INDEX idx_deadlines_responsible ON deadlines(responsible_user_id, status);
CREATE INDEX idx_deadlines_case ON deadlines(case_id);

CREATE TABLE deadline_extensions (
  id          INTEGER PRIMARY KEY,
  deadline_id INTEGER NOT NULL REFERENCES deadlines(id),
  old_due_at  TEXT NOT NULL,
  new_due_at  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  extended_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  CHECK (new_due_at > old_due_at)
);
CREATE TRIGGER deadline_extensions_no_update BEFORE UPDATE ON deadline_extensions
BEGIN SELECT RAISE(ABORT, 'deadline_extensions is append-only'); END;
CREATE TRIGGER deadline_extensions_no_delete BEFORE DELETE ON deadline_extensions
BEGIN SELECT RAISE(ABORT, 'deadline_extensions is append-only'); END;
