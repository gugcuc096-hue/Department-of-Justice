// @ts-check
'use strict';
/**
 * Dokumentvorlagen und -typen (prompt.txt 8.1–8.4). Vorlagen in deutscher Sprache (Entscheidung F5),
 * Gerichtsbeschluss und Durchsuchungsbeschluss nach den Mustern des Auftraggebers; die übrigen Vorlagen
 * sind frei gestaltet, aber im selben Stil. Platzhalter {{feld}} werden beim Rendern escaped.
 *
 * Rechtsgrundlagen sind nicht verifiziert – die Vorlagen enthalten deshalb keine Paragraphen.
 */

const COURTS = ['DC', 'COA', 'SC', 'USSJA', 'CC'];

/** @type {{ code: string, name: string, fields: { key: string, label: string, type: 'text'|'textarea'|'date', required?: boolean }[], body: string }[]} */
const TEMPLATES = [
  {
    code: 'COURT_ORDER', name: 'Gerichtsbeschluss',
    fields: [
      { key: 'vorsitzenderRichter', label: 'Vorsitzender Richter', type: 'text', required: true },
      { key: 'beisitzenderRichter', label: 'Beisitzender Richter', type: 'text' },
      { key: 'schriftfuehrer', label: 'Schriftführer', type: 'text' },
      { key: 'klaeger', label: 'Kläger', type: 'text' },
      { key: 'angeklagtePerson', label: 'Angeklagte Person', type: 'text' },
      { key: 'anklageschrift', label: 'Anklageschrift', type: 'textarea' },
      { key: 'beschluss', label: 'Beschluss', type: 'textarea', required: true },
      { key: 'begruendung', label: 'Begründung', type: 'textarea', required: true },
    ],
    body: `<h2 class="doc-heading">GERICHTSBESCHLUSS DES {{issuer.nameUpper}}</h2>
<dl class="doc-fields">
  <dt>Vorsitzender Richter</dt><dd>{{vorsitzenderRichter}}</dd>
  <dt>Beisitzender Richter</dt><dd>{{beisitzenderRichter}}</dd>
  <dt>Schriftführer</dt><dd>{{schriftfuehrer}}</dd>
  <dt>Kläger</dt><dd>{{klaeger}}</dd>
  <dt>Angeklagte Person</dt><dd>{{angeklagtePerson}}</dd>
</dl>
<h3>Anklageschrift</h3><p>{{anklageschrift}}</p>
<h3>Beschluss</h3><p>{{beschluss}}</p>
<h3>Begründung</h3><p>{{begruendung}}</p>`,
  },
  {
    code: 'SEARCH_WARRANT', name: 'Durchsuchungsbeschluss',
    fields: [
      { key: 'delikt', label: 'Wegen des Verdachts', type: 'text', required: true },
      { key: 'beschluss', label: 'Beschluss', type: 'textarea', required: true },
      { key: 'begruendung', label: 'Begründung', type: 'textarea', required: true },
    ],
    body: `<p class="doc-court">{{issuer.nameUpper}}</p>
<h2 class="doc-heading">BESCHLUSS</h2>
<p>In dem Ermittlungsverfahren</p>
<p>wegen des Verdachts {{delikt}}</p>
<p>erlässt das {{issuer.name}} folgenden</p>
<h2 class="doc-heading">BESCHLUSS</h2>
<p>{{beschluss}}</p>
<h3 class="doc-heading">BEGRÜNDUNG</h3>
<p>{{begruendung}}</p>`,
  },
  {
    code: 'ARREST_WARRANT', name: 'Haftbefehl',
    fields: [
      { key: 'beschuldigtePerson', label: 'Beschuldigte Person', type: 'text', required: true },
      { key: 'delikt', label: 'Wegen des Verdachts', type: 'text', required: true },
      { key: 'beschluss', label: 'Anordnung', type: 'textarea', required: true },
      { key: 'begruendung', label: 'Begründung', type: 'textarea', required: true },
    ],
    body: `<p class="doc-court">{{issuer.nameUpper}}</p>
<h2 class="doc-heading">HAFTBEFEHL</h2>
<p>In dem Ermittlungsverfahren</p>
<p>gegen {{beschuldigtePerson}}</p>
<p>wegen des Verdachts {{delikt}}</p>
<p>erlässt das {{issuer.name}} folgenden</p>
<h2 class="doc-heading">BESCHLUSS</h2>
<p>{{beschluss}}</p>
<h3 class="doc-heading">BEGRÜNDUNG</h3>
<p>{{begruendung}}</p>`,
  },
  {
    code: 'SUBPOENA', name: 'Vorladung',
    fields: [
      { key: 'geladenePerson', label: 'Geladene Person', type: 'text', required: true },
      { key: 'termin', label: 'Termin', type: 'text', required: true },
      { key: 'ort', label: 'Ort', type: 'text', required: true },
      { key: 'gegenstand', label: 'Gegenstand des Verfahrens', type: 'textarea', required: true },
      { key: 'hinweise', label: 'Hinweise', type: 'textarea' },
    ],
    body: `<p class="doc-court">{{issuer.nameUpper}}</p>
<h2 class="doc-heading">VORLADUNG</h2>
<dl class="doc-fields">
  <dt>Geladene Person</dt><dd>{{geladenePerson}}</dd>
  <dt>Termin</dt><dd>{{termin}}</dd>
  <dt>Ort</dt><dd>{{ort}}</dd>
</dl>
<h3>Gegenstand des Verfahrens</h3><p>{{gegenstand}}</p>
<h3>Hinweise</h3><p>{{hinweise}}</p>`,
  },
  {
    code: 'JUDGMENT', name: 'Urteil',
    fields: [
      { key: 'beteiligte', label: 'Beteiligte', type: 'textarea', required: true },
      { key: 'entscheidung', label: 'Entscheidung', type: 'textarea', required: true },
      { key: 'begruendung', label: 'Begründung', type: 'textarea', required: true },
    ],
    body: `<p class="doc-court">{{issuer.nameUpper}}</p>
<h2 class="doc-heading">URTEIL</h2>
<p>In der Sache {{case.title}}</p>
<h3>Beteiligte</h3><p>{{beteiligte}}</p>
<h3 class="doc-heading">ENTSCHEIDUNG</h3><p>{{entscheidung}}</p>
<h3 class="doc-heading">BEGRÜNDUNG</h3><p>{{begruendung}}</p>`,
  },
  {
    code: 'PROSECUTION_FILING', name: 'Schriftsatz der Staatsanwaltschaft',
    fields: [
      { key: 'betreff', label: 'Betreff', type: 'text', required: true },
      { key: 'sachverhalt', label: 'Sachverhalt', type: 'textarea', required: true },
      { key: 'antrag', label: 'Antrag', type: 'textarea' },
      { key: 'begruendung', label: 'Begründung', type: 'textarea' },
    ],
    body: `<p class="doc-court">{{issuer.nameUpper}}</p>
<h2 class="doc-heading">{{betreff}}</h2>
<h3>Sachverhalt</h3><p>{{sachverhalt}}</p>
<h3>Antrag</h3><p>{{antrag}}</p>
<h3>Begründung</h3><p>{{begruendung}}</p>`,
  },
  {
    code: 'REPORT', name: 'Bericht',
    fields: [
      { key: 'sachverhalt', label: 'Sachverhalt', type: 'textarea', required: true },
      { key: 'massnahmen', label: 'Maßnahmen', type: 'textarea' },
      { key: 'ergebnis', label: 'Ergebnis', type: 'textarea' },
    ],
    body: `<h2 class="doc-heading">{{doc.title}}</h2>
<h3>Sachverhalt</h3><p>{{sachverhalt}}</p>
<h3>Maßnahmen</h3><p>{{massnahmen}}</p>
<h3>Ergebnis</h3><p>{{ergebnis}}</p>`,
  },
  {
    code: 'HEARING_PROTOCOL', name: 'Sitzungsprotokoll',
    fields: [
      { key: 'termin', label: 'Termin', type: 'text', required: true },
      { key: 'anwesende', label: 'Anwesende', type: 'textarea', required: true },
      { key: 'verlauf', label: 'Verlauf der Sitzung', type: 'textarea', required: true },
      { key: 'ergebnis', label: 'Ergebnis', type: 'textarea' },
    ],
    body: `<p class="doc-court">{{issuer.nameUpper}}</p>
<h2 class="doc-heading">SITZUNGSPROTOKOLL</h2>
<p>In der Sache {{case.title}}</p>
<dl class="doc-fields">
  <dt>Termin</dt><dd>{{termin}}</dd>
</dl>
<h3>Anwesende</h3><p>{{anwesende}}</p>
<h3>Verlauf der Sitzung</h3><p>{{verlauf}}</p>
<h3>Ergebnis</h3><p>{{ergebnis}}</p>`,
  },
  {
    code: 'MEMO', name: 'Vermerk',
    fields: [{ key: 'text', label: 'Text', type: 'textarea', required: true }],
    body: `<h2 class="doc-heading">{{doc.title}}</h2>
<p>{{text}}</p>`,
  },
];

