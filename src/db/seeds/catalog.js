// @ts-check
'use strict';
/**
 * Stammdaten für den Erst-Seed. Nach dem Seed sind alle Werte über das Administration Center änderbar;
 * der Seed legt nur Fehlendes an und überschreibt nie Änderungen von Administratoren.
 *
 * Ränge: ausschließlich die in prompt.txt 3.2 vorgegebenen. Für USMS, SID, DCLI, Registry, US-SJA und
 * Constitutional Court sind keine Ränge vorgegeben – sie werden NICHT erfunden, sondern vom Admin gepflegt.
 */

const COURT_SUBTITLE = 'for the District of San Andreas';

/** Organisationsbaum. parent: Code der übergeordneten Organisation. */
const ORGANIZATIONS = [
  { code: 'SJCS', parent: null, kind: 'PLATFORM', name: 'San Andreas Justice Command System', short: 'SJCS' },

  { code: 'USMS', parent: 'SJCS', kind: 'INSTITUTION', name: 'United States Marshals Service', short: 'USMS', brand: 'USMS' },

  { code: 'PROSECUTION', parent: 'SJCS', kind: 'INSTITUTION', name: 'Prosecution', short: 'Prosecution' },
  { code: 'DA', parent: 'PROSECUTION', kind: 'OFFICE', name: 'Office of the District Attorney', short: 'DA', brand: 'DA' },
  { code: 'SA', parent: 'PROSECUTION', kind: 'OFFICE', name: 'Office of the State Attorney', short: 'SA', brand: 'SA' },
  { code: 'AG', parent: 'PROSECUTION', kind: 'OFFICE', name: 'Office of the Attorney General', short: 'AG', brand: 'AG' },
  { code: 'SID', parent: 'PROSECUTION', kind: 'DIVISION', name: 'Special Investigations Division', short: 'SID', brand: 'SID' },
  { code: 'DCLI', parent: 'PROSECUTION', kind: 'OFFICE', name: 'Department of Commercial Licensing and Investigations', short: 'DCLI', brand: 'DCLI' },

  { code: 'JUDICIARY', parent: 'SJCS', kind: 'INSTITUTION', name: 'Judiciary', short: 'Judiciary' },
  { code: 'DC', parent: 'JUDICIARY', kind: 'COURT', name: 'District Court of the United States of America', short: 'District Court', subtitle: COURT_SUBTITLE, brand: 'DC' },
  { code: 'COA', parent: 'JUDICIARY', kind: 'COURT', name: 'Court of Appeals of the United States of America', short: 'Court of Appeals', subtitle: COURT_SUBTITLE, brand: 'COA' },
  { code: 'SC', parent: 'JUDICIARY', kind: 'COURT', name: 'Supreme Court of the United States of America', short: 'Supreme Court', subtitle: COURT_SUBTITLE, brand: 'SC' },
  { code: 'REG', parent: 'JUDICIARY', kind: 'OFFICE', name: 'Registry Office', short: 'Registry', brand: 'REG' },
  { code: 'USSJA', parent: 'JUDICIARY', kind: 'AUTHORITY', name: 'United States Special Judicial Authority', short: 'US-SJA', brand: 'USSJA' },
  { code: 'CC', parent: 'JUDICIARY', kind: 'COURT', name: 'Constitutional Court', short: 'Constitutional Court', brand: 'CC' },
];

/** Ränge je Organisation, vom niedrigsten (level 1) zum höchsten (prompt.txt 3.2 / 4.2). */
const RANKS = {
  DA: ['Probationary Prosecutor', 'Junior Prosecutor', 'Prosecutor', 'Senior Prosecutor', 'Assistant District Attorney', 'District Attorney'],
  SA: ['State Attorney', 'Senior State Attorney'],
  AG: ['Assistant Attorney General', 'Deputy Attorney General', 'Attorney General'],
  DC: ['Probationary Judge', 'Judge', 'Senior Judge', 'Principal Judge'],
  COA: ['Appellate Justice', 'Senior Appellate Justice', 'Presiding Justice'],
  SC: ['Associate Justice', 'Deputy Chief Justice', 'Chief Justice'],
};

