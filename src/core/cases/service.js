// @ts-check
'use strict';
/**
 * Case Management (prompt.txt 6.1, PERMISSIONS.md 5, SECURITY_MODEL.md 4–7).
 *
 * Jede Operation:
 *   1. lädt die Akte nur über das Sichtbarkeitsprädikat (unsichtbar = 404, wie nicht existent),
 *   2. prüft die Aktion (Permission im Scope der besitzenden Organisation + Beteiligung/Zugang),
 *   3. schreibt Änderung, Timeline-Eintrag und Audit-Eintrag in einer Transaktion.
 */
const { z } = require('zod');
const { transaction, now, inList, parseJson } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { caseVisibility } = require('./visibility');
const { nextNumber } = require('../numbers');
const { assertFeature } = require('../admin/config');
const { orgRef } = require('../users/me');
const { loadPrincipal } = require('../authz/principal');
const { personVisibility } = require('../persons/visibility');

const PARTICIPANT_ROLES = ['LEAD', 'INVESTIGATOR', 'PROSECUTOR', 'JUDGE', 'CLERK', 'DEPUTY', 'OFFICER', 'REGISTRAR', 'COUNSEL',
  'DEFENDANT', 'PLAINTIFF', 'RESPONDENT', 'APPLICANT', 'VICTIM', 'WITNESS', 'OBSERVER'];
const LINK_TYPES = ['ESCALATED_TO', 'APPEAL_OF', 'REVIEW_OF', 'RELATED', 'ORIGINATED_FROM'];

const id = z.number().int().positive();
const reason = z.string().trim().min(3).max(1000);

