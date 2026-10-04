/**
 * ELSTER UStVA-Kennziffern (Stand 2025).
 * Source-of-truth: official ELSTER UStVA schema documentation.
 *
 * type = NET → Bemessungsgrundlage (net amount entered)
 * type = TAX → tax amount (input-tax / output-tax)
 */
export const KENNZIFFERN: Record<string, { type: 'NET' | 'TAX'; description: string }> = {
  '81': { type: 'NET', description: 'Steuerpflichtige Umsätze 19%' },
  '86': { type: 'NET', description: 'Steuerpflichtige Umsätze 7%' },
  '83': { type: 'NET', description: 'Steuerfreie Umsätze ohne Vorsteuerabzug' },
  '41': { type: 'NET', description: 'Innergemeinschaftliche Lieferungen' },
  '45': { type: 'NET', description: 'Übrige nicht steuerbare Umsätze' },
  '89': { type: 'NET', description: 'Steuerpflichtige EG-Lieferungen' },
  '60': { type: 'TAX', description: 'Übrige Vorsteuer' },
  '61': { type: 'TAX', description: 'Vorsteuer aus innergemeinschaftlichem Erwerb' },
  '66': { type: 'TAX', description: 'Vorsteuer aus Rechnungen (§15 UStG)' },
  '67': { type: 'TAX', description: 'Vorsteuer aus Reverse-Charge §13b UStG' },
  // Reverse-Charge §13b UStG
  '46': { type: 'NET', description: 'Sonstige Leistung EU-Unternehmer §13b Abs.1 (BMG 19%)' },
  '47': { type: 'TAX', description: 'USt auf KZ 46 (selbstberechnet)' },
  '73': { type: 'NET', description: 'Leistungen §13b Abs.2 Nr.1-5 (Drittland; BMG 19%)' },
  '74': { type: 'TAX', description: 'USt auf KZ 73 (selbstberechnet)' },
};

export const PORTAL_URLS = {
  start: 'https://www.elster.de/eportal/start',
  loginCert: 'https://www.elster.de/eportal/login/softpse',
  ustvaForm: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare/ustvaeru',
  eurForm: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare/euer',
  estForm: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare/est',
  meineFormulare: 'https://www.elster.de/eportal/meineformulare',
  posteingang: 'https://www.elster.de/eportal/meinelster/meinposteingang',
};