const rankCode = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Permission-Katalog (PERMISSIONS.md Abschnitt 2): [code, category, description] */
const PERMISSIONS = [
  ['CASE_CREATE', 'Cases', 'Create cases'],
  ['CASE_VIEW', 'Cases', 'View cases the user has access to'],
  ['CASE_EDIT', 'Cases', 'Edit cases the user participates in'],
  ['CASE_CLOSE', 'Cases', 'Close cases'],
  ['CASE_ARCHIVE', 'Cases', 'Archive cases'],
  ['CASE_SHARE', 'Cases', 'Grant other users or offices access to a case'],
  ['CASE_EXPORT', 'Cases', 'Export case data'],
  ['CASE_VIEW_ORG', 'Cases', 'Supervisor: view all cases in scope (not sealed / explicit-access cases)'],
  ['CASE_ASSIGN', 'Cases', 'Assign participants and handlers'],
  ['CASE_LINK', 'Cases', 'Link cases'],
  ['CASE_SEAL', 'Cases', 'Seal cases'],
  ['CASE_UNSEAL', 'Cases', 'Unseal cases'],
  ['CASE_TRANSFER', 'Cases', 'Transfer cases to another office'],

  ['DOCUMENT_CREATE', 'Documents', 'Create documents'],
  ['DOCUMENT_VIEW', 'Documents', 'View documents'],
  ['DOCUMENT_EDIT', 'Documents', 'Edit documents (creates a new version)'],
  ['DOCUMENT_DELETE', 'Documents', 'Delete draft documents'],
  ['DOCUMENT_SIGN', 'Documents', 'Sign documents'],
  ['DOCUMENT_APPROVE', 'Documents', 'Approve documents'],
  ['DOCUMENT_REJECT', 'Documents', 'Reject documents'],
  ['DOCUMENT_DOWNLOAD', 'Documents', 'Download documents and files'],
  ['DOCUMENT_TEMPLATE_MANAGE', 'Documents', 'Manage document templates'],

  ['EVIDENCE_CREATE', 'Evidence', 'Register evidence'],
  ['EVIDENCE_VIEW', 'Evidence', 'View evidence'],
  ['EVIDENCE_TRANSFER', 'Evidence', 'Transfer custody of evidence'],
  ['EVIDENCE_DISPOSE', 'Evidence', 'Release or dispose of evidence'],

  ['APPLICATION_CREATE', 'Applications', 'Draft court applications'],
  ['APPLICATION_SUBMIT', 'Applications', 'Submit court applications'],
  ['APPLICATION_REVIEW', 'Applications', 'Review court applications'],
  ['APPLICATION_DECIDE', 'Applications', 'Decide on court applications'],
  ['WARRANT_CREATE', 'Warrants', 'Draft warrant applications'],
  ['WARRANT_VIEW', 'Warrants', 'View warrants'],
  ['WARRANT_REVIEW', 'Warrants', 'Review warrant applications'],
  ['WARRANT_APPROVE', 'Warrants', 'Approve warrant applications'],
  ['WARRANT_DENY', 'Warrants', 'Deny warrant applications'],
  ['WARRANT_SIGN', 'Warrants', 'Sign warrants'],
  ['WARRANT_ISSUE', 'Warrants', 'Issue warrants'],
  ['WARRANT_EXECUTE', 'Warrants', 'Record warrant execution'],
  ['WARRANT_RECALL', 'Warrants', 'Recall warrants'],
  ['DECISION_CREATE', 'Decisions', 'Draft decisions, orders and judgments'],
  ['DECISION_SIGN', 'Decisions', 'Sign decisions'],
  ['DECISION_PUBLISH', 'Decisions', 'Publish decisions'],

  ['HEARING_CREATE', 'Hearings', 'Create hearings'],
  ['HEARING_EDIT', 'Hearings', 'Edit hearings'],
  ['HEARING_SCHEDULE', 'Hearings', 'Schedule hearings'],
  ['HEARING_CANCEL', 'Hearings', 'Cancel hearings'],
  ['HEARING_PROTOCOL', 'Hearings', 'Write hearing protocols'],
  ['DEADLINE_MANAGE', 'Deadlines', 'Manage deadlines'],
  ['DEADLINE_EXTEND', 'Deadlines', 'Extend deadlines'],

  ['MESSAGE_SEND', 'Communication', 'Send messages'],
  ['MESSAGE_DEPARTMENT', 'Communication', 'Write on behalf of an office'],
  ['REQUEST_CREATE', 'Communication', 'Send official requests'],
  ['REQUEST_RESPOND', 'Communication', 'Respond to official requests'],
  ['REQUEST_ASSIGN', 'Communication', 'Assign official requests'],

  ['PERSON_VIEW', 'Persons', 'View person records'],
  ['PERSON_CREATE', 'Persons', 'Create person records'],
  ['PERSON_EDIT', 'Persons', 'Edit person records'],
  ['COMPANY_VIEW', 'Persons', 'View companies'],
  ['COMPANY_EDIT', 'Persons', 'Create and edit companies'],

  ['USMS_OPERATION_CREATE', 'USMS', 'Plan operations'],
  ['USMS_OPERATION_APPROVE', 'USMS', 'Approve operations'],
  ['USMS_OPERATION_VIEW', 'USMS', 'View operations'],
  ['USMS_ARREST_RECORD', 'USMS', 'Record arrests'],
  ['USMS_TRANSPORT_MANAGE', 'USMS', 'Manage prisoner transports'],
  ['USMS_COURT_SECURITY_MANAGE', 'USMS', 'Manage court security assignments'],
  ['USMS_REPORT_CREATE', 'USMS', 'Write reports'],
  ['USMS_APPLICATION_REVIEW', 'USMS', 'Review employment applications'],
  ['TASK_MANAGE', 'USMS', 'Manage tasks'],

  ['SID_ACCESS', 'SID', 'May be granted the SID compartment'],
  ['SID_RESTRICTED_ACCESS', 'SID', 'May be granted the SID_RESTRICTED compartment'],

  ['DCLI_LICENSE_CREATE', 'DCLI', 'Create license applications'],
  ['DCLI_LICENSE_VIEW', 'DCLI', 'View licenses'],
  ['DCLI_LICENSE_REVIEW', 'DCLI', 'Review license applications'],
  ['DCLI_LICENSE_APPROVE', 'DCLI', 'Approve or deny license applications'],
  ['DCLI_LICENSE_SUSPEND', 'DCLI', 'Suspend licenses'],
  ['DCLI_LICENSE_REVOKE', 'DCLI', 'Revoke licenses'],
  ['DCLI_INSPECTION_MANAGE', 'DCLI', 'Manage inspections'],
  ['DCLI_INVESTIGATION', 'DCLI', 'Conduct commercial investigations'],
  ['DCLI_FEE_MANAGE', 'DCLI', 'Manage fees'],

  ['REGISTRY_VIEW', 'Registry', 'View registry records'],
  ['REGISTRY_CREATE', 'Registry', 'Create registry records'],
  ['REGISTRY_EDIT', 'Registry', 'Correct registry records'],
  ['REGISTRY_CERTIFICATE_ISSUE', 'Registry', 'Issue certificates'],
  ['REGISTRY_APPLICATION_REVIEW', 'Registry', 'Review registry applications'],

  ['US_SJA_ACCESS', 'US-SJA', 'May be granted the USSJA compartment'],
  ['US_SJA_CLASSIFIED_ACCESS', 'US-SJA', 'May be cleared for US-SJA CLASSIFIED'],
  ['CONSTITUTIONAL_REVIEW_CREATE', 'Constitutional Court', 'File constitutional review proceedings'],
  ['CONSTITUTIONAL_REVIEW_VIEW', 'Constitutional Court', 'View constitutional review proceedings'],
  ['CONSTITUTIONAL_DECISION_SIGN', 'Constitutional Court', 'Sign constitutional decisions'],

  ['USER_VIEW', 'Administration', 'View users'],
  ['USER_CREATE', 'Administration', 'Create users'],
  ['USER_EDIT', 'Administration', 'Edit users and memberships'],
  ['USER_DISABLE', 'Administration', 'Disable users'],
  ['ROLE_ASSIGN', 'Administration', 'Assign roles'],
  ['PERMISSION_ASSIGN', 'Administration', 'Grant individual permissions'],
  ['ORG_MANAGE', 'Administration', 'Manage organizations'],
  ['RANK_MANAGE', 'Administration', 'Manage ranks'],
  ['ROLE_MANAGE', 'Administration', 'Manage roles and their permissions'],
  ['CLEARANCE_ASSIGN', 'Administration', 'Assign security clearance'],
  ['COMPARTMENT_ASSIGN', 'Administration', 'Assign compartments'],
  ['DELEGATION_APPROVE', 'Administration', 'Approve delegations'],
  ['CONFIG_MANAGE', 'Administration', 'Manage case types, document types, workflows, security levels'],
  ['FEATURE_TOGGLE', 'Administration', 'Enable or disable functions with unverified legal basis'],
  ['BRANDING_MANAGE', 'Administration', 'Manage branding'],
  ['AUDIT_VIEW', 'Audit', 'View audit log'],
  ['AUDIT_EXPORT', 'Audit', 'Export audit log'],
  ['REPORT_VIEW', 'Reports', 'View reports'],
  ['REPORT_EXPORT', 'Reports', 'Export reports'],
];