const schemas = {
  create: z.object({
    typeCode: z.string().min(2).max(40),
    orgId: id,
    title: z.string().trim().min(3).max(200),
    summary: z.string().trim().max(10_000).default(''),
    securityProfile: z.string().min(2).max(40).optional(),
  }),
  update: z.object({ title: z.string().trim().min(3).max(200).optional(), summary: z.string().trim().max(10_000).optional() }),
  list: z.object({
    q: z.string().trim().max(100).optional(),
    type: z.string().max(40).optional(),
    status: z.enum(['OPEN', 'ACTIVE', 'CLOSED', 'ARCHIVED', 'OPEN_OR_ACTIVE']).optional(),
    orgId: z.coerce.number().int().positive().optional(),
    mine: z.enum(['0', '1']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  participant: z.object({
    userId: id.optional(),
    personId: id.optional(),
    partyName: z.string().trim().min(2).max(200).optional(),
    role: z.enum(/** @type {[string, ...string[]]} */ (PARTICIPANT_ROLES)),
    grantsAccess: z.boolean().default(true),
    sealedAccess: z.boolean().default(false),
    isPresiding: z.boolean().default(false),
  }).refine((d) => [d.userId, d.personId, d.partyName].filter(Boolean).length === 1, { message: 'Specify either a user, a person record or a party name.' }),
  access: z.object({
    subjectType: z.enum(['USER', 'ROLE', 'ORG']),
    subjectId: id,
    level: z.enum(['VIEW', 'EDIT', 'MANAGE']).default('VIEW'),
    sealedAccess: z.boolean().default(false),
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
    reason,
  }),
  reasonOnly: z.object({ reason }),
  seal: z.object({ reason, keepUserIds: z.array(id).max(100).default([]) }),
  security: z.object({ profile: z.string().min(2).max(40), reason }),
  transfer: z.object({ orgId: id, reason }),
  link: z.object({ toCaseId: id, linkType: z.enum(/** @type {[string, ...string[]]} */ (LINK_TYPES)) }),
};

/** @param {import('../../app').AppContext} ctx */
function createCaseService(ctx) {
  const { db, audit } = ctx;

  const typeOf = (code) => /** @type {any} */ (db.prepare('SELECT * FROM case_types WHERE code = ?').get(code));
  const profileOf = (code) => {
    const r = /** @type {any} */ (db.prepare('SELECT * FROM security_profiles WHERE code = ?').get(code));
    return r ? { ...r, compartments: parseJson(r.compartments, []) } : null;
  };
  const compartmentsOf = (caseId) => db.prepare('SELECT compartment_code FROM case_compartments WHERE case_id = ? ORDER BY compartment_code')
    .all(caseId).map((r) => String(r.compartment_code));

  /** Audit-Felder einer Akte (Level/Compartments steuern, wer den Eintrag später sehen darf). */
  const res = (c) => ({ resourceType: 'case', resourceId: c.id, resourceOrgId: c.owning_org_id, resourceLevel: c.security_level, resourceCompartments: compartmentsOf(c.id) });

  const event = (caseId, type, actorId, summary, payload = {}) =>
    db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(caseId, type, actorId, summary, JSON.stringify(payload), now());

  /** Personenakte ↔ Akte (die Beziehung sieht nur, wer die Akte sieht). */
  const linkPerson = (p, personId, caseId, relation) => {
    if (db.prepare("SELECT 1 FROM person_links WHERE person_id = ? AND subject_type = 'case' AND subject_id = ? AND relation = ? AND removed_at IS NULL").get(personId, caseId, relation)) return;
    db.prepare("INSERT INTO person_links (person_id, subject_type, subject_id, relation, created_by, created_at) VALUES (?, 'case', ?, ?, ?, ?)").run(personId, caseId, relation, p.user.id, now());
  };

  const touch = (caseId) => db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), caseId);

  /**
   * Lädt eine sichtbare Akte oder wirft 404. Zugriffe auf existierende, aber unsichtbare Akten werden als DENIED
   * auditiert – mit Level/Compartments der Akte, damit nur entsprechend berechtigte Auditoren sie sehen.
   * @param {import('../authz/principal').Principal} p @param {any} reqCtx @param {number} caseId
   */
  function loadVisible(p, reqCtx, caseId) {
    const v = caseVisibility(db, p);
    const c = /** @type {any} */ (db.prepare(`SELECT c.* FROM cases c WHERE c.id = ? AND ${v.sql}`).get(caseId, ...v.params));
    if (c) return c;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'CASE_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  const participantOf = (p, caseId) => /** @type {any} */ (db.prepare(`SELECT * FROM case_participants
    WHERE case_id = ? AND user_id = ? AND removed_at IS NULL AND grants_access = 1 ORDER BY role = 'LEAD' DESC LIMIT 1`).get(caseId, p.user.id));
  const userAccessLevel = (p, caseId) => {
    const r = /** @type {any} */ (db.prepare(`SELECT level FROM case_access WHERE case_id = ? AND subject_type = 'USER' AND subject_id = ?
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY CASE level WHEN 'MANAGE' THEN 3 WHEN 'EDIT' THEN 2 ELSE 1 END DESC LIMIT 1`).get(caseId, p.user.id, now()));
    return r?.level ?? null;
  };

  /** Fähigkeiten des Benutzers an einer (sichtbaren) Akte – Grundlage für API-Prüfung und UI. */
  function capabilities(p, c) {
    const type = typeOf(c.type_code);
    const org = c.owning_org_id;
    const part = participantOf(p, c.id);
    const lvl = userAccessLevel(p, c.id);
    const supervisor = p.has('CASE_ASSIGN', org);
    const isOpen = c.status === 'OPEN' || c.status === 'ACTIVE';
    const involved = Boolean(part) || lvl === 'EDIT' || lvl === 'MANAGE' || (type?.edit_scope === 'PARTICIPANTS_AND_SUPERVISORS' && supervisor);
    const sealing = Boolean(db.prepare("SELECT 1 FROM feature_flags WHERE code = 'SEALING' AND enabled = 1").get());
    return {
      edit: isOpen && p.has('CASE_EDIT', org) && involved,
      assign: isOpen && (supervisor || ((part?.role === 'LEAD' || lvl === 'MANAGE') && p.has('CASE_EDIT', org))),
      share: isOpen && p.has('CASE_SHARE', org),
      seal: sealing && !c.is_sealed && p.has('CASE_SEAL', org),
      unseal: sealing && Boolean(c.is_sealed) && p.has('CASE_UNSEAL', org),
      close: isOpen && p.has('CASE_CLOSE', org) && involved,
      reopen: c.status === 'CLOSED' && p.has('CASE_CLOSE', org) && (Boolean(part) || supervisor),
      archive: c.status === 'CLOSED' && p.has('CASE_ARCHIVE', org),
      transfer: isOpen && p.has('CASE_TRANSFER', org),
      link: isOpen && p.hasAnywhere('CASE_LINK') && (involved || supervisor),
      security: isOpen && supervisor,
      viewAccessList: p.has('CASE_SHARE', org) || supervisor,
      // Dokumente anlegen: Beteiligte, Bearbeiter mit EDIT/MANAGE und Vorgesetzte – jeweils mit DOCUMENT_CREATE
      addDocument: isOpen && p.has('DOCUMENT_CREATE', org) && (Boolean(part) || lvl === 'EDIT' || lvl === 'MANAGE' || supervisor),
    };
  }

  /** @param {import('../authz/principal').Principal} p @param {string} cap @param {any} c */
  function requireCap(p, cap, c) {
    if (!capabilities(p, c)[cap]) throw forbidden();
  }

  function detail(p, c) {
    const type = typeOf(c.type_code);
    const caps = capabilities(p, c);
    const creator = /** @type {any} */ (db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(c.created_by));
    const participants = db.prepare(`SELECT cp.*, u.display_name AS user_name FROM case_participants cp LEFT JOIN users u ON u.id = cp.user_id
      WHERE cp.case_id = ? AND cp.removed_at IS NULL ORDER BY cp.is_presiding DESC, cp.id`).all(c.id);
    const flag = type?.feature_flag ? /** @type {any} */ (db.prepare('SELECT enabled, legal_status FROM feature_flags WHERE code = ?').get(type.feature_flag)) : null;
    return {
      id: c.id, caseNumber: c.case_number, title: c.title, summary: c.summary, status: c.status,
      type: { code: c.type_code, name: type?.name ?? c.type_code },
      owningOrg: orgRef(p.orgs, c.owning_org_id),
      securityProfile: c.security_profile, securityLevel: c.security_level, compartments: compartmentsOf(c.id),
      isSealed: Boolean(c.is_sealed), requiresExplicitAccess: Boolean(c.requires_explicit_access), isDemo: Boolean(c.is_demo),
      legalStatus: flag ? flag.legal_status : type?.legal_status ?? 'NOT_VERIFIED',
      createdBy: creator ? { id: creator.id, name: creator.display_name } : null,
      createdAt: c.created_at, updatedAt: c.updated_at, closedAt: c.closed_at, archivedAt: c.archived_at,
      participants: participants.map((x) => ({
        id: x.id, role: x.role, isPresiding: Boolean(x.is_presiding), grantsAccess: Boolean(x.grants_access), sealedAccess: Boolean(x.sealed_access),
        user: x.user_id ? { id: x.user_id, name: x.user_name } : null, partyName: x.party_name, personId: x.person_id, addedAt: x.added_at,
      })),
      access: caps.viewAccessList ? accessList(p, c.id) : null,
      links: links(p, c.id),
      capabilities: caps,
      transferTargets: caps.transfer
        ? db.prepare('SELECT org_id FROM case_type_orgs WHERE type_code = ? AND org_id <> ?').all(c.type_code, c.owning_org_id).map((o) => orgRef(p.orgs, Number(o.org_id)))
        : [],
    };
  }

  function accessList(p, caseId) {
    return db.prepare(`SELECT a.*, u.display_name AS user_name, r.name AS role_name FROM case_access a
      LEFT JOIN users u ON a.subject_type = 'USER' AND u.id = a.subject_id
      LEFT JOIN roles r ON a.subject_type = 'ROLE' AND r.id = a.subject_id
      WHERE a.case_id = ? AND a.revoked_at IS NULL ORDER BY a.id`).all(caseId).map((a) => ({
      id: a.id, subjectType: a.subject_type, subjectId: a.subject_id, level: a.level, sealedAccess: Boolean(a.sealed_access),
      isDefault: Boolean(a.is_default), reason: a.reason, createdAt: a.created_at, expiresAt: a.expires_at,
      subject: a.subject_type === 'USER' ? a.user_name : a.subject_type === 'ROLE' ? a.role_name : orgRef(p.orgs, Number(a.subject_id))?.name,
    }));
  }

  /** Verknüpfungen – nur solche, deren andere Seite ebenfalls sichtbar ist (SECURITY_MODEL.md 7). */
  function links(p, caseId) {
    const v = caseVisibility(db, p, { alias: 'o' });
    return db.prepare(`SELECT l.id, l.link_type, l.created_at, l.from_case_id, o.id AS other_id, o.case_number, o.title, o.type_code, o.status
      FROM case_links l JOIN cases o ON o.id = CASE WHEN l.from_case_id = ? THEN l.to_case_id ELSE l.from_case_id END
      WHERE (l.from_case_id = ? OR l.to_case_id = ?) AND l.removed_at IS NULL AND ${v.sql}
      ORDER BY l.id`).all(caseId, caseId, caseId, ...v.params).map((l) => ({
      id: l.id, linkType: l.link_type, direction: l.from_case_id === caseId ? 'OUTGOING' : 'INCOMING', createdAt: l.created_at,
      case: { id: l.other_id, caseNumber: l.case_number, title: l.title, typeCode: l.type_code, status: l.status },
    }));
  }

  /** Kann Benutzer u (mit Principal up) eine Akte mit diesen Sicherheitsmerkmalen überhaupt sehen? */
  const clearedForCase = (up, level, compartments) => up.clearedFor(level) && up.holdsCompartments(compartments);

  return {
    schemas,
    capabilities,
    loadVisible,

    /** Case Types, die der Benutzer anlegen darf, mit zulässigen Organisationen. */
    creatableTypes(p) {
      const types = db.prepare('SELECT * FROM case_types WHERE is_enabled = 1 ORDER BY sort_order').all();
      const orgs = db.prepare('SELECT * FROM case_type_orgs').all();
      const flags = new Map(db.prepare('SELECT code, enabled, legal_status FROM feature_flags').all().map((f) => [f.code, f]));
      return types.map((t) => {
        const f = t.feature_flag ? /** @type {any} */ (flags.get(t.feature_flag)) : null;
        const profile = profileOf(t.default_security_profile);
        return {
          code: t.code, name: t.name, defaultSecurityProfile: t.default_security_profile,
          enabled: !f || Boolean(f.enabled), legalStatus: f ? f.legal_status : t.legal_status,
          orgs: orgs.filter((o) => o.type_code === t.code && p.has('CASE_CREATE', Number(o.org_id)) && clearedForCase(p, profile.level_code, profile.compartments))
            .map((o) => ({ ...orgRef(p.orgs, Number(o.org_id)), numberPrefix: o.number_prefix })),
        };
      }).filter((t) => t.orgs.length);
    },

    profiles(p) {
      return db.prepare('SELECT * FROM security_profiles ORDER BY code').all()
        .map((r) => ({ code: r.code, name: r.name, level: r.level_code, compartments: parseJson(r.compartments, []), requiresExplicitAccess: Boolean(r.requires_explicit_access) }))
        .filter((r) => clearedForCase(p, r.level, r.compartments));
    },

    create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      const type = typeOf(d.typeCode);
      if (!type || !type.is_enabled) throw badRequest('Unknown or disabled case type.');
      if (type.feature_flag) assertFeature(db, type.feature_flag);
      const allowed = /** @type {any} */ (db.prepare('SELECT * FROM case_type_orgs WHERE type_code = ? AND org_id = ?').get(d.typeCode, d.orgId));
      if (!allowed) throw badRequest('This organization cannot hold cases of this type.');
      if (!p.has('CASE_CREATE', d.orgId)) throw forbidden();

      // Sicherheitsprofil: mindestens so streng wie der Typ-Standard, und der Ersteller muss es selbst erfüllen
      const base = profileOf(type.default_security_profile);
      const profile = profileOf(d.securityProfile ?? type.default_security_profile);
      if (!profile) throw badRequest('Unknown security profile.');
      if ((p.levels.get(profile.level_code) ?? 0) < (p.levels.get(base.level_code) ?? 0) || !base.compartments.every((x) => profile.compartments.includes(x))) {
        throw badRequest(`Cases of this type require at least the security profile ${base.name}.`);
      }
      if (!clearedForCase(p, profile.level_code, profile.compartments)) {
        throw forbidden('Your clearance or compartments do not cover this security profile.');
      }

      const created = transaction(db, () => {
        const ts = now();
        const number = nextNumber(db, allowed.number_prefix);
        const { lastInsertRowid } = db.prepare(`INSERT INTO cases (case_number, type_code, title, summary, owning_org_id, security_profile,
          security_level, requires_explicit_access, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(number, d.typeCode, d.title, d.summary, d.orgId, profile.code, profile.level_code, profile.requires_explicit_access, p.user.id, ts, ts);
        const caseId = Number(lastInsertRowid);
        for (const comp of profile.compartments) db.prepare('INSERT INTO case_compartments (case_id, compartment_code) VALUES (?,?)').run(caseId, comp);
        db.prepare(`INSERT INTO case_participants (case_id, user_id, role, grants_access, sealed_access, added_by, added_at)
          VALUES (?, ?, 'LEAD', 1, 0, ?, ?)`).run(caseId, p.user.id, p.user.id, ts);
        if (type.default_org_access) {
          db.prepare(`INSERT INTO case_access (case_id, subject_type, subject_id, level, is_default, granted_by, reason, created_at)
            VALUES (?, 'ORG', ?, 'VIEW', 1, ?, 'Office visibility (default)', ?)`).run(caseId, d.orgId, p.user.id, ts);
        }
        event(caseId, 'CASE_CREATED', p.user.id, `Case ${number} created`, { typeCode: d.typeCode });
        const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
        audit.write({ ...reqCtx, action: 'CASE_CREATE', ...res(c), details: { caseNumber: number, typeCode: d.typeCode } });
        return c;
      });
      return detail(p, created);
    },

    /** @param {import('../authz/principal').Principal} p */
    list(p, query) {
      const f = schemas.list.parse(query);
      const v = caseVisibility(db, p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.q) {
        where.push("(c.case_number LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')");
        const like = `%${f.q.replace(/[\\%_]/g, (x) => '\\' + x)}%`;
        params.push(like, like);
      }
      if (f.type) { where.push('c.type_code = ?'); params.push(f.type); }
      if (f.status === 'OPEN_OR_ACTIVE') where.push("c.status IN ('OPEN','ACTIVE')");
      else if (f.status) { where.push('c.status = ?'); params.push(f.status); }
      if (f.orgId) { const sub = p.orgs.subtree(f.orgId); where.push(`c.owning_org_id IN (${inList(sub)})`); params.push(...sub); }
      if (f.mine === '1') {
        where.push('EXISTS (SELECT 1 FROM case_participants mp WHERE mp.case_id = c.id AND mp.user_id = ? AND mp.removed_at IS NULL)');
        params.push(p.user.id);
      }
      const w = where.join(' AND ');
      const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM cases c WHERE ${w}`).get(...params)).n);
      const rows = db.prepare(`SELECT c.*, t.name AS type_name FROM cases c JOIN case_types t ON t.code = c.type_code
        WHERE ${w} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`).all(...params, f.limit, f.offset);
      return {
        total,
        items: rows.map((c) => ({
          id: c.id, caseNumber: c.case_number, title: c.title, status: c.status, type: { code: c.type_code, name: c.type_name },
          owningOrg: orgRef(p.orgs, Number(c.owning_org_id)), securityLevel: c.security_level, isSealed: Boolean(c.is_sealed),
          isDemo: Boolean(c.is_demo), updatedAt: c.updated_at,
        })),
      };
    },

    get(p, reqCtx, caseId) {
      const c = loadVisible(p, reqCtx, caseId);
      audit.write({ ...reqCtx, action: 'CASE_VIEW', ...res(c) });
      return detail(p, c);
    },

    timeline(p, reqCtx, caseId) {
      loadVisible(p, reqCtx, caseId);
      return db.prepare(`SELECT e.*, u.display_name AS actor_name FROM case_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.case_id = ? ORDER BY e.id DESC LIMIT 500`).all(caseId).map((e) => ({
        id: e.id, type: e.type, summary: e.summary, payload: parseJson(e.payload, {}), createdAt: e.created_at,
        actor: e.actor_user_id ? { id: e.actor_user_id, name: e.actor_name } : null,
      }));
    },

    update(p, reqCtx, caseId, input) {
      const d = schemas.update.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'edit', c);
      transaction(db, () => {
        db.prepare('UPDATE cases SET title = COALESCE(?, title), summary = COALESCE(?, summary), status = CASE WHEN status = \'OPEN\' THEN \'ACTIVE\' ELSE status END, updated_at = ? WHERE id = ?')
          .run(d.title ?? null, d.summary ?? null, now(), caseId);
        event(caseId, 'CASE_UPDATED', p.user.id, 'Case details updated', { fields: Object.keys(d) });
        audit.write({ ...reqCtx, action: 'CASE_EDIT', ...res(c), details: { fields: Object.keys(d) } });
      });
      return detail(p, loadVisible(p, reqCtx, caseId));
    },

    addParticipant(p, reqCtx, caseId, input) {
      const d = schemas.participant.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'assign', c);
      let summary;
      if (d.userId) {
        const u = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(d.userId));
        if (!u) throw badRequest('Unknown or inactive user.');
        const up = loadPrincipal(db, u, { orgs: p.orgs });
        // Außerhalb des eigenen Office beteiligen = teilen → CASE_SHARE
        if (!up.isMemberWithin(c.owning_org_id) && !p.has('CASE_SHARE', c.owning_org_id)) {
          throw forbidden('Adding users from other offices requires the permission to share cases.');
        }
        if (d.grantsAccess && !clearedForCase(up, c.security_level, compartmentsOf(c.id))) {
          throw badRequest('This user lacks the clearance or compartments required for this case.');
        }
        if (db.prepare('SELECT 1 FROM case_participants WHERE case_id = ? AND user_id = ? AND role = ? AND removed_at IS NULL').get(caseId, d.userId, d.role)) {
          throw conflict('This user already participates in this role.');
        }
        summary = `${u.display_name} added as ${d.role}`;
      } else if (d.personId) {
        // Personenakte: nur sichtbare Personen; der Name wird als Momentaufnahme übernommen
        const pv = personVisibility(db, p);
        const person = /** @type {any} */ (db.prepare(`SELECT pe.* FROM persons pe WHERE pe.id = ? AND ${pv.sql}`).get(d.personId, ...pv.params));
        if (!person) throw badRequest('The person was not found.', [{ field: 'personId', message: 'Unknown person.' }]);
        d.partyName = person.full_name;
        d.grantsAccess = false;
        summary = `${person.full_name} (${person.person_no}) added as ${d.role}`;
      } else {
        if (d.grantsAccess) d.grantsAccess = false; // externe Parteien haben kein Benutzerkonto
        summary = `${d.partyName} added as ${d.role}`;
      }
      if (d.sealedAccess && !p.has('CASE_SEAL', c.owning_org_id)) throw forbidden('Only users who may seal cases can grant access to sealed content.');
      transaction(db, () => {
        const ts = now();
        db.prepare(`INSERT INTO case_participants (case_id, user_id, person_id, party_name, role, grants_access, sealed_access, is_presiding, added_by, added_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(caseId, d.userId ?? null, d.personId ?? null, d.partyName ?? null, d.role, d.grantsAccess ? 1 : 0, d.sealedAccess ? 1 : 0, d.isPresiding ? 1 : 0, p.user.id, ts);
        if (d.personId) linkPerson(p, d.personId, caseId, d.role);
        touch(caseId);
        event(caseId, 'PARTICIPANT_ADDED', p.user.id, summary, { role: d.role, userId: d.userId ?? null });
        audit.write({ ...reqCtx, action: 'CASE_PARTICIPANT_ADD', ...res(c), details: { role: d.role, userId: d.userId ?? null, partyName: d.partyName ?? null } });
        if (d.userId && d.grantsAccess) {
          ctx.notify?.toUsers([d.userId], { type: 'CASE_PARTICIPANT_ADDED', title: `You were added to case ${c.case_number}`, body: `${c.title} · role ${d.role.toLowerCase()}`,
            link: `/app/cases/${c.id}`, subjectType: 'case', subjectId: c.id, level: c.security_level, compartments: compartmentsOf(c.id), sealed: Boolean(c.is_sealed) }, { exceptUserId: p.user.id });
        }
      });
      return detail(p, c);
    },

    removeParticipant(p, reqCtx, caseId, participantId, input) {
      const { reason: why } = schemas.reasonOnly.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'assign', c);
      const part = /** @type {any} */ (db.prepare('SELECT * FROM case_participants WHERE id = ? AND case_id = ? AND removed_at IS NULL').get(participantId, caseId));
      if (!part) throw notFound();
      if (part.role === 'LEAD' && Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) n FROM case_participants WHERE case_id = ? AND role = 'LEAD' AND removed_at IS NULL").get(caseId)).n) === 1) {
        throw conflict('A case needs a lead. Assign another lead first.');
      }
      transaction(db, () => {
        db.prepare('UPDATE case_participants SET removed_at = ?, removed_by = ? WHERE id = ?').run(now(), p.user.id, participantId);
        if (part.person_id) {
          db.prepare(`UPDATE person_links SET removed_at = ?, removed_by = ? WHERE person_id = ? AND subject_type = 'case' AND subject_id = ? AND relation = ? AND removed_at IS NULL`)
            .run(now(), p.user.id, part.person_id, caseId, part.role);
        }
        touch(caseId);
        event(caseId, 'PARTICIPANT_REMOVED', p.user.id, `Participant removed (${part.role})`, { participantId, reason: why });
        audit.write({ ...reqCtx, action: 'CASE_PARTICIPANT_REMOVE', ...res(c), details: { participantId, role: part.role, userId: part.user_id, reason: why } });
      });
      return detail(p, loadVisible(p, reqCtx, caseId));
    },

    grantAccess(p, reqCtx, caseId, input) {
      const d = schemas.access.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'share', c);
      if (d.subjectType === 'USER') {
        const u = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(d.subjectId));
        if (!u) throw badRequest('Unknown or inactive user.');
        if (!clearedForCase(loadPrincipal(db, u, { orgs: p.orgs }), c.security_level, compartmentsOf(c.id))) {
          throw badRequest('This user lacks the clearance or compartments required for this case.');
        }
      } else if (d.subjectType === 'ROLE') {
        if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(d.subjectId)) throw badRequest('Unknown role.');
      } else if (!p.orgs.byId.has(d.subjectId)) {
        throw badRequest('Unknown organization.');
      }
      if (d.subjectType !== 'USER' && d.sealedAccess) throw badRequest('Sealed access can only be granted to individual users.');
      if (d.sealedAccess && !p.has('CASE_SEAL', c.owning_org_id)) throw forbidden();
      if (d.level !== 'VIEW' && d.subjectType !== 'USER') throw badRequest('Edit or manage access can only be granted to individual users.');
      transaction(db, () => {
        db.prepare(`INSERT INTO case_access (case_id, subject_type, subject_id, level, sealed_access, granted_by, reason, created_at, expires_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(caseId, d.subjectType, d.subjectId, d.level, d.sealedAccess ? 1 : 0, p.user.id, d.reason, now(),
          d.expiresAt ? new Date(d.expiresAt).toISOString() : null);
        touch(caseId);
        event(caseId, 'ACCESS_GRANTED', p.user.id, `${d.level} access granted (${d.subjectType})`, { subjectType: d.subjectType, subjectId: d.subjectId, level: d.level, expiresAt: d.expiresAt });
        audit.write({ ...reqCtx, action: 'CASE_SHARE', ...res(c), details: d });
      });
      return detail(p, c);
    },

    revokeAccess(p, reqCtx, caseId, accessId, input) {
      const { reason: why } = schemas.reasonOnly.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'share', c);
      const a = /** @type {any} */ (db.prepare('SELECT * FROM case_access WHERE id = ? AND case_id = ? AND revoked_at IS NULL').get(accessId, caseId));
      if (!a) throw notFound();
      transaction(db, () => {
        db.prepare('UPDATE case_access SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(now(), p.user.id, accessId);
        touch(caseId);
        event(caseId, 'ACCESS_REVOKED', p.user.id, `Access revoked (${a.subject_type})`, { accessId, reason: why });
        audit.write({ ...reqCtx, action: 'CASE_ACCESS_REVOKE', ...res(c), details: { accessId, subjectType: a.subject_type, subjectId: a.subject_id, reason: why } });
      });
      return detail(p, c);
    },

    /** Schließen / Wiedereröffnen / Archivieren */
    setStatus(p, reqCtx, caseId, action, input) {
      const { reason: why } = schemas.reasonOnly.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      const map = { close: ['close', 'CLOSED', 'CASE_CLOSED'], reopen: ['reopen', 'ACTIVE', 'CASE_REOPENED'], archive: ['archive', 'ARCHIVED', 'CASE_ARCHIVED'] };
      const [cap, status, evt] = map[action];
      requireCap(p, cap, c);
      transaction(db, () => {
        const ts = now();
        db.prepare(`UPDATE cases SET status = ?, updated_at = ?, closed_at = CASE WHEN ? = 'CLOSED' THEN ? WHEN ? = 'ACTIVE' THEN NULL ELSE closed_at END,
          archived_at = CASE WHEN ? = 'ARCHIVED' THEN ? ELSE archived_at END WHERE id = ?`).run(status, ts, status, ts, status, status, ts, caseId);
        event(caseId, evt, p.user.id, `Case ${status.toLowerCase()}`, { reason: why });
        audit.write({ ...reqCtx, action: `CASE_${action.toUpperCase()}`, ...res(c), details: { reason: why } });
      });
      return detail(p, loadVisible(p, reqCtx, caseId));
    },

    seal(p, reqCtx, caseId, input) {
      const d = schemas.seal.parse(input);
      assertFeature(db, 'SEALING');
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'seal', c);
      transaction(db, () => {
        const ts = now();
        db.prepare('UPDATE cases SET is_sealed = 1, updated_at = ? WHERE id = ?').run(ts, caseId);
        // Wer versiegelt, behält Zugang; weitere Beteiligte nur, wenn ausdrücklich benannt
        const keep = new Set([p.user.id, ...d.keepUserIds]);
        for (const uid of keep) {
          const updated = db.prepare('UPDATE case_participants SET sealed_access = 1 WHERE case_id = ? AND user_id = ? AND removed_at IS NULL AND grants_access = 1').run(caseId, uid);
          if (!updated.changes && uid === p.user.id) {
            db.prepare(`INSERT INTO case_access (case_id, subject_type, subject_id, level, sealed_access, granted_by, reason, created_at)
              VALUES (?, 'USER', ?, 'MANAGE', 1, ?, 'Retained access when sealing', ?)`).run(caseId, uid, uid, ts);
          }
        }
        event(caseId, 'CASE_SEALED', p.user.id, 'Case sealed', { reason: d.reason, retained: [...keep] });
        audit.write({ ...reqCtx, action: 'CASE_SEAL', ...res(c), details: { reason: d.reason, retainedUserIds: [...keep] } });
      });
      return detail(p, loadVisible(p, reqCtx, caseId));
    },

    unseal(p, reqCtx, caseId, input) {
      const { reason: why } = schemas.reasonOnly.parse(input);
      assertFeature(db, 'SEALING');
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'unseal', c);
      transaction(db, () => {
        db.prepare('UPDATE cases SET is_sealed = 0, updated_at = ? WHERE id = ?').run(now(), caseId);
        event(caseId, 'CASE_UNSEALED', p.user.id, 'Case unsealed', { reason: why });
        audit.write({ ...reqCtx, action: 'CASE_UNSEAL', ...res(c), details: { reason: why } });
      });
      return detail(p, loadVisible(p, reqCtx, caseId));
    },

    setSecurity(p, reqCtx, caseId, input) {
      const d = schemas.security.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'security', c);
      const type = typeOf(c.type_code);
      const base = profileOf(type.default_security_profile);
      const profile = profileOf(d.profile);
      if (!profile) throw badRequest('Unknown security profile.');
      if ((p.levels.get(profile.level_code) ?? 0) < (p.levels.get(base.level_code) ?? 0) || !base.compartments.every((x) => profile.compartments.includes(x))) {
        throw badRequest(`Cases of this type require at least the security profile ${base.name}.`);
      }
      if (!clearedForCase(p, profile.level_code, profile.compartments)) throw forbidden('Your clearance or compartments do not cover this security profile.');
      const before = { profile: c.security_profile, level: c.security_level, compartments: compartmentsOf(caseId) };
      transaction(db, () => {
        db.prepare('UPDATE cases SET security_profile = ?, security_level = ?, requires_explicit_access = ?, updated_at = ? WHERE id = ?')
          .run(profile.code, profile.level_code, profile.requires_explicit_access, now(), caseId);
        db.prepare('DELETE FROM case_compartments WHERE case_id = ?').run(caseId);
        for (const comp of profile.compartments) db.prepare('INSERT INTO case_compartments (case_id, compartment_code) VALUES (?,?)').run(caseId, comp);
        event(caseId, 'SECURITY_CHANGED', p.user.id, `Security profile set to ${profile.name}`, { reason: d.reason });
        // Audit mit den strengeren Merkmalen (vorher ∪ nachher), damit der Eintrag nicht breiter sichtbar ist als die Akte je war
        audit.write({ ...reqCtx, action: 'CASE_SECURITY_CHANGE', resourceType: 'case', resourceId: caseId, resourceOrgId: c.owning_org_id,
          resourceLevel: (p.levels.get(before.level) ?? 0) >= (p.levels.get(profile.level_code) ?? 0) ? before.level : profile.level_code,
          resourceCompartments: [...new Set([...before.compartments, ...profile.compartments])], details: { before, after: profile.code, reason: d.reason } });
      });
      return detail(p, loadVisible(p, reqCtx, caseId));
    },

    transfer(p, reqCtx, caseId, input) {
      const d = schemas.transfer.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'transfer', c);
      if (d.orgId === c.owning_org_id) throw badRequest('The case already belongs to this organization.');
      const allowed = db.prepare('SELECT 1 FROM case_type_orgs WHERE type_code = ? AND org_id = ?').get(c.type_code, d.orgId);
      if (!allowed) throw badRequest('The target organization cannot hold cases of this type.');
      const type = typeOf(c.type_code);
      transaction(db, () => {
        const ts = now();
        db.prepare('UPDATE cases SET owning_org_id = ?, updated_at = ? WHERE id = ?').run(d.orgId, ts, caseId);
        db.prepare("UPDATE case_access SET revoked_at = ?, revoked_by = ? WHERE case_id = ? AND is_default = 1 AND revoked_at IS NULL").run(ts, p.user.id, caseId);
        if (type.default_org_access) {
          db.prepare(`INSERT INTO case_access (case_id, subject_type, subject_id, level, is_default, granted_by, reason, created_at)
            VALUES (?, 'ORG', ?, 'VIEW', 1, ?, 'Office visibility (default)', ?)`).run(caseId, d.orgId, p.user.id, ts);
        }
        event(caseId, 'CASE_TRANSFERRED', p.user.id, `Case transferred to ${p.orgs.byId.get(d.orgId)?.name}`, { from: c.owning_org_id, to: d.orgId, reason: d.reason });
        audit.write({ ...reqCtx, action: 'CASE_TRANSFER', ...res(c), details: { from: c.owning_org_id, to: d.orgId, reason: d.reason } });
      });
      // Nach der Übergabe ist die Akte für den Übergebenden evtl. nicht mehr sichtbar
      try { return detail(p, loadVisible(p, null, caseId)); } catch { return { transferred: true }; }
    },

    link(p, reqCtx, caseId, input) {
      const d = schemas.link.parse(input);
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'link', c);
      if (d.toCaseId === caseId) throw badRequest('A case cannot be linked to itself.');
      // Zielakte muss sichtbar sein – sonst wie "nicht gefunden" behandeln
      let target;
      try { target = loadVisible(p, reqCtx, d.toCaseId); } catch { throw badRequest('The linked case was not found.'); }
      if (db.prepare(`SELECT 1 FROM case_links WHERE removed_at IS NULL AND ((from_case_id = ? AND to_case_id = ?) OR (from_case_id = ? AND to_case_id = ?))`)
        .get(caseId, d.toCaseId, d.toCaseId, caseId)) throw conflict('These cases are already linked.');
      transaction(db, () => {
        db.prepare('INSERT INTO case_links (from_case_id, to_case_id, link_type, created_by, created_at) VALUES (?,?,?,?,?)').run(caseId, d.toCaseId, d.linkType, p.user.id, now());
        touch(caseId);
        // Nur in der Ausgangsakte protokollieren: ein Eintrag in der Zielakte würde deren Beteiligten die Ausgangsakte verraten
        event(caseId, 'CASE_LINKED', p.user.id, `Linked to ${target.case_number} (${d.linkType})`, { toCaseId: d.toCaseId, linkType: d.linkType });
        audit.write({ ...reqCtx, action: 'CASE_LINK', ...res(c), details: { toCaseId: d.toCaseId, linkType: d.linkType } });
      });
      return detail(p, c);
    },

    unlink(p, reqCtx, caseId, linkId) {
      const c = loadVisible(p, reqCtx, caseId);
      requireCap(p, 'link', c);
      const l = /** @type {any} */ (db.prepare('SELECT * FROM case_links WHERE id = ? AND (from_case_id = ? OR to_case_id = ?) AND removed_at IS NULL').get(linkId, caseId, caseId));
      if (!l || !links(p, caseId).some((x) => x.id === linkId)) throw notFound();
      transaction(db, () => {
        db.prepare('UPDATE case_links SET removed_at = ? WHERE id = ?').run(now(), linkId);
        event(caseId, 'CASE_UNLINKED', p.user.id, 'Case link removed', { linkId });
        audit.write({ ...reqCtx, action: 'CASE_UNLINK', ...res(c), details: { linkId } });
      });
      return detail(p, c);
    },
  };
}

module.exports = { createCaseService, PARTICIPANT_ROLES, LINK_TYPES };
