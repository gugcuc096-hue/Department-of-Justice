# MIGRATION_NOTES

## Verfahren

- Migrationen liegen als nummerierte SQL-Dateien unter `src/db/migrations/` (`001_core.sql`, …).
- `schema_migrations` speichert Version, Zeitpunkt und Checksumme. Eine bereits angewendete Migration mit geänderter Checksumme bricht den Start ab.
- Vor jeder **destruktiven** Migration (DROP, Tabellen-Neuaufbau, Datenumformung) gilt:
  1. Backup per `VACUUM INTO 'data/backups/<datum>-pre-<version>.db'`
  2. Migrationsplan und Rollback-Plan hier eintragen
  3. Migration auf Staging testen

## Historie

| Version | Datum | Inhalt | Destruktiv | Rollback |
|---|---|---|---|---|
| 001 | 2026-09-25 | Kernschema: Organisation, Benutzer, Rechte, Sicherheit, Sessions, Audit, Flags, Nummernkreise | nein | Neuaufbau, keine Altdaten |
| 002 | 2026-09-25 | Case Management | nein | Neuaufbau, keine Altdaten |
| 003 | 2026-09-25 | Dokumente, Versionen, Signaturen, Dateien | nein | Tabellen verwerfen; Uploads in `UPLOAD_DIR` separat sichern |
| 004 | 2026-09-25 | Workflows, Anträge, Haftbefehle; `document_types.workflow_only` | nein | Tabellen verwerfen; Spalte ist additiv |
| 005 | 2026-09-26 | Beweismittel, Übergaben, Chain of Custody, Beweismittelfotos | nein | Tabellen verwerfen; Fotos in `UPLOAD_DIR` separat sichern |
| 006 | 2026-09-26 | Termine, Terminbeteiligte, Fristen, Fristverlängerungen | nein | Tabellen verwerfen |
| 007 | 2026-09-26 | Nachrichten, offizielle Anfragen, Benachrichtigungen | nein | Tabellen verwerfen |
| 008 | 2026-09-26 | Personenakte, Unternehmen, Suchindex (FTS5) mit Triggern; `subject_person_id` an Anträgen/Haftbefehlen | nein (nur `ADD COLUMN`) | Tabellen und Trigger verwerfen; Spalten sind additiv |
| 009 | 2026-09-26 | Formularentwürfe (`drafts`) | nein | Tabelle verwerfen (Entwürfe sind flüchtig) |
