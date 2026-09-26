// @ts-check
'use strict';
/**
 * Zentrale Personenakte (prompt.txt 6.10) und Unternehmen (DATA_MODEL.md 9).
 *
 * Eine Person kann mit Akten, Anträgen, Haftbefehlen, Festnahmen, Lizenzen, Registereinträgen usw. verknüpft sein.
 * Jede dieser Beziehungen wird beim Anzeigen EINZELN gegen die Sichtbarkeit ihres Gegenstands geprüft
 * (ctx.subjectVisible – dieselben Prüfer wie für Benachrichtigungen). Unsichtbare Beziehungen fallen ersatzlos weg;
 * es gibt keinen Hinweis wie „3 weitere verborgen“ (SECURITY_MODEL.md 7).
 */
const { z } = require('zod');
const { transaction, now, inList } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { personVisibility, companyVisibility } = require('./visibility');
const { nextNumber } = require('../numbers');
const { orgRef } = require('../users/me');

const text = (max) => z.string().trim().max(max);
const dob = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.').nullable().optional();
const schemas = {
  person: z.object({
    fullName: z.string().trim().min(2).max(200),
    aliases: text(500).default(''),
    dateOfBirth: dob,
    description: text(5000).default(''),
    orgId: z.number().int().positive().optional(),
    securityLevel: z.string().min(2).max(40).optional(),
    compartments: z.array(z.string().min(2).max(40)).max(10).default([]),
  }),
  personUpdate: z.object({
    fullName: z.string().trim().min(2).max(200).optional(),
    aliases: text(500).optional(),
    dateOfBirth: dob,
    description: text(5000).optional(),
  }),
  company: z.object({
    name: z.string().trim().min(2).max(200),
    registrationNo: text(100).default(''),
    address: text(500).default(''),
    description: text(5000).default(''),
    orgId: z.number().int().positive().optional(),
  }),
  companyUpdate: z.object({
    name: z.string().trim().min(2).max(200).optional(),
    registrationNo: text(100).optional(),
    address: text(500).optional(),
    description: text(5000).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'DISSOLVED']).optional(),
  }),
  companyPerson: z.object({
    personId: z.number().int().positive(),
    role: z.enum(['OWNER', 'RESPONSIBLE', 'EMPLOYEE']),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  }),
  list: z.object({
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  }),
};

const like = (q) => `%${q.replace(/[\\%_]/g, (x) => '\\' + x)}%`;

