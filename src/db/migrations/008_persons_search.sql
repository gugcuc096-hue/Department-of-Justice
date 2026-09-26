-- 008_persons_search: zentrale Personenakte, Unternehmen, globale Suche (prompt.txt 6.9, 6.10; DATA_MODEL.md 9, 11)

-- ---------------------------------------------------------------- Personen
-- Stammdaten einer Person. Beziehungen (Akten, Haftbefehle, Lizenzen, Register …) stehen in person_links
-- und werden beim Anzeigen EINZELN gegen die Sichtbarkeit des jeweiligen Gegenstands geprüft.
CREATE TABLE persons (
  id             INTEGER PRIMARY KEY,
  person_no      TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  aliases        TEXT NOT NULL DEFAULT '',
  date_of_birth  TEXT,                      -- YYYY-MM-DD, optional
  description    TEXT NOT NULL DEFAULT '',
  owning_org_id  INTEGER NOT NULL REFERENCES organizations(id),
  security_level TEXT NOT NULL DEFAULT 'INTERNAL' REFERENCES security_levels(code),
  is_demo        INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_persons_name ON persons(full_name COLLATE NOCASE);

CREATE TABLE person_compartments (
  person_id        INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  compartment_code TEXT NOT NULL REFERENCES compartments(code),
  PRIMARY KEY (person_id, compartment_code)
);

CREATE TABLE person_links (
  id           INTEGER PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES persons(id),
  subject_type TEXT NOT NULL,              -- case, application, warrant, arrest, license, registry_record, …
  subject_id   INTEGER NOT NULL,
  relation     TEXT NOT NULL,              -- z. B. DEFENDANT, SUBJECT, HOLDER, CHILD
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  removed_at   TEXT,
  removed_by   INTEGER REFERENCES users(id)
);
CREATE INDEX idx_person_links_person ON person_links(person_id);
CREATE INDEX idx_person_links_subject ON person_links(subject_type, subject_id);

-- ---------------------------------------------------------------- Unternehmen
CREATE TABLE companies (
  id              INTEGER PRIMARY KEY,
  company_no      TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  registration_no TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','DISSOLVED')),
  description     TEXT NOT NULL DEFAULT '',
  owning_org_id   INTEGER NOT NULL REFERENCES organizations(id),
  security_level  TEXT NOT NULL DEFAULT 'INTERNAL' REFERENCES security_levels(code),
  is_demo         INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_companies_name ON companies(name COLLATE NOCASE);

CREATE TABLE company_people (
  id         INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  person_id  INTEGER NOT NULL REFERENCES persons(id),
  role       TEXT NOT NULL CHECK (role IN ('OWNER','RESPONSIBLE','EMPLOYEE')),
  since      TEXT,
  added_by   INTEGER NOT NULL REFERENCES users(id),
  added_at   TEXT NOT NULL,
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_company_people_company ON company_people(company_id);
CREATE INDEX idx_company_people_person ON company_people(person_id);

CREATE TABLE company_links (
  id           INTEGER PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id),
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  relation     TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  removed_at   TEXT
);
CREATE INDEX idx_company_links_company ON company_links(company_id);
CREATE INDEX idx_company_links_subject ON company_links(subject_type, subject_id);

-- Betroffene Person eines Antrags / Haftbefehls (optional, zusätzlich zum Namen)
ALTER TABLE applications ADD COLUMN subject_person_id INTEGER REFERENCES persons(id);
ALTER TABLE warrants ADD COLUMN subject_person_id INTEGER REFERENCES persons(id);

-- ---------------------------------------------------------------- Globale Suche (FTS5)
-- Der Index enthält nur Text. Ob ein Treffer zurückgegeben wird, entscheidet IMMER das Sichtbarkeitsprädikat
-- der Quelltabelle in derselben SQL-Abfrage (SECURITY_MODEL.md 7) – nie der Index selbst.
CREATE VIRTUAL TABLE search_index USING fts5(
  resource_type UNINDEXED,
  resource_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Akten
CREATE TRIGGER search_cases_ai AFTER INSERT ON cases BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body) VALUES ('case', NEW.id, NEW.case_number || ' ' || NEW.title, NEW.summary);
END;
CREATE TRIGGER search_cases_au AFTER UPDATE OF case_number, title, summary ON cases BEGIN
  DELETE FROM search_index WHERE resource_type = 'case' AND resource_id = NEW.id;
  INSERT INTO search_index (resource_type, resource_id, title, body) VALUES ('case', NEW.id, NEW.case_number || ' ' || NEW.title, NEW.summary);
END;

-- Dokumente: Titel/Nummer und Feldinhalte der aktuellen Version
CREATE TRIGGER search_document_versions_ai AFTER INSERT ON document_versions BEGIN
  DELETE FROM search_index WHERE resource_type = 'document' AND resource_id = NEW.document_id;
  INSERT INTO search_index (resource_type, resource_id, title, body)
    SELECT 'document', d.id, d.doc_number || ' ' || d.title,
      IFNULL((SELECT group_concat(value, ' ') FROM json_each(NEW.content, '$.fields')), '')
    FROM documents d WHERE d.id = NEW.document_id;
END;
CREATE TRIGGER search_documents_au AFTER UPDATE OF title ON documents BEGIN
  UPDATE search_index SET title = NEW.doc_number || ' ' || NEW.title WHERE resource_type = 'document' AND resource_id = NEW.id;
END;

-- Personen und Unternehmen
CREATE TRIGGER search_persons_ai AFTER INSERT ON persons BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body)
    VALUES ('person', NEW.id, NEW.full_name || ' ' || NEW.aliases || ' ' || NEW.person_no, IFNULL(NEW.date_of_birth, '') || ' ' || NEW.description);
END;
CREATE TRIGGER search_persons_au AFTER UPDATE OF full_name, aliases, date_of_birth, description ON persons BEGIN
  DELETE FROM search_index WHERE resource_type = 'person' AND resource_id = NEW.id;
  INSERT INTO search_index (resource_type, resource_id, title, body)
    VALUES ('person', NEW.id, NEW.full_name || ' ' || NEW.aliases || ' ' || NEW.person_no, IFNULL(NEW.date_of_birth, '') || ' ' || NEW.description);
END;
CREATE TRIGGER search_companies_ai AFTER INSERT ON companies BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body)
    VALUES ('company', NEW.id, NEW.name || ' ' || NEW.registration_no || ' ' || NEW.company_no, NEW.address || ' ' || NEW.description);
