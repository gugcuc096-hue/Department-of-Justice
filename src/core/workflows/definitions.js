// @ts-check
'use strict';
/**
 * Workflow-Definitionen (WORKFLOWS.md). Als Daten gespeichert (workflow_definitions) und damit versionierbar;
 * laufende Instanzen behalten ihre Version.
 *
 * Felder eines Übergangs:
 *   action        Name der Aktion (API: POST …/:action)
 *   from          zulässige Ausgangszustände
 *   to            Zielzustand
 *   actor         wer handeln darf – vom Fach-Service ausgewertet (applicant | court | assignedJudge)
 *   permission    erforderliche Permission (Scope prüft der Fach-Service); bei Haftbefehlen ggf. warrantPermission
 *   humanDecision true = rechtlich erhebliche Entscheidung, nur durch ausdrückliche Handlung einer Person
 *   requireComment true = Begründung Pflicht
 *   forbidSameActorAs  Rollen, die nicht identisch mit dem Handelnden sein dürfen (keine Selbstentscheidung)
 */

const APPLICATION = {
  code: 'COURT_APPLICATION',
  version: 1,
  name: 'Court application (warrant, subpoena)',
  definition: {
    initial: 'DRAFT',
    states: {
      DRAFT: { label: 'Draft' },
      SUBMITTED: { label: 'Submitted' },
      UNDER_REVIEW: { label: 'Under judicial review' },
      REVISION_REQUESTED: { label: 'Revision requested' },
      APPROVED: { label: 'Approved – awaiting signature and issue' },
      DENIED: { label: 'Denied', final: true },
      ISSUED: { label: 'Issued' },
      WITHDRAWN: { label: 'Withdrawn', final: true },
      CLOSED: { label: 'Closed', final: true },
    },
    transitions: [
      { action: 'submit', from: ['DRAFT', 'REVISION_REQUESTED'], to: 'SUBMITTED', actor: 'applicant', permission: 'APPLICATION_SUBMIT', warrantPermission: 'WARRANT_CREATE' },
      { action: 'withdraw', from: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED'], to: 'WITHDRAWN', actor: 'applicant', permission: 'APPLICATION_SUBMIT', requireComment: true },
      { action: 'accept', from: ['SUBMITTED'], to: 'UNDER_REVIEW', actor: 'court', permission: 'CASE_ASSIGN' },
      { action: 'request_revision', from: ['UNDER_REVIEW'], to: 'REVISION_REQUESTED', actor: 'assignedJudge', permission: 'APPLICATION_DECIDE', warrantPermission: 'WARRANT_REVIEW', humanDecision: true, requireComment: true, forbidSameActorAs: ['applicant'] },
      { action: 'resubmit_review', from: ['SUBMITTED'], to: 'UNDER_REVIEW', actor: 'system' },
      { action: 'approve', from: ['UNDER_REVIEW'], to: 'APPROVED', actor: 'assignedJudge', permission: 'APPLICATION_DECIDE', warrantPermission: 'WARRANT_APPROVE', humanDecision: true, forbidSameActorAs: ['applicant'] },
      { action: 'deny', from: ['UNDER_REVIEW'], to: 'DENIED', actor: 'assignedJudge', permission: 'APPLICATION_DECIDE', warrantPermission: 'WARRANT_DENY', humanDecision: true, requireComment: true, forbidSameActorAs: ['applicant'] },
      { action: 'issue', from: ['APPROVED'], to: 'ISSUED', actor: 'assignedJudge', permission: 'APPLICATION_DECIDE', warrantPermission: 'WARRANT_ISSUE', humanDecision: true, forbidSameActorAs: ['applicant'] },
      { action: 'close', from: ['ISSUED'], to: 'CLOSED', actor: 'system' },
    ],
  },
};

const WORKFLOWS = [APPLICATION];

module.exports = { WORKFLOWS, APPLICATION };
