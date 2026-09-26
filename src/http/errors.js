// @ts-check
'use strict';
/**
 * Einheitliche Fehler für die API.
 * Benutzer sehen nur Code + verständliche Meldung + requestId; technische Details gehen ins System Log.
 */
const { ZodError } = require('zod');

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code      maschinenlesbar, z. B. "NOT_FOUND"
   * @param {string} message   für Benutzer verständlich (Englisch, UI-Sprache)
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message = 'The request is invalid.', details) => new HttpError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = 'Please sign in.') => new HttpError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You are not permitted to perform this action.', code = 'FORBIDDEN') => new HttpError(403, code, message);
// Bewusst identisch für "existiert nicht" und "darf nicht gesehen werden" (SECURITY_MODEL.md, Abschnitt 5).
const notFound = (message = 'The requested record was not found.') => new HttpError(404, 'NOT_FOUND', message);
const conflict = (message, code = 'CONFLICT') => new HttpError(409, code, message);

/** Zod-Fehler in Feldfehler ohne interne Details übersetzen. */
function fieldErrors(err) {
  return err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
}

/**
 * @param {import('./logger').Logger} logger
 * @returns {import('express').ErrorRequestHandler}
 */
function errorHandler(logger) {
  return (err, req, res, _next) => {
    const requestId = res.locals.requestId;
    if (res.headersSent) {
      logger.error('error after headers sent', { requestId, err });
      return;
    }
    if (err instanceof HttpError) {
      if (err.status >= 500) logger.error('http error', { requestId, err });
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details }, requestId });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: { code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', details: fieldErrors(err) },
        requestId,
      });
    }
    // body-parser: kaputtes JSON oder zu groß
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      const status = err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: { code: 'BAD_REQUEST', message: 'The request body could not be processed.' }, requestId });
    }
    logger.error('unhandled error', { requestId, method: req.method, path: req.path, err });
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again or contact an administrator.' },
      requestId,
    });
  };
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, errorHandler };