/** @param {import('../../app').AppContext} ctx */
function createPersonService(ctx) {
  const { db, audit } = ctx;

  const personComps = (id) => db.prepare('SELECT compartment_code c FROM person_compartments WHERE person_id = ? ORDER BY c').all(id).map((r) => String(r.c));
  const resP = (x) => ({ resourceType: 'person', resourceId: x.id, resourceOrgId: x.owning_org_id, resourceLevel: x.security_level, resourceCompartments: personComps(x.id) });
  const resC = (x) => ({ resourceType: 'company', resourceId: x.id, resourceOrgId: x.owning_org_id, resourceLevel: x.security_level, resourceCompartments: [] });

  function loadPerson(p, reqCtx, id) {
    const v = personVisibility(db, p);
    const x = /** @type {any} */ (db.prepare(`SELECT pe.* FROM persons pe WHERE pe.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (x) return x;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM persons WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'PERSON_ACCESS', outcome: 'DENIED', ...resP(hidden) });
    throw notFound();
  }
  function loadCompany(p, reqCtx, id) {
    const v = companyVisibility(db, p);
    const x = /** @type {any} */ (db.prepare(`SELECT co.* FROM companies co WHERE co.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (x) return x;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM companies WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'COMPANY_ACCESS', outcome: 'DENIED', ...resC(hidden) });
    throw notFound();
  }

  /** Organisation, in deren Namen angelegt wird: angegeben oder aktive/erste Mitgliedschaft mit der Permission. */
  function creatingOrg(p, code, orgId) {
    if (orgId) {
      if (!p.orgs.byId.has(orgId) || !p.isMemberWithin(orgId) || !p.has(code, orgId)) throw forbidden();
      return orgId;
    }
    const candidates = [p.activeOrgId, ...p.memberships.map((m) => m.orgId)].filter((o) => o != null && p.has(code, o));
    if (!candidates.length) throw forbidden();
    return Number(candidates[0]);
  }

  /** Beziehungen einer Person bzw. eines Unternehmens – jede einzeln geprüft. */
  function visibleLinks(p, rows) {
    const out = [];
    for (const l of rows) {
      const check = ctx.subjectVisible?.[l.subject_type];
      if (!check || !check(p, Number(l.subject_id))) continue;
      const d = ctx.subjectDescribe?.[l.subject_type]?.(Number(l.subject_id));
      if (!d) continue;
      out.push({ id: l.id, subjectType: l.subject_type, subjectId: l.subject_id, relation: l.relation, createdAt: l.created_at, ...d });
    }
    return out;
  }

  function personSummary(p, x) {
    return {
      id: x.id, personNo: x.person_no, fullName: x.full_name, aliases: x.aliases, dateOfBirth: x.date_of_birth,
      securityLevel: x.security_level, compartments: personComps(x.id), isDemo: Boolean(x.is_demo), updatedAt: x.updated_at,
      owningOrg: orgRef(p.orgs, x.owning_org_id),
    };
  }

  function personDetail(p, x) {
    const links = db.prepare('SELECT * FROM person_links WHERE person_id = ? AND removed_at IS NULL ORDER BY id DESC').all(x.id);
    const cv = companyVisibility(db, p);
    const companies = db.prepare(`SELECT cp.id, cp.role, cp.since, co.id AS company_id, co.name, co.company_no, co.status FROM company_people cp
      JOIN companies co ON co.id = cp.company_id WHERE cp.person_id = ? AND cp.removed_at IS NULL AND ${cv.sql} ORDER BY co.name`).all(x.id, ...cv.params);
    const creator = /** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(x.created_by));
    return {
      ...personSummary(p, x), description: x.description, createdAt: x.created_at, createdBy: creator?.display_name,
      links: visibleLinks(p, links),
      companies: companies.map((c) => ({ id: c.company_id, companyNo: c.company_no, name: c.name, status: c.status, role: c.role, since: c.since })),
      capabilities: { edit: p.hasAnywhere('PERSON_EDIT') || (x.created_by === p.user.id && p.hasAnywhere('PERSON_CREATE')) },
    };
  }

  function companyDetail(p, x) {
    const pv = personVisibility(db, p);
    const people = db.prepare(`SELECT cp.id, cp.role, cp.since, pe.id AS person_id, pe.full_name, pe.person_no FROM company_people cp
      JOIN persons pe ON pe.id = cp.person_id WHERE cp.company_id = ? AND cp.removed_at IS NULL AND ${pv.sql} ORDER BY cp.role, pe.full_name`).all(x.id, ...pv.params);
    const links = db.prepare('SELECT * FROM company_links WHERE company_id = ? AND removed_at IS NULL ORDER BY id DESC').all(x.id);
    return {
      id: x.id, companyNo: x.company_no, name: x.name, registrationNo: x.registration_no, address: x.address, status: x.status,
      description: x.description, securityLevel: x.security_level, isDemo: Boolean(x.is_demo), createdAt: x.created_at, updatedAt: x.updated_at,
      owningOrg: orgRef(p.orgs, x.owning_org_id),
      people: people.map((r) => ({ id: r.id, role: r.role, since: r.since, person: { id: r.person_id, fullName: r.full_name, personNo: r.person_no } })),
      links: visibleLinks(p, links),
      capabilities: { edit: p.hasAnywhere('COMPANY_EDIT') },
    };
  }

  return {
    schemas,
    loadPerson,
    loadCompany,

    // ------------------------------------------------------------ Personen
    listPersons(p, query) {
      const f = schemas.list.parse(query);
      const v = personVisibility(db, p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.q) {
        where.push("(pe.full_name LIKE ? ESCAPE '\\' OR pe.aliases LIKE ? ESCAPE '\\' OR pe.person_no LIKE ? ESCAPE '\\')");
        params.push(like(f.q), like(f.q), like(f.q));
      }
      const w = where.join(' AND ');
      const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM persons pe WHERE ${w}`).get(...params)).n);
      const rows = db.prepare(`SELECT pe.* FROM persons pe WHERE ${w} ORDER BY pe.full_name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, f.limit, f.offset);
      return { total, items: rows.map((x) => personSummary(p, x)) };
    },

    getPerson(p, reqCtx, id) {
      const x = loadPerson(p, reqCtx, id);
      audit.write({ ...reqCtx, action: 'PERSON_VIEW', ...resP(x) });
      return personDetail(p, x);
    },

    createPerson(p, reqCtx, input) {
      const d = schemas.person.parse(input);
      const orgId = creatingOrg(p, 'PERSON_CREATE', d.orgId);
      const level = d.securityLevel ?? 'INTERNAL';
      if (!p.levels.has(level)) throw badRequest('Unknown security level.');
      if (!p.clearedFor(level)) throw forbidden('You are not cleared for this security level.');
      const known = new Set(db.prepare('SELECT code FROM compartments').all().map((r) => String(r.code)));
      for (const c of d.compartments) {
        if (!known.has(c)) throw badRequest('Unknown compartment.');
        if (!p.compartments.has(c)) throw forbidden('You can only use compartments you hold.');
      }
      const id = transaction(db, () => {
        const ts = now();
        const no = nextNumber(db, 'PER');
        const { lastInsertRowid } = db.prepare(`INSERT INTO persons (person_no, full_name, aliases, date_of_birth, description, owning_org_id, security_level, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(no, d.fullName, d.aliases, d.dateOfBirth ?? null, d.description, orgId, level, p.user.id, ts, ts);
        const pid = Number(lastInsertRowid);
        for (const c of new Set(d.compartments)) db.prepare('INSERT INTO person_compartments (person_id, compartment_code) VALUES (?,?)').run(pid, c);
        const row = db.prepare('SELECT * FROM persons WHERE id = ?').get(pid);
        audit.write({ ...reqCtx, action: 'PERSON_CREATE', ...resP(row), details: { personNo: no } });
        return pid;
      });
      return personDetail(p, loadPerson(p, reqCtx, id));
    },

    updatePerson(p, reqCtx, id, input) {
      const d = schemas.personUpdate.parse(input);
      const x = loadPerson(p, reqCtx, id);
      if (!personDetail(p, x).capabilities.edit) throw forbidden();
      transaction(db, () => {
        db.prepare(`UPDATE persons SET full_name = COALESCE(?, full_name), aliases = COALESCE(?, aliases),
          date_of_birth = CASE WHEN ? THEN ? ELSE date_of_birth END, description = COALESCE(?, description), updated_at = ? WHERE id = ?`)
          .run(d.fullName ?? null, d.aliases ?? null, d.dateOfBirth !== undefined ? 1 : 0, d.dateOfBirth ?? null, d.description ?? null, now(), id);
        audit.write({ ...reqCtx, action: 'PERSON_EDIT', ...resP(x), details: { fields: Object.keys(d) } });
      });
      return personDetail(p, loadPerson(p, reqCtx, id));
    },

    /**
     * Beziehung anlegen (von Fachmodulen innerhalb ihrer Transaktion aufgerufen; der Aufrufer hat die Berechtigung
     * am Gegenstand geprüft). Doppelte aktive Beziehungen werden nicht angelegt.
     */
    link(p, personId, subjectType, subjectId, relation) {
      if (db.prepare('SELECT 1 FROM person_links WHERE person_id = ? AND subject_type = ? AND subject_id = ? AND relation = ? AND removed_at IS NULL')
        .get(personId, subjectType, subjectId, relation)) return;
      db.prepare('INSERT INTO person_links (person_id, subject_type, subject_id, relation, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(personId, subjectType, subjectId, relation, p?.user.id ?? null, now());
    },

    unlink(p, personId, subjectType, subjectId, relation) {
      db.prepare('UPDATE person_links SET removed_at = ?, removed_by = ? WHERE person_id = ? AND subject_type = ? AND subject_id = ? AND relation = ? AND removed_at IS NULL')
        .run(now(), p?.user.id ?? null, personId, subjectType, subjectId, relation);
    },

    // ------------------------------------------------------------ Unternehmen
    listCompanies(p, query) {
      const f = schemas.list.parse(query);
      const v = companyVisibility(db, p);
      const where = [v.sql];
      /** @type {any[]} */
      const params = [...v.params];
      if (f.q) {
        where.push("(co.name LIKE ? ESCAPE '\\' OR co.registration_no LIKE ? ESCAPE '\\' OR co.company_no LIKE ? ESCAPE '\\')");
        params.push(like(f.q), like(f.q), like(f.q));
      }
      const w = where.join(' AND ');
      const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM companies co WHERE ${w}`).get(...params)).n);
      const rows = db.prepare(`SELECT co.* FROM companies co WHERE ${w} ORDER BY co.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, f.limit, f.offset);
      return { total, items: rows.map((x) => ({ id: x.id, companyNo: x.company_no, name: x.name, registrationNo: x.registration_no,
        address: x.address, status: x.status, isDemo: Boolean(x.is_demo), updatedAt: x.updated_at })) };
    },

    getCompany(p, reqCtx, id) {
      const x = loadCompany(p, reqCtx, id);
      audit.write({ ...reqCtx, action: 'COMPANY_VIEW', ...resC(x) });
      return companyDetail(p, x);
    },

    createCompany(p, reqCtx, input) {
      const d = schemas.company.parse(input);
      const orgId = creatingOrg(p, 'COMPANY_EDIT', d.orgId);
      const id = transaction(db, () => {
        const ts = now();
        const no = nextNumber(db, 'CO');
        const { lastInsertRowid } = db.prepare(`INSERT INTO companies (company_no, name, registration_no, address, description, owning_org_id, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(no, d.name, d.registrationNo, d.address, d.description, orgId, p.user.id, ts, ts);
        const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(lastInsertRowid);
        audit.write({ ...reqCtx, action: 'COMPANY_CREATE', ...resC(row), details: { companyNo: no } });
        return Number(lastInsertRowid);
      });
      return companyDetail(p, loadCompany(p, reqCtx, id));
    },

    updateCompany(p, reqCtx, id, input) {
      const d = schemas.companyUpdate.parse(input);
      const x = loadCompany(p, reqCtx, id);
      if (!p.hasAnywhere('COMPANY_EDIT')) throw forbidden();
      transaction(db, () => {
        db.prepare(`UPDATE companies SET name = COALESCE(?, name), registration_no = COALESCE(?, registration_no), address = COALESCE(?, address),
          description = COALESCE(?, description), status = COALESCE(?, status), updated_at = ? WHERE id = ?`)
          .run(d.name ?? null, d.registrationNo ?? null, d.address ?? null, d.description ?? null, d.status ?? null, now(), id);
        audit.write({ ...reqCtx, action: 'COMPANY_EDIT', ...resC(x), details: d });
      });
      return companyDetail(p, loadCompany(p, reqCtx, id));
    },

    addCompanyPerson(p, reqCtx, companyId, input) {
      const d = schemas.companyPerson.parse(input);
      const x = loadCompany(p, reqCtx, companyId);
      if (!p.hasAnywhere('COMPANY_EDIT')) throw forbidden();
      let person;
      try { person = loadPerson(p, null, d.personId); } catch { throw badRequest('The person was not found.', [{ field: 'personId', message: 'Unknown person.' }]); }
      if (db.prepare('SELECT 1 FROM company_people WHERE company_id = ? AND person_id = ? AND role = ? AND removed_at IS NULL').get(companyId, d.personId, d.role)) {
        throw conflict('This person already holds this role.');
      }
      transaction(db, () => {
        db.prepare('INSERT INTO company_people (company_id, person_id, role, since, added_by, added_at) VALUES (?,?,?,?,?,?)')
          .run(companyId, d.personId, d.role, d.since ?? null, p.user.id, now());
        db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(now(), companyId);
        audit.write({ ...reqCtx, action: 'COMPANY_PERSON_ADD', ...resC(x), details: { personId: person.id, role: d.role } });
      });
      return companyDetail(p, loadCompany(p, reqCtx, companyId));
    },

    removeCompanyPerson(p, reqCtx, companyId, entryId) {
      const x = loadCompany(p, reqCtx, companyId);
      if (!p.hasAnywhere('COMPANY_EDIT')) throw forbidden();
      const e = /** @type {any} */ (db.prepare('SELECT * FROM company_people WHERE id = ? AND company_id = ? AND removed_at IS NULL').get(entryId, companyId));
      if (!e) throw notFound();
      transaction(db, () => {
        db.prepare('UPDATE company_people SET removed_at = ?, removed_by = ? WHERE id = ?').run(now(), p.user.id, entryId);
        audit.write({ ...reqCtx, action: 'COMPANY_PERSON_REMOVE', ...resC(x), details: { personId: e.person_id, role: e.role } });
      });
      return companyDetail(p, loadCompany(p, reqCtx, companyId));
    },

    /** Unternehmens-Beziehung (analog link) */
    linkCompany(p, companyId, subjectType, subjectId, relation) {
      if (db.prepare('SELECT 1 FROM company_links WHERE company_id = ? AND subject_type = ? AND subject_id = ? AND relation = ? AND removed_at IS NULL')
        .get(companyId, subjectType, subjectId, relation)) return;
      db.prepare('INSERT INTO company_links (company_id, subject_type, subject_id, relation, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(companyId, subjectType, subjectId, relation, p?.user.id ?? null, now());
    },

    /** Sichtbare Personen-IDs (Tests, Auswahlfelder). */
    visiblePersonIds(p, ids) {
      if (!ids.length) return [];
      const v = personVisibility(db, p);
      return db.prepare(`SELECT pe.id FROM persons pe WHERE pe.id IN (${inList(ids)}) AND ${v.sql}`).all(...ids, ...v.params).map((r) => Number(r.id));
    },
  };
}

module.exports = { createPersonService };
