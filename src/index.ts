#!/usr/bin/env node
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { log } from './logger.js';
import { ElsterBase } from './elster/base.js';
import { ElsterSync } from './elster/sync.js';
import { ElsterSubmissions } from './elster/submissions.js';
import { ElsterEdaten } from './elster/edaten.js';
import { ElsterEngine } from './elster/engine.js';
import { generateUstvaXml, detectReverseCharge } from './elster/xml.js';
import { KENNZIFFERN, PORTAL_URLS } from './elster/constants.js';
import {
  listTakeoverCandidates,
  isDatenuebernahmePage,
  TakeoverCandidate,
} from './elster/datenuebernahme.js';

const sync = new ElsterSync();
const submissions = new ElsterSubmissions();
const edaten = new ElsterEdaten();
const engine = new ElsterEngine();
/** Submission ids seen when the last handoff window opened; tells handoff_wait what is new. */
let handoffBaseline: Promise<Set<number> | null> | null = null;
const archiveDir = (dir?: string) => dir || path.resolve(loadConfig().runtime.downloadDir, 'nachweise');

class LoginProbe extends ElsterBase {
  async probe(): Promise<{ ok: boolean; finalUrl?: string; error?: string }> {
    try {
      const { page } = await this.initBrowser();
      try {
        await this.ensureLoggedIn(page);
        return { ok: true, finalUrl: page.url() };
      } finally {
        await this.closeBrowser();
      }
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
const loginProbe = new LoginProbe();

const FORM_URLS: Record<string, string> = {
  ustva: PORTAL_URLS.ustvaForm,
  eur: PORTAL_URLS.eurForm,
  est: PORTAL_URLS.estForm,
};

/**
 * Opens a form's entry page far enough to read the "Datenübernahme" offer, then
 * backs out again. Read-only: it never carries anything over and never fills.
 */
class TakeoverProbe extends ElsterBase {
  async list(form: string, year: number): Promise<{
    form: string;
    year: number;
    candidates: TakeoverCandidate[];
    note?: string;
  }> {
    const url = FORM_URLS[form];
    if (!url) throw new Error(`Unknown form "${form}". Use one of: ${Object.keys(FORM_URLS).join(', ')}.`);

    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));
      await this.handleModals(page);

      await this.selectFormYear(page, year);
      await this.handleModals(page);

      if (!await isDatenuebernahmePage(page)) {
        return { form, year, candidates: [], note: 'ELSTER did not show a Datenübernahme page for this form/year.' };
      }

      const candidates = await listTakeoverCandidates(page);
      return {
        form,
        year,
        candidates,
        note: candidates.length === 0
          ? 'ELSTER offers no earlier submission of this form to carry over.'
          : undefined,
      };
    } finally {
      await this.closeBrowser();
    }
  }
}
const takeoverProbe = new TakeoverProbe();

