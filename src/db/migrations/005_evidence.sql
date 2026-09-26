-- 005_evidence: Beweismittel und Chain of Custody (prompt.txt 6.4, DATA_MODEL.md Abschnitt 5)

CREATE TABLE evidence (
  id                     INTEGER PRIMARY KEY,
  evidence_no            TEXT NOT NULL UNIQUE,
  case_id                INTEGER NOT NULL REFERENCES cases(id),
  description            TEXT NOT NULL,
  category               TEXT NOT NULL,
  collected_at           TEXT NOT NULL,
  collected_by           INTEGER NOT NULL REFERENCES users(id),
  collected_location     TEXT NOT NULL,
  current_holder_user_id INTEGER NOT NULL REFERENCES users(id),
  current_location       TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'IN_CUSTODY' CHECK (status IN ('IN_CUSTODY','IN_TRANSFER','RELEASED','DISPOSED')),
  security_level         TEXT NOT NULL REFERENCES security_levels(code),
  is_demo                INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_evidence_case ON evidence(case_id);
CREATE INDEX idx_evidence_holder ON evidence(current_holder_user_id);

-- Offene Übergaben (veränderlich, bis der Empfänger bestätigt, ablehnt oder der Abgebende zurückzieht)
CREATE TABLE evidence_transfers (
  id           INTEGER PRIMARY KEY,
  evidence_id  INTEGER NOT NULL REFERENCES evidence(id),
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id   INTEGER NOT NULL REFERENCES users(id),
  location     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REJECTED','CANCELLED')),
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  CHECK (from_user_id <> to_user_id)
);
CREATE UNIQUE INDEX uq_evidence_pending_transfer ON evidence_transfers(evidence_id) WHERE status = 'PENDING';
CREATE INDEX idx_evidence_transfers_to ON evidence_transfers(to_user_id, status);

-- Chain of Custody: nur abgeschlossene Tatsachen, append-only, je Beweismittel hash-verkettet
CREATE TABLE evidence_custody (
  id                INTEGER PRIMARY KEY,
  evidence_id       INTEGER NOT NULL REFERENCES evidence(id),
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('COLLECTED','TRANSFER','TRANSFER_REJECTED','TRANSFER_CANCELLED','LOCATION_CHANGE','RELEASED','DISPOSED')),
  from_user_id      INTEGER REFERENCES users(id),
  from_name         TEXT NOT NULL DEFAULT '',
  to_user_id        INTEGER REFERENCES users(id),
  to_name           TEXT NOT NULL DEFAULT '',
  location          TEXT NOT NULL,
  reason            TEXT NOT NULL,
  initiated_at      TEXT NOT NULL,     -- Bestätigung der abgebenden Person
  confirmed_at      TEXT,              -- Bestätigung der empfangenden Person
  recorded_by       INTEGER NOT NULL REFERENCES users(id),
  prev_hash         TEXT NOT NULL,
  entry_hash        TEXT NOT NULL,
  UNIQUE (evidence_id, seq)
);
CREATE TRIGGER evidence_custody_no_update BEFORE UPDATE ON evidence_custody
BEGIN SELECT RAISE(ABORT, 'evidence_custody is append-only'); END;
CREATE TRIGGER evidence_custody_no_delete BEFORE DELETE ON evidence_custody
BEGIN SELECT RAISE(ABORT, 'evidence_custody is append-only'); END;

CREATE TABLE evidence_files (
  evidence_id INTEGER NOT NULL REFERENCES evidence(id),
  file_id     INTEGER NOT NULL UNIQUE REFERENCES files(id),
  caption     TEXT NOT NULL DEFAULT '',
  added_by    INTEGER NOT NULL REFERENCES users(id),
  added_at    TEXT NOT NULL,
  PRIMARY KEY (evidence_id, file_id)
);