END;
CREATE TRIGGER search_companies_au AFTER UPDATE OF name, registration_no, address, description ON companies BEGIN
  DELETE FROM search_index WHERE resource_type = 'company' AND resource_id = NEW.id;
  INSERT INTO search_index (resource_type, resource_id, title, body)
    VALUES ('company', NEW.id, NEW.name || ' ' || NEW.registration_no || ' ' || NEW.company_no, NEW.address || ' ' || NEW.description);
END;

-- Termine
CREATE TRIGGER search_hearings_ai AFTER INSERT ON hearings BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body) VALUES ('hearing', NEW.id, NEW.hearing_no || ' ' || NEW.title, NEW.room);
END;
CREATE TRIGGER search_hearings_au AFTER UPDATE OF title, room ON hearings BEGIN
  DELETE FROM search_index WHERE resource_type = 'hearing' AND resource_id = NEW.id;
  INSERT INTO search_index (resource_type, resource_id, title, body) VALUES ('hearing', NEW.id, NEW.hearing_no || ' ' || NEW.title, NEW.room);
END;

-- Nachrichten (unveränderlich): Betreff der Unterhaltung + Text
CREATE TRIGGER search_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body)
    SELECT 'message', NEW.id, cv.subject, NEW.body FROM conversations cv WHERE cv.id = NEW.conversation_id;
END;

-- Haftbefehle, Anträge, Beweismittel, offizielle Anfragen
CREATE TRIGGER search_warrants_ai AFTER INSERT ON warrants BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body) VALUES ('warrant', NEW.id, NEW.warrant_no || ' ' || NEW.subject_name, NEW.offense || ' ' || NEW.measure);
END;
CREATE TRIGGER search_applications_ai AFTER INSERT ON applications BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body)
    VALUES ('application', NEW.id, NEW.application_no || ' ' || NEW.title, IFNULL((SELECT group_concat(value, ' ') FROM json_each(NEW.content)), ''));
END;
CREATE TRIGGER search_applications_au AFTER UPDATE OF title, content ON applications BEGIN
  DELETE FROM search_index WHERE resource_type = 'application' AND resource_id = NEW.id;
  INSERT INTO search_index (resource_type, resource_id, title, body)
    VALUES ('application', NEW.id, NEW.application_no || ' ' || NEW.title, IFNULL((SELECT group_concat(value, ' ') FROM json_each(NEW.content)), ''));
END;
CREATE TRIGGER search_evidence_ai AFTER INSERT ON evidence BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body) VALUES ('evidence', NEW.id, NEW.evidence_no || ' ' || NEW.description, NEW.category);
END;
CREATE TRIGGER search_requests_ai AFTER INSERT ON official_requests BEGIN
  INSERT INTO search_index (resource_type, resource_id, title, body) VALUES ('official_request', NEW.id, NEW.request_no || ' ' || NEW.subject, NEW.body);
END;

-- Bestand indexieren
INSERT INTO search_index (resource_type, resource_id, title, body) SELECT 'case', id, case_number || ' ' || title, summary FROM cases;
INSERT INTO search_index (resource_type, resource_id, title, body)
  SELECT 'document', d.id, d.doc_number || ' ' || d.title,
    IFNULL((SELECT group_concat(value, ' ') FROM json_each(v.content, '$.fields')), '')
  FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version;
INSERT INTO search_index (resource_type, resource_id, title, body) SELECT 'hearing', id, hearing_no || ' ' || title, room FROM hearings;
INSERT INTO search_index (resource_type, resource_id, title, body) SELECT 'message', m.id, cv.subject, m.body FROM messages m JOIN conversations cv ON cv.id = m.conversation_id;
INSERT INTO search_index (resource_type, resource_id, title, body) SELECT 'warrant', id, warrant_no || ' ' || subject_name, offense || ' ' || measure FROM warrants;
INSERT INTO search_index (resource_type, resource_id, title, body)
  SELECT 'application', id, application_no || ' ' || title, IFNULL((SELECT group_concat(value, ' ') FROM json_each(content)), '') FROM applications;
INSERT INTO search_index (resource_type, resource_id, title, body) SELECT 'evidence', id, evidence_no || ' ' || description, category FROM evidence;
INSERT INTO search_index (resource_type, resource_id, title, body) SELECT 'official_request', id, request_no || ' ' || subject, body FROM official_requests;