const TOOLS: Tool[] = [
  {
    name: 'elster_login_test',
    description: 'Verifies that the configured certificate + password can log into the ELSTER portal. Returns success and final URL or an error. Use this once before submitting anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_config_show',
    description: 'Shows the currently loaded ELSTER configuration (with secrets redacted) so you can verify env vars / config.json were picked up.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_kennziffern_list',
    description: 'Returns the list of supported UStVA Kennziffern (codes 81, 86, 66 etc.) with descriptions and whether they are NET (base amount) or TAX (tax amount).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_ustva_generate_xml',
    description: 'Generates an ELSTER UStVA XML snapshot for archiving. Does NOT submit (submission goes via elster_ustva_start). Useful for audit trails.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Tax year, e.g. 2026' },
        period: { type: ['integer', 'string'], description: 'Month (1-12) or quarter as "Q1".."Q4"' },
        report: {
          type: 'object',
          description: 'Map of Kennziffer → amount in EUR. Keys are the bare 2-3 digit code (e.g. "81", "66"). Net amounts for NET-type codes, tax amounts for TAX-type codes.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['year', 'period', 'report'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_ustva_detect_reverse_charge',
    description: 'Tests whether a voucher would be detected as Reverse-Charge (§13b UStG) based on the configured supplier patterns. Returns matched supplier and region (EU / NON_EU), or null.',
    inputSchema: {
      type: 'object',
      properties: {
        contactName: { type: 'string' },
        description: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_datenuebernahme_list',
    description: 'Lists the earlier submissions ELSTER offers to carry over ("Datenübernahme") for a given form and tax year, without starting a filling session. Read-only. Feed an aufgabeId or year from the result into the "takeover" argument of elster_ustva_start / elster_eur_start / elster_est_start.',
    inputSchema: {
      type: 'object',
      properties: {
        form: { type: 'string', enum: ['ustva', 'eur', 'est'], description: 'Which form to inspect.' },
        year: { type: 'integer', description: 'Tax year of the NEW form you intend to file.' },
      },
      required: ['form', 'year'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_edaten_fetch',
    description: 'Retrieves the pre-filled tax data ("vorausgefüllte Steuererklärung" / eDaten) the tax authority already holds for a year: Lohnsteuerbescheinigung, Vorsorgeaufwendungen, Lohnersatzleistungen, Riester/Rürup. ELSTER only exposes these from inside the ESt form, so this walks the form up to the import step and reads the values back. The form is left without saving, so no draft is kept (ELSTER may offer it for recovery at the next login). Nothing is ever transmitted.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Tax year to retrieve.' },
        anlagen: {
          type: 'array',
          items: { type: 'string' },
          description: 'Checkbox ids on the Anlagenauswahl page. Defaults to Hauptvordruck + Anlage N + Anlage Vorsorgeaufwand, which is what eDaten fills. Exact ids, e.g. "VAnlageN", "VAnlageG", "VAnlageKAP".',
        },
      },
      required: ['year'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_submissions_list',
    description: 'Lists everything under "Meine Formulare" → "Übermittelte Formulare": what was filed, when, its Ordnungskriterium, plus the aufgabeId to reuse it as a Datenübernahme source and the nachrichtId needed by elster_submission_protocol. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        formFilter: { type: 'string', description: 'Optional case-insensitive regex on the form description, e.g. "ESt unbeschränkt" or "Umsatzsteuer".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_submission_protocol',
    description: 'Reads the "Übertragungsprotokoll" of already-submitted returns — every field that was actually filed, with its Zeile number, label, value and ELSTER field id — so earlier years can be used as context. Select either by nachrichtId (from elster_submissions_list) or by formFilter/years. Read-only; returns real personal tax data.',
    inputSchema: {
      type: 'object',
      properties: {
        nachrichtId: {
          type: 'object',
          description: 'One specific submission, as returned by elster_submissions_list, e.g. { "type": "a", "id": 178614775 }.',
          properties: { type: { type: 'string' }, id: { type: 'integer' } },
          required: ['type', 'id'],
          additionalProperties: false,
        },
        formFilter: { type: 'string', description: 'Case-insensitive regex on the form description, e.g. "ESt unbeschränkt".' },
        years: { type: 'array', items: { type: 'integer' }, description: 'Restrict to these tax years.' },
        limit: { type: 'integer', description: 'Cap how many protocols to fetch (each is a round-trip). Default 3 when selecting by filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_sync_history',
    description: 'Reads "Übermittelte Formulare" (transmission history) from ELSTER. Optionally downloads PDFs.',
    inputSchema: {
      type: 'object',
      properties: {
        years: { type: 'array', items: { type: 'integer' } },
        downloadPdfs: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_sync_inbox',
    description: 'Reads ELSTER inbox messages ("Posteingang"). Optionally downloads each message as PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        downloadPdfs: { type: 'boolean', default: false },
        maxPages: { type: 'integer', default: 20 },
      },
      additionalProperties: false,
    },
  },
  // ---- Generic form engine (any ELSTER form, over HTTP, persistent session) ----
  {
    name: 'elster_drafts_list',
    description:
      'Lists saved drafts ("Meine Formulare → Entwürfe") with their aufgabeId, newest first. '
      + 'Uses the persistent engine session (logs in on first use, then stays logged in).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_form_open',
    description:
      'Opens a saved draft in the engine session and returns its Startseite (fields, repeat groups, '
      + 'navigation RIDs). Without aufgabeId the newest draft is opened. If ELSTER still holds the form '
      + 'open from an earlier call, it is re-entered instead of failing. Only one form can be open at a time.',
    inputSchema: {
      type: 'object',
      properties: { aufgabeId: { type: 'integer', description: 'From elster_drafts_list.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_new',
    description:
      'Starts a NEW form: picks the year, handles Datenübernahme (none by default), Anlagenauswahl and '
      + 'the eDaten import, and stops on the form\'s Startseite. Returns the page like elster_form_page. '
      + 'Follow with elster_form_save to persist it as a draft.',
    inputSchema: {
      type: 'object',
      properties: {
        form: { type: 'string', description: 'Portal slug from /eportal/formulare-leistungen/alleformulare/<slug>, e.g. "est", "euer", "ustvaeru".' },
        year: { type: 'integer' },
        anlagen: { type: 'array', items: { type: 'string' }, description: 'Anlagen checkbox values to select, e.g. ["VAnlageEUER"]. Omit to keep ELSTER\'s defaults.' },
        takeover: { type: 'string', description: 'aufgabeId of an earlier submission to carry over (see elster_datenuebernahme_list). Omit for none.' },
        importEdaten: { type: 'boolean', default: true, description: 'Accept the eDaten (vorausgefüllte Steuererklärung) import if offered.' },
      },
      required: ['form', 'year'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_page',
    description:
      'Reads a page of the open form. With rid, jumps there first (RIDs look like '
      + '"FormData://est-2025-v1/Startseite[0]/MAVSAnlageN[0]/VAnlageN[0]/HomeofficePauschale[0]" and come from '
      + 'the nav list of any page). Returns plain fields (name, kennzahl, label, value, options), repeat '
      + 'groups (committed rows, the template fields for a new row, sub-page RIDs), non-navigation commands, '
      + 'validation errors and the nav RIDs visible from this page. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { rid: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_set',
    description:
      'Sets plain fields on a page and saves them to the server-side form. Keys are a Kennzahl ("E0204507") '
      + 'or the field name ("eruNWkHomeofficeE0204507"); a key must match exactly one field on the page. '
      + 'Checkboxes take true/false, radios and selects take the option value. Money: fields labelled "(Euro)" '
      + 'accept whole euros only (no decimal separator — round expenses up, income down); "(Euro, Cent)" '
      + 'fields take "3,36". Validation errors come back in `errors` (HTTP is always 200). '
      + 'Sub-pages of detached repeat groups (e.g. ".../MZBErsteTaetigkeitsstaette[0]") are set with this tool too; '
      + 'jumping to index [n] of such a group creates entry n.',
    inputSchema: {
      type: 'object',
      properties: {
        rid: { type: 'string', description: 'Page to set fields on. Omit for the current page.' },
        values: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      },
      required: ['values'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_add_row',
    description:
      'Adds one row to an inline repeat group ("Mzb", e.g. Arbeitsmittel "AufwendungenArbeitsmittel") by '
      + 'filling its new-row template and committing it ("Eintrag übernehmen"). Group names and template keys '
      + 'come from elster_form_page → groups. Same key and money rules as elster_form_set.',
    inputSchema: {
      type: 'object',
      properties: {
        rid: { type: 'string' },
        group: { type: 'string' },
        values: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      },
      required: ['group', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_attach',
    description:
      'Attaches local files to a form\'s upload group, e.g. the Einspruch page "5 - Anhänge" (group "anhang_mzb"). '
      + 'PDF or XML, max 10 MB each, up to 20 files. Uploads each file the way the portal page does and creates '
      + 'one row per file. Submits nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        rid: { type: 'string', description: 'Page with the upload, e.g. "FormData://einspruch-23-v_23/Startseite[0]/Anhaenge[0]".' },
        group: { type: 'string', description: 'Upload group, e.g. "anhang_mzb".' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths.' },
      },
      required: ['group', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_delete_row',
    description: 'Deletes row `index` (0-based) of an inline repeat group on a page.',
    inputSchema: {
      type: 'object',
      properties: { rid: { type: 'string' }, group: { type: 'string' }, index: { type: 'integer' } },
      required: ['group', 'index'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_press',
    description:
      'Escape hatch: presses a button by id or posts a raw reqCmd JSON from elster_form_page → commands '
      + '(e.g. EditDetachedMzbSemIndex to add an Anlage for a person, FillInProfile, AddMzbItem). '
      + 'Sending, deleting drafts and logging out are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        rid: { type: 'string', description: 'Jump here first.' },
        buttonId: { type: 'string' },
        command: { type: ['string', 'object'], description: 'reqCmd JSON (string or object).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_crawl',
    description:
      'Walks every page below a RID (breadth-first, read-only) and returns each page\'s fields and repeat '
      + 'groups. Use it once per form/Anlage to learn which Kennzahl lives on which page.',
    inputSchema: {
      type: 'object',
      properties: {
        rootRid: { type: 'string' },
        maxPages: { type: 'integer', default: 60 },
      },
      required: ['rootRid'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_check',
    description:
      'Runs ELSTER\'s "Prüfen" on the open form. Returns ok, the headline (for ESt it includes the '
      + 'provisional "Erstattung/Nachzahlung"), and the error panel with the causing pages. Never sends.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_form_review',
    description:
      'Final check before the user submits: runs "Prüfen" and, only if it is clean, reads ELSTER\'s '
      + '"Formular absenden" overview — exactly the data that would be transmitted, including eDaten '
      + 'fields — as sections of rows (Zeile, label, value, Kennzahl, source). Returns to edit mode in the '
      + 'same call. Never transmits: "Absenden" stays refused, and no command but EINGABE/PRUEFEN is '
      + 'accepted while on the overview.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_form_handoff',
    description:
      'Hands a finished form to the USER for sending. Saves the open form (or takes the given draft), opens '
      + 'it in a separate, visible browser window with its own login, runs "Prüfen" and, if clean, moves on '
      + 'to the "Formular absenden" page. Then the MCP detaches from that window: it cannot click anything '
      + 'there. The user checks the overview, clicks "Absenden" themselves and closes the window. Until the '
      + 'window is closed the other elster_form_* tools refuse to run. Follow up with elster_form_handoff_wait, '
      + 'which returns when the window is closed and shows what was sent.',
    inputSchema: {
      type: 'object',
      properties: {
        aufgabeId: { type: 'integer', description: 'Draft to hand off when no form is open; default: newest draft.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_handoff_wait',
    description:
      'Call right after elster_form_handoff: blocks until the user closes the handoff window (or the timeout '
      + 'passes). If a new submission appeared, saves its Übertragungsprotokoll as HTML + PDF and returns the '
      + 'Transferticket and file paths. Read-only. If it returns closed:false, call it again.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMinutes: { type: 'number', description: 'Maximum wait, default 10.' },
        archiveDir: { type: 'string', description: 'Where to save the protocol of a new submission (HTML + PDF); default <downloadDir>/nachweise.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_submission_archive',
    description:
      'Saves the Übertragungsprotokoll of submitted forms as HTML and PDF, as proof of what was sent '
      + '(Transferticket, receipt time on the server, full content incl. attachment names). Select by '
      + 'nachrichtId (from elster_submissions_list) or by formFilter/years (newest first, limit default 1). '
      + 'Default folder: <downloadDir>/nachweise. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        nachrichtId: { type: 'integer', description: 'nachrichtId.id from elster_submissions_list.' },
        formFilter: { type: 'string', description: 'Regex on the form description, e.g. "^Einspruch$".' },
        years: { type: 'array', items: { type: 'integer' } },
        limit: { type: 'integer' },
        dir: { type: 'string', description: 'Target folder (absolute).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_belege_list',
    description: 'Lists receipts in "Meine Belege" (id, label, year, Belegart, recognised values, status). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { year: { type: 'integer', description: 'Only receipts for this tax year.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_beleg_upload',
    description:
      'Uploads one receipt file (PDF, PNG or JPG, max 10 MB) to "Meine Belege" and tags it with a Belegart and '
      + 'its values, so it is linked to the matching form line. Belegart is a path like "N/Arbeitsmittel" '
      + '(fields Art_der_Arbeitsmittel, Betrag), "N/Weitere_Wk/Sonst" (Bezeichnung, Betrag), "N/Fortb" '
      + '(Bezeichnung, Betrag), "N/Dienstreise". Betrag as number or "12,99". Stores a document in the account; '
      + 'submits nothing. Receipts are optional for the ESt (Belegvorhaltepflicht) but can avoid queries.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute path to the receipt.' },
        label: { type: 'string', description: 'Display name; default: file name.' },
        year: { type: 'integer' },
        belegart: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        stichwoerter: { type: 'array', items: { type: 'string' } },
        idNr: { type: 'string', description: 'Steuer-IdNr of the person; default: first person of the account.' },
      },
      required: ['file', 'year', 'belegart', 'fields'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_form_save',
    description:
      'Saves the open form as a draft ("Speichern und Formular verlassen") and closes it. '
      + 'Reopen with elster_form_open. The server session times out after ~30 min idle and unsaved work is '
      + 'then only in ELSTER\'s auto-recovery — save before long pauses.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function jsonResult(value: unknown) {
  // Compact JSON: indentation made large form pages ~40 % bigger for no gain
  // to the model reading them.
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function redactConfig() {
  const c = loadConfig();
  return {
    ...c,
    auth: {
      pfxPath: c.auth.pfxPath,
      password: c.auth.password ? `<set, length=${c.auth.password.length}>` : '<empty>',
    },
  };
}

async function dispatch(name: string, args: any) {
  switch (name) {
    case 'elster_login_test':
      return jsonResult(await loginProbe.probe());

    case 'elster_config_show':
      return jsonResult(redactConfig());

    case 'elster_kennziffern_list':
      return jsonResult(KENNZIFFERN);

    case 'elster_ustva_generate_xml': {
      const xml = generateUstvaXml(args.report, args.year, args.period);
      return { content: [{ type: 'text' as const, text: xml }] };
    }

    case 'elster_ustva_detect_reverse_charge':
      return jsonResult(detectReverseCharge({
        contactName: args.contactName,
        description: args.description,
      }));

    case 'elster_datenuebernahme_list':
      return jsonResult(await takeoverProbe.list(args.form, args.year));

    case 'elster_edaten_fetch':
      return jsonResult(await edaten.fetch({ year: args.year, anlagen: args.anlagen }));

    case 'elster_submissions_list': {
      const items = await submissions.list({ formFilter: args.formFilter });
      return jsonResult({ count: items.length, items });
    }

    case 'elster_submission_protocol': {
      if (args.nachrichtId) {
        return jsonResult(await submissions.protocol(args.nachrichtId));
      }
      if (!args.formFilter && !args.years) {
        throw new Error('Pass either nachrichtId, or formFilter / years to select submissions.');
      }
      const results = await submissions.protocolsFor({
        formFilter: args.formFilter,
        years: args.years,
        limit: args.limit ?? 3,
      });
      return jsonResult({ count: results.length, results });
    }

    case 'elster_sync_history': {
      const items = await sync.syncHistory({
        years: args.years,
        downloadPdfs: args.downloadPdfs,
      });
      return jsonResult({ count: items.length, items });
    }

    case 'elster_sync_inbox': {
      const items = await sync.syncInbox({
        downloadPdfs: args.downloadPdfs,
        maxPages: args.maxPages,
      });
      return jsonResult({ count: items.length, items });
    }

    case 'elster_drafts_list': {
      const items = await engine.drafts();
      return jsonResult({ count: items.length, items });
    }

    case 'elster_form_open':
      return jsonResult(await engine.open(args.aufgabeId));

    case 'elster_form_new':
      return jsonResult(await engine.newForm({
        form: args.form, year: args.year, anlagen: args.anlagen,
        takeover: args.takeover, importEdaten: args.importEdaten,
      }));

    case 'elster_form_page':
      return jsonResult(await engine.readPage(args.rid));

    case 'elster_form_set':
      return jsonResult(await engine.set(args.rid, args.values));

    case 'elster_form_add_row':
      return jsonResult(await engine.addRow(args.rid, args.group, args.values));

    case 'elster_form_attach':
      return jsonResult(await engine.attach(args.rid, args.group, args.files));

    case 'elster_form_delete_row':
      return jsonResult(await engine.deleteRow(args.rid, args.group, args.index));

    case 'elster_form_press':
      return jsonResult(await engine.press({ rid: args.rid, buttonId: args.buttonId, command: args.command }));

    case 'elster_form_crawl':
      return jsonResult(await engine.crawl(args.rootRid, args.maxPages));

    case 'elster_form_check':
      return jsonResult(await engine.check());

    case 'elster_belege_list': {
      const items = await engine.belegeList(args.year);
      return jsonResult({ count: items.length, items });
    }

    case 'elster_beleg_upload':
      return jsonResult(await engine.belegUpload(args));

    case 'elster_form_review':
      return jsonResult(await engine.review());

    case 'elster_form_save':
      return jsonResult(await engine.save());

    case 'elster_form_handoff_wait': {
      const w = await engine.waitHandoff(Math.min(Math.max(args.timeoutMinutes ?? 10, 0.1), 60) * 60000);
      if (!w.closed) return jsonResult({ ...w, note: 'Window still open; call elster_form_handoff_wait again.' });
      try {
        const items = await submissions.list({});
        const before = handoffBaseline ? await handoffBaseline : null;
        handoffBaseline = null;
        if (!before) return jsonResult({ ...w, newestSubmissions: items.slice(0, 3) });
        const fresh = items.filter(i => !before.has(i.nachrichtId.id));
        if (!fresh.length) return jsonResult({ ...w, sent: false, note: 'Window closed; nothing new was submitted.' });
        const archived = await submissions.archive({ nachrichtIds: fresh.map(i => i.nachrichtId.id), dir: archiveDir(args.archiveDir) });
        return jsonResult({ ...w, sent: true, newSubmissions: fresh, archived });
      } catch (e) {
        return jsonResult({ ...w, submissionsError: (e as Error).message, note: 'Window closed; read elster_submissions_list separately.' });
      }
    }

    case 'elster_form_handoff': {
      // Remember what was already submitted, so handoff_wait can tell what the user sent.
      handoffBaseline = new ElsterSubmissions().list({})
        .then(items => new Set(items.map(i => i.nachrichtId.id)))
        .catch(() => null);
      return jsonResult(await engine.handoff(args.aufgabeId));
    }

    case 'elster_submission_archive':
      return jsonResult({ archived: await submissions.archive({
        nachrichtIds: args.nachrichtId ? [args.nachrichtId] : undefined,
        formFilter: args.formFilter, years: args.years, limit: args.limit, dir: archiveDir(args.dir),
      }) });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  loadConfig();
  log.info('elster-mcp-server starting...');

  const server = new Server(
    { name: 'elster-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await dispatch(name, args ?? {});
    } catch (e: any) {
      log.error(`Tool ${name} failed: ${e.message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }, null, 2) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('elster-mcp-server ready on stdio.');

  // The engine keeps a browser open between calls, which would keep this
  // process alive after the client disconnects — and leave a logged-in ELSTER
  // session plus a Chrome behind for every past MCP session. Exit with stdin.
  let exiting = false;
  const shutdown = async (why: string) => {
    if (exiting) return;
    exiting = true;
    log.info(`elster-mcp-server shutting down (${why}).`);
    await Promise.race([engine.shutdown(), new Promise(r => setTimeout(r, 5000))]);
    process.exit(0);
  };
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
