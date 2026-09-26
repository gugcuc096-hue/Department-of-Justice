-- 001_core: Organisation, Benutzer, Rechte, Sicherheit, Sessions, Audit, Einstellungen
-- Siehe DATA_MODEL.md Abschnitte 1 und 11. Zeitstempel: ISO-8601 UTC.

-- ---------------------------------------------------------------- Organisation
CREATE TABLE organizations (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES organizations(id),
  kind        TEXT NOT NULL CHECK (kind IN ('PLATFORM','INSTITUTION','OFFICE','COURT','DIVISION','AUTHORITY')),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  subtitle    TEXT NOT NULL DEFAULT '',
  brand_code  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_organizations_parent ON organizations(parent_id);

-- Rangfolge je Organisation; level: höher = höherer Rang. Ränge gewähren keine Rechte.
CREATE TABLE ranks (
  id          INTEGER PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, code)
);

-- ---------------------------------------------------------------- Rechte
CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE roles (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE role_permissions (
  role_id         INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission_code)
);

-- ---------------------------------------------------------------- Sicherheit
CREATE TABLE security_levels (
  code  TEXT PRIMARY KEY,
  rank  INTEGER NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE compartments (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  owner_org_id INTEGER REFERENCES organizations(id)
);

-- Benannte Kombination aus Level + Compartments (z. B. USSJA_CLASSIFIED), SECURITY_MODEL.md Abschnitt 3
CREATE TABLE security_profiles (
  code                     TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  level_code               TEXT NOT NULL REFERENCES security_levels(code),
  compartments             TEXT NOT NULL DEFAULT '[]',
  requires_explicit_access INTEGER NOT NULL DEFAULT 0 CHECK (requires_explicit_access IN (0,1))
);

-- ---------------------------------------------------------------- Benutzer
CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name         TEXT NOT NULL,
  badge_no             TEXT NOT NULL DEFAULT '',
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','PENDING')),
  clearance_level      TEXT NOT NULL DEFAULT 'INTERNAL' REFERENCES security_levels(code),
  contact              TEXT NOT NULL DEFAULT '',
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  is_demo              INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at        TEXT
);

CREATE TABLE memberships (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id             INTEGER NOT NULL REFERENCES organizations(id),
  rank_id            INTEGER REFERENCES ranks(id),
  supervisor_user_id INTEGER REFERENCES users(id),
  is_primary         INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  starts_at          TEXT,
  ends_at            TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, org_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_org ON memberships(org_id);

-- scope_org_id NULL = global
CREATE TABLE user_roles (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_org_id INTEGER REFERENCES organizations(id),
  granted_by   INTEGER REFERENCES users(id),
  reason       TEXT NOT NULL DEFAULT '',
  granted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uq_user_roles ON user_roles(user_id, role_id, IFNULL(scope_org_id, 0));
CREATE INDEX idx_user_roles_user ON user_roles(user_id);

CREATE TABLE user_permissions (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code),
  scope_org_id    INTEGER REFERENCES organizations(id),
  granted_by      INTEGER REFERENCES users(id),
  reason          TEXT NOT NULL DEFAULT '',
  granted_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at      TEXT
);
CREATE UNIQUE INDEX uq_user_permissions ON user_permissions(user_id, permission_code, IFNULL(scope_org_id, 0));

-- Optional: Mindestrang für eine Permission in einer Organisation (Zusatzbedingung, keine Erteilung)
CREATE TABLE permission_rank_requirements (
  permission_code TEXT NOT NULL REFERENCES permissions(code),
  org_id          INTEGER NOT NULL REFERENCES organizations(id),
  min_rank_level  INTEGER NOT NULL,
  PRIMARY KEY (permission_code, org_id)
);

CREATE TABLE user_compartments (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  compartment_code TEXT NOT NULL REFERENCES compartments(code),
  granted_by       INTEGER REFERENCES users(id),
  reason           TEXT NOT NULL DEFAULT '',
  granted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at       TEXT,
  PRIMARY KEY (user_id, compartment_code)
);

-- Zeitlich begrenzte Delegation einer Permission (optional auf einen Case beschränkt; FK in 002)
CREATE TABLE delegations (
  id              INTEGER PRIMARY KEY,
  from_user_id    INTEGER NOT NULL REFERENCES users(id),
  to_user_id      INTEGER NOT NULL REFERENCES users(id),
  permission_code TEXT NOT NULL REFERENCES permissions(code),
  scope_org_id    INTEGER REFERENCES organizations(id),
  case_id         INTEGER,
  starts_at       TEXT NOT NULL,
  ends_at         TEXT NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REJECTED','REVOKED')),
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (from_user_id <> to_user_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_delegations_to ON delegations(to_user_id, status);

-- ---------------------------------------------------------------- Sessions
-- Gespeichert wird nur sha256(token), nie das Token selbst.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  active_org_id INTEGER REFERENCES organizations(id),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  ip            TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------- Audit (append-only, hash-verkettet)
CREATE TABLE audit_log (
  id                    INTEGER PRIMARY KEY,
  ts                    TEXT NOT NULL,
  actor_user_id         INTEGER,
  session_hash          TEXT,
  active_org_id         INTEGER,
  action                TEXT NOT NULL,
  resource_type         TEXT,
  resource_id           TEXT,
  resource_org_id       INTEGER,
  resource_level        TEXT,
  resource_compartments TEXT NOT NULL DEFAULT '[]',
  ip                    TEXT NOT NULL DEFAULT '',
  user_agent            TEXT NOT NULL DEFAULT '',
  outcome               TEXT NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','FAILURE')),
  details               TEXT NOT NULL DEFAULT '{}',
  prev_hash             TEXT NOT NULL,
  hash                  TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ---------------------------------------------------------------- System
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Schalter für Funktionen, deren Rechtsgrundlage noch nicht verifiziert ist (ADR-012)
CREATE TABLE feature_flags (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0,1)),
  legal_status TEXT NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (legal_status IN ('VERIFIED','NOT_VERIFIED')),
  note         TEXT NOT NULL DEFAULT '',
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Nummernkreise je Präfix und Jahr; Vergabe immer innerhalb einer Transaktion
CREATE TABLE number_sequences (
  prefix     TEXT NOT NULL,
  year       INTEGER NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);
