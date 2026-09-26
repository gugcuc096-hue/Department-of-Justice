// @ts-check
'use strict';
/**
 * Express-App-Fabrik. Wird von server.js und von den Tests verwendet (ohne listen()).
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { default: helmet } = require('helmet');
const cookieParser = require('cookie-parser');
const { errorHandler, notFound } = require('./http/errors');
const { createAudit } = require('./core/audit/audit');
const { createSessionStore } = require('./core/auth/sessions');
const { loadSession, requireAuth, csrfProtection, requirePasswordCurrent } = require('./core/auth/middleware');
const { authRoutes } = require('./core/auth/routes');
const { attachPrincipal } = require('./core/authz/middleware');
const { meRoutes } = require('./core/users/me');
const { adminRoutes } = require('./core/admin/routes');
const { caseRoutes } = require('./core/cases/routes');
const { documentRoutes } = require('./core/documents/routes');
const { applicationRoutes } = require('./core/applications/routes');
const { evidenceRoutes } = require('./core/evidence/routes');
const { scheduleRoutes } = require('./core/schedule/routes');
const { communicationRoutes } = require('./core/communication/routes');
const { createNotifier } = require('./core/notifications/service');
const { registerSubjectCheckers } = require('./core/notifications/registry');
const { personRoutes } = require('./core/persons/routes');
const { reportRoutes } = require('./core/reports/routes');

/**
 * @typedef {object} AppContext
 * @property {import('./db').Database} db
 * @property {import('./config').Config} config
 * @property {import('./http/logger').Logger} logger
 * @property {ReturnType<typeof createAudit>} audit
 * @property {ReturnType<typeof createSessionStore>} sessions
 * @property {Array<(p: any, reqCtx: any, fileId: number) => boolean>} fileAccessors  Module, die Dateien freigeben (Dokumente, Beweismittel)
 * @property {ReturnType<typeof createNotifier>} [notify]  Benachrichtigungen (nur an Berechtigte)
 * @property {Record<string, (p: any, id: number) => boolean>} [subjectVisible]  Sichtbarkeitsprüfer je Gegenstandstyp
 * @property {Record<string, (id: number) => any>} [subjectDescribe]  Kurzbeschreibung je Gegenstandstyp
 * @property {any[]} [searchProviders]  Treffertypen der globalen Suche
 * @property {any[]} [reportProviders]  zusätzliche Reports der Fachmodule
 * @property {any[]} [dashboardWidgets]  zusätzliche Dashboard-Kennzahlen der Fachmodule
 * @property {{ runReminders: () => number }} [reminders]
 */

/**
 * @param {{ db: import('./db').Database, config: import('./config').Config, logger: import('./http/logger').Logger }} deps
 */
function createApp({ db, config, logger }) {
  /** @type {AppContext} */
  const ctx = { db, config, logger, audit: createAudit(db), sessions: createSessionStore(db, config), fileAccessors: [] };
  ctx.notify = createNotifier(ctx);
  registerSubjectCheckers(ctx);
  const app = express();
  const publicDir = path.join(config.root, 'public');

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.locals.requestId = crypto.randomUUID();
    res.set('X-Request-Id', res.locals.requestId);
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // ---------------------------------------------------------------- API
  const api = express.Router();
  // API-Antworten nie cachen (SECURITY_MODEL.md, Abschnitt 7)
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.get('/health', (_req, res) => res.json({ status: 'ok' }));
  api.use(loadSession(ctx));
  api.use(csrfProtection);
  api.use('/auth', authRoutes(ctx));

  // Ab hier: nur angemeldet und mit aktuellem Passwort
  api.use(requireAuth, requirePasswordCurrent, attachPrincipal(ctx));
  api.use('/me', meRoutes(ctx));
  api.use(adminRoutes(ctx));
  api.use(caseRoutes(ctx).router);
  api.use(documentRoutes(ctx).router);
  api.use(applicationRoutes(ctx).router);
  api.use(evidenceRoutes(ctx).router);
  api.use(scheduleRoutes(ctx).router);
  const comm = communicationRoutes(ctx);
  ctx.reminders = comm.notifications;
  api.use(comm.router);
  api.use(personRoutes(ctx).router);
  api.use(reportRoutes(ctx).router);
  api.use((_req, _res, next) => next(notFound('Unknown API endpoint.')));
  app.use('/api', api);

  // ---------------------------------------------------------------- Frontend
  app.use(express.static(publicDir, { index: false, fallthrough: true }));
  app.get('/', (_req, res) => res.redirect('/app/'));
  // SPA-Fallback: alle Pfade unter /app ohne Dateiendung liefern die Shell.
  app.get(/^\/app(\/[^.]*)?$/, (_req, res) => res.sendFile(path.join(publicDir, 'app', 'index.html')));
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

  app.use(errorHandler(logger));
  return { app, ctx };
}

module.exports = { createApp };
