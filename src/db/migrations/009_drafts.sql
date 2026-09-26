-- 009_drafts: serverseitig gespeicherte Formularentwürfe (Autosave, prompt.txt 9.5; ARCHITECTURE.md 7)
-- Entwürfe liegen nicht im Browser (localStorage), damit auf gemeinsam genutzten Geräten keine Inhalte zurückbleiben.
CREATE TABLE drafts (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  form_key   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, form_key)
);