/** Dokumenttypen. orgs: Org-Codes (inkl. Unterorganisationen), null = alle. workflowOnly: entsteht nur über ein Antragsverfahren. */
const DOCUMENT_TYPES = [
  { code: 'MEMO', name: 'Memorandum', suffix: 'M', template: 'MEMO', sign: 'DOCUMENT_SIGN', orgs: null },
  { code: 'REPORT', name: 'Official report', suffix: 'R', template: 'REPORT', sign: 'DOCUMENT_SIGN', orgs: null },
  { code: 'PROSECUTION_FILING', name: 'Prosecutorial filing', suffix: 'S', template: 'PROSECUTION_FILING', sign: 'DOCUMENT_SIGN', orgs: ['PROSECUTION'] },
  { code: 'COURT_ORDER', name: 'Court order (Beschluss)', suffix: 'B', template: 'COURT_ORDER', sign: 'DECISION_SIGN', orgs: COURTS, flag: 'COURT_DECISIONS' },
  { code: 'JUDGMENT', name: 'Judgment (Urteil)', suffix: 'U', template: 'JUDGMENT', sign: 'DECISION_SIGN', orgs: COURTS, flag: 'COURT_DECISIONS' },
  { code: 'SEARCH_WARRANT', name: 'Search warrant (Durchsuchungsbeschluss)', suffix: 'DB', template: 'SEARCH_WARRANT', sign: 'WARRANT_SIGN', orgs: ['DC', 'USSJA'], flag: 'WARRANTS', workflowOnly: true },
  { code: 'ARREST_WARRANT', name: 'Arrest warrant (Haftbefehl)', suffix: 'HB', template: 'ARREST_WARRANT', sign: 'WARRANT_SIGN', orgs: ['DC', 'USSJA'], flag: 'WARRANTS', workflowOnly: true },
  { code: 'SUBPOENA', name: 'Subpoena (Vorladung)', suffix: 'V', template: 'SUBPOENA', sign: 'DECISION_SIGN', orgs: ['DC'], flag: 'SUBPOENAS' },
  { code: 'HEARING_PROTOCOL', name: 'Hearing protocol (Sitzungsprotokoll)', suffix: 'P', template: 'HEARING_PROTOCOL', sign: 'DOCUMENT_SIGN', orgs: COURTS },
  { code: 'ATTACHMENT', name: 'Attachment (uploaded file)', suffix: 'A', template: null, sign: null, orgs: null },
];

module.exports = { TEMPLATES, DOCUMENT_TYPES };