const CASE_BASE = ['CASE_CREATE', 'CASE_VIEW', 'CASE_EDIT', 'CASE_CLOSE', 'CASE_LINK', 'DOCUMENT_CREATE', 'DOCUMENT_VIEW', 'DOCUMENT_SIGN',
  'DOCUMENT_EDIT', 'DOCUMENT_DELETE', 'DOCUMENT_DOWNLOAD', 'MESSAGE_SEND', 'PERSON_VIEW', 'COMPANY_VIEW'];
const SUPERVISION = ['CASE_ASSIGN', 'CASE_SHARE', 'CASE_TRANSFER', 'CASE_ARCHIVE', 'CASE_EXPORT', 'DOCUMENT_APPROVE',
  'DOCUMENT_REJECT', 'REQUEST_ASSIGN', 'REPORT_VIEW', 'DEADLINE_EXTEND', 'MESSAGE_DEPARTMENT'];
const JUDICIAL = ['CASE_VIEW', 'CASE_EDIT', 'CASE_CLOSE', 'CASE_LINK', 'CASE_SEAL', 'CASE_UNSEAL', 'DOCUMENT_CREATE', 'DOCUMENT_VIEW',
  'DOCUMENT_EDIT', 'DOCUMENT_SIGN', 'DOCUMENT_DOWNLOAD', 'APPLICATION_REVIEW', 'APPLICATION_DECIDE', 'WARRANT_VIEW',
  'WARRANT_REVIEW', 'WARRANT_APPROVE', 'WARRANT_DENY', 'WARRANT_SIGN', 'WARRANT_ISSUE', 'WARRANT_RECALL', 'DECISION_CREATE',
  'DECISION_SIGN', 'DECISION_PUBLISH', 'HEARING_CREATE', 'HEARING_EDIT', 'HEARING_SCHEDULE', 'HEARING_CANCEL',
  'DEADLINE_MANAGE', 'DEADLINE_EXTEND', 'EVIDENCE_VIEW', 'MESSAGE_SEND', 'REQUEST_CREATE', 'REQUEST_RESPOND', 'PERSON_VIEW', 'COMPANY_VIEW'];
const ADMIN_ORG = ['USER_VIEW', 'USER_CREATE', 'USER_EDIT', 'USER_DISABLE', 'ROLE_ASSIGN', 'RANK_MANAGE'];

/** Rollen (PERMISSIONS.md Abschnitte 3 und 4). Vorschläge, administrierbar. */
const ROLES = [
  { code: 'SYSTEM_ADMIN', name: 'System Administrator', system: true,
    description: 'Global configuration and user administration. No access to case content.',
    permissions: [...ADMIN_ORG, 'PERMISSION_ASSIGN', 'ORG_MANAGE', 'ROLE_MANAGE', 'CLEARANCE_ASSIGN', 'COMPARTMENT_ASSIGN',
      'DELEGATION_APPROVE', 'CONFIG_MANAGE', 'FEATURE_TOGGLE', 'BRANDING_MANAGE', 'DOCUMENT_TEMPLATE_MANAGE'] },
  { code: 'ORG_ADMIN', name: 'Organization Administrator', system: true,
    description: 'User, rank and role administration within the assigned organization (organization / department / office admin by scope).',
    permissions: ADMIN_ORG },
  { code: 'SECURITY_ADMIN', name: 'Security Administrator', system: true,
    description: 'Clearances, compartments (only those held) and delegations within scope.',
    permissions: ['USER_VIEW', 'CLEARANCE_ASSIGN', 'COMPARTMENT_ASSIGN', 'DELEGATION_APPROVE'] },
  { code: 'AUDIT_ADMIN', name: 'Audit Administrator', system: true,
    description: 'Audit log access within scope (level and compartment rules still apply).',
    permissions: ['USER_VIEW', 'AUDIT_VIEW', 'AUDIT_EXPORT'] },

  { code: 'USMS_DEPUTY', name: 'USMS Deputy', permissions: [...CASE_BASE, 'EVIDENCE_CREATE', 'EVIDENCE_VIEW', 'EVIDENCE_TRANSFER',
    'USMS_OPERATION_VIEW', 'USMS_ARREST_RECORD', 'USMS_REPORT_CREATE', 'WARRANT_VIEW', 'WARRANT_EXECUTE', 'PERSON_CREATE'] },
  { code: 'USMS_SUPERVISOR', name: 'USMS Supervisor', permissions: [...CASE_BASE, ...SUPERVISION, 'EVIDENCE_CREATE', 'EVIDENCE_VIEW',
    'EVIDENCE_TRANSFER', 'EVIDENCE_DISPOSE', 'USMS_OPERATION_VIEW', 'USMS_OPERATION_CREATE', 'USMS_OPERATION_APPROVE',
    'USMS_ARREST_RECORD', 'USMS_TRANSPORT_MANAGE', 'USMS_COURT_SECURITY_MANAGE', 'USMS_REPORT_CREATE', 'TASK_MANAGE',
    'WARRANT_VIEW', 'WARRANT_EXECUTE', 'REQUEST_CREATE', 'REQUEST_RESPOND', 'PERSON_CREATE', 'PERSON_EDIT'] },
  { code: 'USMS_RECRUITER', name: 'USMS Recruiter', permissions: ['USMS_APPLICATION_REVIEW'] },

  { code: 'PROSECUTOR', name: 'Prosecutor', permissions: [...CASE_BASE, 'EVIDENCE_VIEW', 'APPLICATION_CREATE', 'APPLICATION_SUBMIT',
    'WARRANT_CREATE', 'WARRANT_VIEW', 'REQUEST_CREATE', 'PERSON_CREATE', 'DEADLINE_MANAGE'] },
  { code: 'PROSECUTION_SUPERVISOR', name: 'Prosecution Supervisor', permissions: [...CASE_BASE, ...SUPERVISION, 'EVIDENCE_VIEW',
    'APPLICATION_CREATE', 'APPLICATION_SUBMIT', 'WARRANT_CREATE', 'WARRANT_VIEW', 'REQUEST_CREATE', 'REQUEST_RESPOND',
    'PERSON_CREATE', 'PERSON_EDIT', 'DEADLINE_MANAGE'] },
  { code: 'SID_INVESTIGATOR', name: 'SID Investigator', permissions: [...CASE_BASE, 'SID_ACCESS', 'EVIDENCE_CREATE', 'EVIDENCE_VIEW',
    'EVIDENCE_TRANSFER', 'APPLICATION_CREATE', 'APPLICATION_SUBMIT', 'WARRANT_CREATE', 'WARRANT_VIEW', 'PERSON_CREATE', 'DEADLINE_MANAGE'] },

  { code: 'DCLI_OFFICER', name: 'DCLI Officer', permissions: [...CASE_BASE, 'DCLI_LICENSE_VIEW', 'DCLI_LICENSE_CREATE',
    'DCLI_LICENSE_REVIEW', 'DCLI_INSPECTION_MANAGE', 'DCLI_INVESTIGATION', 'COMPANY_EDIT', 'EVIDENCE_CREATE', 'EVIDENCE_VIEW'] },
  { code: 'DCLI_SUPERVISOR', name: 'DCLI Supervisor', permissions: [...CASE_BASE, ...SUPERVISION, 'DCLI_LICENSE_VIEW',
    'DCLI_LICENSE_CREATE', 'DCLI_LICENSE_REVIEW', 'DCLI_LICENSE_APPROVE', 'DCLI_LICENSE_SUSPEND', 'DCLI_LICENSE_REVOKE',
    'DCLI_INSPECTION_MANAGE', 'DCLI_INVESTIGATION', 'DCLI_FEE_MANAGE', 'COMPANY_EDIT', 'EVIDENCE_CREATE', 'EVIDENCE_VIEW',
    'REQUEST_CREATE', 'REQUEST_RESPOND'] },

  { code: 'JUDGE', name: 'Judge', permissions: JUDICIAL },
  { code: 'COURT_ADMINISTRATION', name: 'Court Administration', permissions: ['CASE_CREATE', 'CASE_VIEW', 'CASE_ASSIGN', 'CASE_SHARE', 'EVIDENCE_VIEW', 'EVIDENCE_TRANSFER',
    'CASE_LINK', 'CASE_ARCHIVE', 'DOCUMENT_VIEW', 'DOCUMENT_DOWNLOAD', 'HEARING_CREATE', 'HEARING_EDIT', 'HEARING_SCHEDULE',
    'HEARING_CANCEL', 'DEADLINE_MANAGE', 'APPLICATION_REVIEW', 'WARRANT_VIEW', 'MESSAGE_SEND', 'MESSAGE_DEPARTMENT',
    'REQUEST_CREATE', 'REQUEST_RESPOND', 'REQUEST_ASSIGN', 'REPORT_VIEW', 'PERSON_VIEW'] },
  { code: 'COURT_CLERK', name: 'Court Clerk', permissions: ['CASE_VIEW', 'EVIDENCE_VIEW', 'EVIDENCE_TRANSFER', 'DOCUMENT_CREATE', 'DOCUMENT_VIEW', 'DOCUMENT_EDIT',
    'DOCUMENT_DOWNLOAD', 'HEARING_PROTOCOL', 'DEADLINE_MANAGE', 'MESSAGE_SEND', 'PERSON_VIEW'] },

  { code: 'REGISTRAR', name: 'Registrar', permissions: ['CASE_CREATE', 'CASE_VIEW', 'CASE_EDIT', 'CASE_CLOSE', 'DOCUMENT_CREATE',
    'DOCUMENT_VIEW', 'DOCUMENT_EDIT', 'DOCUMENT_SIGN', 'DOCUMENT_DOWNLOAD', 'REGISTRY_VIEW', 'REGISTRY_CREATE', 'REGISTRY_EDIT',
    'REGISTRY_APPLICATION_REVIEW', 'REGISTRY_CERTIFICATE_ISSUE', 'PERSON_VIEW', 'PERSON_CREATE', 'MESSAGE_SEND', 'REQUEST_CREATE', 'REQUEST_RESPOND'] },

  { code: 'USSJA_MEMBER', name: 'US-SJA Member', permissions: [...JUDICIAL, 'CASE_CREATE', 'CASE_ASSIGN', 'US_SJA_ACCESS'] },
  { code: 'CONSTITUTIONAL_JUDGE', name: 'Constitutional Judge',
    description: 'Disabled until composition and jurisdiction are verified against the ModernV constitution.',
    permissions: ['CASE_VIEW', 'DOCUMENT_VIEW', 'CONSTITUTIONAL_REVIEW_VIEW', 'CONSTITUTIONAL_DECISION_SIGN'] },
];

const SECURITY_LEVELS = [
  ['PUBLIC', 0, 'Public'],
  ['INTERNAL', 1, 'Internal'],
  ['RESTRICTED', 2, 'Restricted'],
  ['CONFIDENTIAL', 3, 'Confidential'],
  ['SEALED', 4, 'Sealed'],
  ['CLASSIFIED', 5, 'Classified'],
];

const COMPARTMENTS = [
  { code: 'SID', name: 'Special Investigations Division', owner: 'SID' },
  { code: 'SID_RESTRICTED', name: 'SID Restricted', owner: 'SID' },
  { code: 'REGISTRY', name: 'Registry records', owner: 'REG' },
  { code: 'USSJA', name: 'United States Special Judicial Authority', owner: 'USSJA' },
];

/** SECURITY_MODEL.md Abschnitt 3 */
const SECURITY_PROFILES = [
  { code: 'STANDARD', name: 'Internal', level: 'INTERNAL', compartments: [] },
  { code: 'RESTRICTED', name: 'Restricted', level: 'RESTRICTED', compartments: [] },
  { code: 'CONFIDENTIAL', name: 'Confidential', level: 'CONFIDENTIAL', compartments: [] },
  { code: 'CLASSIFIED', name: 'Classified', level: 'CLASSIFIED', compartments: [] },
  { code: 'SID', name: 'SID', level: 'CONFIDENTIAL', compartments: ['SID'] },
  { code: 'SID_RESTRICTED', name: 'SID Restricted', level: 'CONFIDENTIAL', compartments: ['SID', 'SID_RESTRICTED'], explicit: true },
  { code: 'REGISTRY', name: 'Registry', level: 'CONFIDENTIAL', compartments: ['REGISTRY'] },
  { code: 'USSJA', name: 'US-SJA', level: 'CONFIDENTIAL', compartments: ['USSJA'] },
  { code: 'USSJA_RESTRICTED', name: 'US-SJA Restricted', level: 'CONFIDENTIAL', compartments: ['USSJA'], explicit: true },
  { code: 'USSJA_SEALED', name: 'US-SJA Sealed', level: 'SEALED', compartments: ['USSJA'], explicit: true },
  { code: 'USSJA_CLASSIFIED', name: 'US-SJA Classified', level: 'CLASSIFIED', compartments: ['USSJA'], explicit: true },
];

