// @ts-check
'use strict';

/**
 * Express 4 fängt Fehler aus async-Handlern nicht selbst ab. Dieser Wrapper leitet sie an den Fehler-Handler weiter.
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => unknown} fn
 * @returns {import('express').RequestHandler}
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };
