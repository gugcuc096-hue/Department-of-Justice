-- 007_communication: Nachrichten, offizielle Anfragen, Benachrichtigungen (prompt.txt 6.7, 6.8; DATA_MODEL.md Abschnitt 8)

-- Unterhaltungen: DIRECT (benannte Personen), CASE (alle, die die Akte sehen), DEPARTMENT (zwei Organisationen)
CREATE TABLE conversations (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('DIRECT','CASE','DEPARTMENT')),
  subject        TEXT NOT NULL,
  case_id        INTEGER REFERENCES cases(id),
  org_a_id       INTEGER REFERENCES organizations(id),
  org_b_id       INTEGER REFERENCES organizations(id),
  security_level TEXT NOT NULL REFERENCES security_levels(code),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((kind = 'CASE' AND case_id IS NOT NULL) OR (kind = 'DEPARTMENT' AND org_a_id IS NOT NULL AND org_b_id IS NOT NULL) OR kind = 'DIRECT')
);
CREATE INDEX idx_conversations_case ON conversations(case_id);

CREATE TABLE conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  added_at        TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

-- Nachrichten sind unveränderlich (keine stillen Änderungen an Kommunikation)
CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_user_id  INTEGER NOT NULL REFERENCES users(id),
  sender_org_id   INTEGER REFERENCES organizations(id),   -- gesetzt: im Namen der Organisation (MESSAGE_DEPARTMENT)
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are append-only'); END;
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are append-only'); END;

CREATE TABLE conversation_reads (
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id),
  user_id              INTEGER NOT NULL REFERENCES users(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

-- Offizielle Anfragen Institution → Institution
CREATE TABLE official_requests (
  id               INTEGER PRIMARY KEY,
  request_no       TEXT NOT NULL UNIQUE,
  sender_org_id    INTEGER NOT NULL REFERENCES organizations(id),
  receiver_org_id  INTEGER NOT NULL REFERENCES organizations(id),
  case_id          INTEGER REFERENCES cases(id),
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  priority         TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  due_at           TEXT,
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','ANSWERED','DECLINED','CLOSED')),
  assigned_user_id INTEGER REFERENCES users(id),
  response         TEXT NOT NULL DEFAULT '',
  responded_at     TEXT,
  responded_by     INTEGER REFERENCES users(id),
  security_level   TEXT NOT NULL REFERENCES security_levels(code),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (sender_org_id <> receiver_org_id)
);
CREATE INDEX idx_requests_receiver ON official_requests(receiver_org_id, status);
CREATE INDEX idx_requests_sender ON official_requests(sender_org_id, status);

CREATE TABLE official_request_documents (
  request_id  INTEGER NOT NULL REFERENCES official_requests(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  PRIMARY KEY (request_id, document_id)
);

CREATE TABLE official_request_events (
  id            INTEGER PRIMARY KEY,
  request_id    INTEGER NOT NULL REFERENCES official_requests(id),
  type          TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  comment       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE TRIGGER official_request_events_no_update BEFORE UPDATE ON official_request_events
BEGIN SELECT RAISE(ABORT, 'official_request_events is append-only'); END;
CREATE TRIGGER official_request_events_no_delete BEFORE DELETE ON official_request_events
BEGIN SELECT RAISE(ABORT, 'official_request_events is append-only'); END;

-- Benachrichtigungen: nur nicht-sensibler Text; Sichtbarkeit wird beim Anzeigen erneut geprüft
CREATE TABLE notifications (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  link         TEXT NOT NULL DEFAULT '',
  subject_type TEXT,
  subject_id   INTEGER,
  dedupe_key   TEXT,
  created_at   TEXT NOT NULL,
  read_at      TEXT
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, id);
CREATE UNIQUE INDEX uq_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