/** LEGAL_AUTHORITY_MATRIX.md – alle NOT_VERIFIED; [code, name, enabled, note] */
const FEATURE_FLAGS = [
  ['WARRANTS', 'Arrest and search warrants', 1, ''],
  ['SUBPOENAS', 'Subpoenas', 1, ''],
  ['COURT_DECISIONS', 'Court orders, judgments and opinions', 1, ''],
  ['SEALING', 'Sealing and unsealing of records', 1, ''],
  ['APPEALS', 'Appeals (Court of Appeals)', 1, ''],
  ['SUPREME_COURT_REVIEW', 'Supreme Court review', 1, ''],
  ['USSJA_PROCEEDINGS', 'US-SJA proceedings', 1, ''],
  ['CONSTITUTIONAL_REVIEW', 'Constitutional review', 0, 'Composition and jurisdiction must be verified against the ModernV constitution.'],
  ['REGISTRY_RECORDS', 'Birth, marriage and divorce records', 1, ''],
  ['REGISTRY_ADOPTION', 'Adoption records', 1, 'Whether a court decision is required is not yet verified.'],
  ['REGISTRY_CERTIFICATES', 'Registry certificates', 1, ''],
  ['DCLI_LICENSING', 'Commercial and resource licensing', 1, ''],
  ['DCLI_ENFORCEMENT', 'License suspension and revocation', 1, ''],
  ['DCLI_INSPECTIONS', 'Inspections and commercial investigations', 1, ''],
  ['SID_COERCIVE_MEASURES', 'SID coercive measures without court order', 0, 'SID powers must not be derived from the division name; verify against legal sources.'],
  ['USMS_WARRANT_EXECUTION', 'Warrant execution by USMS', 1, ''],
  ['USMS_ARRESTS', 'Arrests, prisoner transport, court security', 1, ''],
];

