// @ts-check
'use strict';
/**
 * SQLite-Verbindung (node:sqlite) und Transaktions-Helper.
 * Alle Abfragen laufen über Prepared Statements (SECURITY_MODEL.md, Abschnitt 11).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/** @typedef {import('node:sqlite').DatabaseSync} Database */

/** @param {string} file  Pfad oder ":memory:" */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  return db;
}

// Verschachtelungstiefe je Verbindung: äußere Ebene BEGIN/COMMIT, innere SAVEPOINTs.
const depth = new WeakMap();

/**
 * Führt fn in einer Transaktion aus. Wirft fn, wird alles zurückgerollt.
 * Verschachtelte Aufrufe verwenden Savepoints, damit Services sich frei kombinieren lassen.
 * @template T
 * @param {Database} db
 * @param {() => T} fn
 * @returns {T}
 */
function transaction(db, fn) {
  const level = depth.get(db) ?? 0;
  const sp = `sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    if (result && typeof (/** @type {any} */ (result).then) === 'function') {
      throw new Error('transaction(): fn darf nicht async sein (node:sqlite ist synchron)');
    }
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

/** Aktueller Zeitstempel im Format der Datenbank (ISO-8601, UTC, Millisekunden). */
const now = () => new Date().toISOString();

/**
 * JSON-Spalten sicher lesen.
 * @param {unknown} text
 * @param {any} fallback
 */
function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Platzhalter für IN-Listen: inList([1,2,3]) → "?,?,?". Leere Liste ergibt "NULL" (matcht nie).
 * @param {readonly unknown[]} values
 */
const inList = (values) => (values.length ? values.map(() => '?').join(',') : 'NULL');

module.exports = { openDatabase, transaction, now, parseJson, inList };
