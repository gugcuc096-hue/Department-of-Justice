-- 003_documents: Dokumente, Versionen, Vorlagen, Signaturen, Dateien (DATA_MODEL.md Abschnitt 3, ADR-010)

CREATE TABLE document_templates (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  language    TEXT NOT NULL DEFAULT 'de',
  fields      TEXT NOT NULL DEFAULT '[]',   -- [{ key, label, type: text|textarea|date, required }]
  body        TEXT NOT NULL,                -- HTML mit {{platzhaltern}}; Werte werden beim Rendern escaped
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  UNIQUE (code, version)
);

CREATE TABLE document_types (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  number_suffix     TEXT NOT NULL,           -- Aktenzeichen: <ORG>-<SUFFIX>-<JAHR>-<NNNN>
  template_code     TEXT,                    -- NULL = Datei-Anhang ohne Vorlage
  sign_permission   TEXT REFERENCES permissions(code),   -- NULL = nicht signierbar
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0,1)),
  allowed_orgs      TEXT,                    -- JSON-Liste von Org-Codes (inkl. Unterorganisationen); NULL = alle
  feature_flag      TEXT REFERENCES feature_flags(code),
  legal_status      TEXT NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (legal_status IN ('VERIFIED','NOT_VERIFIED')),
  is_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  storage_name  TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE documents (
  id                INTEGER PRIMARY KEY,
  doc_number        TEXT NOT NULL UNIQUE,
  type_code         TEXT NOT NULL REFERENCES document_types(code),
  case_id           INTEGER REFERENCES cases(id),
  title             TEXT NOT NULL,
  owning_org_id     INTEGER NOT NULL REFERENCES organizations(id),
  security_level    TEXT NOT NULL REFERENCES security_levels(code),
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','REJECTED','SIGNED','ISSUED','ARCHIVED','DELETED')),
  current_version   INTEGER NOT NULL DEFAULT 1,
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_documents_case ON documents(case_id);
CREATE INDEX idx_documents_org ON documents(owning_org_id, status);

CREATE TABLE document_compartments (
  document_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  compartment_code TEXT NOT NULL REFERENCES compartments(code),
  PRIMARY KEY (document_id, compartment_code)
);

-- Unveränderliche Versionen: Inhalt, gerendertes HTML (mit Vorlagenversion eingefroren), optional Datei
CREATE TABLE document_versions (
  id               INTEGER PRIMARY KEY,
  document_id      INTEGER NOT NULL REFERENCES documents(id),
  version          INTEGER NOT NULL,
  template_code    TEXT,
  template_version INTEGER,
  content          TEXT NOT NULL DEFAULT '{}',
  rendered_html    TEXT NOT NULL DEFAULT '',
  file_id          INTEGER REFERENCES files(id),
  sha256           TEXT NOT NULL,
  change_note      TEXT NOT NULL DEFAULT '',
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  UNIQUE (document_id, version)
);
CREATE TRIGGER document_versions_no_update BEFORE UPDATE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document_versions is append-only'); END;
CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document_versions is append-only'); END;

-- Zugriff auf Dokumente ohne Akte (Dokumente in Akten folgen der Akte)
CREATE TABLE document_access (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('USER','ORG')),
  subject_id   INTEGER NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  granted_by   INTEGER REFERENCES users(id),
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  revoked_at   TEXT
);
CREATE INDEX idx_document_access_doc ON document_access(document_id);

-- Signaturen: an Version und Hash gebunden; Name/Rang/Institution als Momentaufnahme
CREATE TABLE document_signatures (
  id             INTEGER PRIMARY KEY,
  document_id    INTEGER NOT NULL REFERENCES documents(id),
  version        INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  signer_user_id INTEGER NOT NULL REFERENCES users(id),
  signer_name    TEXT NOT NULL,
  signer_rank    TEXT NOT NULL DEFAULT '',
  signer_org     TEXT NOT NULL,
  capacity       TEXT NOT NULL DEFAULT '',
  signed_at      TEXT NOT NULL
);
CREATE INDEX idx_document_signatures_doc ON document_signatures(document_id);
CREATE TRIGGER document_signatures_no_update BEFORE UPDATE ON document_signatures
BEGIN SELECT RAISE(ABORT, 'document_signatures is append-only'); END;
CREATE TRIGGER document_signatures_no_delete BEFORE DELETE ON document_signatures
BEGIN SELECT RAISE(ABORT, 'document_signatures is append-only'); END;

CREATE TABLE signature_revocations (
  id           INTEGER PRIMARY KEY,
  signature_id INTEGER NOT NULL UNIQUE REFERENCES document_signatures(id),
  reason       TEXT NOT NULL,
  revoked_by   INTEGER NOT NULL REFERENCES users(id),
  revoked_at   TEXT NOT NULL
);
CREATE TRIGGER signature_revocations_no_update BEFORE UPDATE ON signature_revocations
BEGIN SELECT RAISE(ABORT, 'signature_revocations is append-only'); END;
CREATE TRIGGER signature_revocations_no_delete BEFORE DELETE ON signature_revocations
BEGIN SELECT RAISE(ABORT, 'signature_revocations is append-only'); END;