/**
 * Case Types (prompt.txt 6.1, PERMISSIONS.md 5). orgs: [Org-Code, Nummernpräfix].
 * Office-Sichtbarkeit (default_org_access) ist für alle Typen an (Entscheidung F9).
 * WARRANT fasst Haft- und Durchsuchungsbefehlsverfahren zusammen (Art über den Antrag).
 */
const CASE_TYPES = [
  { code: 'CRIMINAL', name: 'Criminal case', profile: 'STANDARD', orgs: [['DA', 'DA'], ['SA', 'SA'], ['AG', 'AG'], ['DC', 'DC-CR']] },
  { code: 'CIVIL', name: 'Civil case', profile: 'STANDARD', orgs: [['DC', 'DC-CV']] },
  { code: 'WARRANT', name: 'Warrant proceedings', profile: 'CONFIDENTIAL', orgs: [['DC', 'DC-W']], flag: 'WARRANTS', editScope: 'PARTICIPANTS' },
  { code: 'SUBPOENA', name: 'Subpoena proceedings', profile: 'STANDARD', orgs: [['DC', 'DC-SUB']], flag: 'SUBPOENAS', editScope: 'PARTICIPANTS' },
  { code: 'APPEAL', name: 'Appeal', profile: 'STANDARD', orgs: [['COA', 'COA']], flag: 'APPEALS', editScope: 'PARTICIPANTS' },
  { code: 'SUPREME_COURT', name: 'Supreme Court proceedings', profile: 'STANDARD', orgs: [['SC', 'SC']], flag: 'SUPREME_COURT_REVIEW', editScope: 'PARTICIPANTS' },
  { code: 'CONSTITUTIONAL', name: 'Constitutional review', profile: 'STANDARD', orgs: [['CC', 'CC']], flag: 'CONSTITUTIONAL_REVIEW', editScope: 'PARTICIPANTS' },
  { code: 'SID_INVESTIGATION', name: 'SID investigation', profile: 'SID', orgs: [['SID', 'SID']] },
  { code: 'DCLI_INVESTIGATION', name: 'Commercial investigation', profile: 'STANDARD', orgs: [['DCLI', 'DCLI-I']], flag: 'DCLI_INSPECTIONS' },
  { code: 'LICENSING', name: 'Licensing matter', profile: 'STANDARD', orgs: [['DCLI', 'DCLI-L']], flag: 'DCLI_LICENSING' },
  { code: 'REGISTRY', name: 'Registry matter', profile: 'REGISTRY', orgs: [['REG', 'REG']], flag: 'REGISTRY_RECORDS', editScope: 'PARTICIPANTS' },
  { code: 'US_SJA', name: 'US-SJA proceedings', profile: 'USSJA', orgs: [['USSJA', 'SJA']], flag: 'USSJA_PROCEEDINGS', editScope: 'PARTICIPANTS' },
  { code: 'USMS_OPERATION', name: 'USMS operation', profile: 'STANDARD', orgs: [['USMS', 'OPS']] },
  { code: 'USMS_INVESTIGATION', name: 'USMS investigation', profile: 'STANDARD', orgs: [['USMS', 'USMS']] },
];

module.exports = { ORGANIZATIONS, RANKS, rankCode, PERMISSIONS, ROLES, SECURITY_LEVELS, COMPARTMENTS, SECURITY_PROFILES, FEATURE_FLAGS, CASE_TYPES };
