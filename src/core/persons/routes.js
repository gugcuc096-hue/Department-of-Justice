// @ts-check
'use strict';
/**
 * /api/persons, /api/companies, /api/search
 */
const express = require('express');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf } = require('../authz/middleware');
const { createPersonService } = require('./service');
const { createSearchService } = require('../search/service');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** @param {import('../../app').AppContext} ctx */
function personRoutes(ctx) {
  const persons = createPersonService(ctx);
  const search = createSearchService(ctx);
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;
  const I = (req) => idParam(req.params.id);

  router.get('/search', (req, res) => res.json(search.search(P(req), A(req), req.query)));
  router.get('/search/types', (req, res) => res.json(search.types(P(req))));

  router.get('/persons', (req, res) => res.json(persons.listPersons(P(req), req.query)));
  router.post('/persons', (req, res) => res.status(201).json(persons.createPerson(P(req), A(req), req.body)));
  router.get('/persons/:id', (req, res) => res.json(persons.getPerson(P(req), A(req), I(req))));
  router.patch('/persons/:id', (req, res) => res.json(persons.updatePerson(P(req), A(req), I(req), req.body)));

  router.get('/companies', (req, res) => res.json(persons.listCompanies(P(req), req.query)));
  router.post('/companies', (req, res) => res.status(201).json(persons.createCompany(P(req), A(req), req.body)));
  router.get('/companies/:id', (req, res) => res.json(persons.getCompany(P(req), A(req), I(req))));
  router.patch('/companies/:id', (req, res) => res.json(persons.updateCompany(P(req), A(req), I(req), req.body)));
  router.post('/companies/:id/people', (req, res) => res.status(201).json(persons.addCompanyPerson(P(req), A(req), I(req), req.body)));
  router.post('/companies/:id/people/:eid/remove', (req, res) => res.json(persons.removeCompanyPerson(P(req), A(req), I(req), idParam(req.params.eid))));

  return { router, service: persons };
}

module.exports = { personRoutes };
