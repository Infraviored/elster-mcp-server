import { Page } from 'puppeteer';
import { ElsterBase } from './base.js';
import { log } from '../logger.js';
import { PORTAL_URLS } from './constants.js';

/**
 * Reading back what has already been submitted ("Meine Formulare" →
 * "Übermittelte Formulare"), so an agent can use previous years as context.
 *
 * The portal drives this area over its own RPC-ish endpoint rather than page
 * navigations: POST /eportal/nachrichten with a multipart body carrying a
 * single `reqCmd` field and an `x-csrf-token` header. The response is an HTML
 * fragment. Two commands matter here:
 *
 *   {"ViewMessageCommand":{"nachrichtId":{"type":"a","id":…},"urlId":"meineformulare",…}}
 *       → the "Übertragungsprotokoll" modal, which already contains every
 *         submitted field. This is the useful one.
 *   {"DecryptModalCommand":{"nachrichtId":…,"dokumentId":…,…}}
 *       → the same content as a downloadable PDF/HTML document. Not needed:
 *         the protocol fragment above is already the full content, and the
 *         download buttons only exist inside that fragment anyway.
 *
 * Everything here is read-only.
 */

export interface SubmissionRef {
  /** ELSTER's message id, e.g. { type: "a", id: 178614775 }. */
  nachrichtId: { type: string; id: number };
  description: string;
  /** Tax year parsed out of `description`, when recognisable. */
  year: number | null;
  ordnungskriterium: string;
  sentAt: string;
  status: string;
  /** Feed to a *_start tool's `takeover` argument, when present. */
  aufgabeId: string | null;
  /** Identifies the provisional tax calculation, when present. */
  abgabeXmlId: number | null;
}

export interface ProtocolRow {
  /** The "Zeile" number printed on the paper form, when the row has one. */
  zeile: string | null;
  label: string;
  value: string;
  /** ELSTER's own field identifier, e.g. "id-N-ArbL-LStB_1_5_Einz-E0200204_usb1_1-1-1-1". */
  fieldId: string | null;
}

export interface ProtocolSection {
  /** Form the rows belong to, e.g. "Hauptvordruck ESt 1 A" or "Anlage N (…)". */
  form: string;
  /** Heading path within the form, e.g. ["Angaben zum Arbeitslohn", "Lohnsteuerbescheinigung(en) Steuerklasse 1-5"]. */
  heading: string[];
  rows: ProtocolRow[];
}

export interface SubmissionProtocol {
  title: string;
  /** Header block: Finanzamt, Transferticket, Eingang auf Server, … */
  meta: Record<string, string>;
  sections: ProtocolSection[];
  rowCount: number;
}

function parseYear(desc: string): number | null {
  for (const m of desc.matchAll(/\b(\d{4})\b/g)) {
    const n = parseInt(m[1], 10);
    if (n >= 1990 && n <= 2099) return n;
  }
  return null;
}

export class ElsterSubmissions extends ElsterBase {

  /** Lists everything under "Übermittelte Formulare". */
  async list(opts: { formFilter?: string } = {}): Promise<SubmissionRef[]> {
    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await this.openUebermittelteFormulare(page);
      const rows = await this.readRows(page);
      if (!opts.formFilter) return rows;
      const re = new RegExp(opts.formFilter, 'i');
      return rows.filter(r => re.test(r.description));
    } finally {
      await this.closeBrowser();
    }
  }

  /**
   * Fetches the Übertragungsprotokoll of one submission and parses it into
   * form → heading → rows. `nachrichtId` comes from list().
   */
  async protocol(nachrichtId: { type: string; id: number }): Promise<SubmissionProtocol> {
    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await this.openUebermittelteFormulare(page);
      return await this.fetchProtocol(page, nachrichtId);
    } finally {
      await this.closeBrowser();
    }
  }

  /**
   * list() + protocol() in one browser session — fetching several years
   * separately would re-login and re-navigate for each one.
   */
  async protocolsFor(opts: {
    formFilter?: string;
    years?: number[];
    limit?: number;
  }): Promise<Array<{ ref: SubmissionRef; protocol?: SubmissionProtocol; error?: string }>> {
    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await this.openUebermittelteFormulare(page);

      let refs = await this.readRows(page);
      if (opts.formFilter) {
        const re = new RegExp(opts.formFilter, 'i');
        refs = refs.filter(r => re.test(r.description));
      }
      if (opts.years?.length) refs = refs.filter(r => r.year != null && opts.years!.includes(r.year));
      if (opts.limit != null) refs = refs.slice(0, opts.limit);

      const out: Array<{ ref: SubmissionRef; protocol?: SubmissionProtocol; error?: string }> = [];
      for (const ref of refs) {
        try {
          out.push({ ref, protocol: await this.fetchProtocol(page, ref.nachrichtId) });
        } catch (e: any) {
          out.push({ ref, error: e.message });
        }
      }
      return out;
    } finally {
      await this.closeBrowser();
    }
  }

  private async openUebermittelteFormulare(page: Page): Promise<void> {
    await page.goto(PORTAL_URLS.meineFormulare, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    await this.handleModals(page);

    const clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button')).find(e => {
        const t = (e.textContent || '').toLowerCase();
        return t.includes('übermittelte') && t.includes('formulare');
      });
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    });
    if (!clicked) log.warn('"Übermittelte Formulare" tab not found — using whatever the page shows.');
    await new Promise(r => setTimeout(r, 4000));
    await this.handleModals(page);
  }

  private async readRows(page: Page): Promise<SubmissionRef[]> {
    return page.evaluate(() => {
      const cellByLabel = (row: Element, label: string): string => {
        const td = Array.from(row.querySelectorAll('td'))
          .find(c => (c.getAttribute('data-rwd') || '') === label);
        if (!td) return '';
        const clone = td.cloneNode(true) as Element;
        clone.querySelectorAll('.table-collapse__cellTitle, button, a').forEach(n => n.remove());
        return (clone.textContent || '').replace(/\s+/g, ' ').trim();
      };

      return Array.from(document.querySelectorAll('button[id^="showUebermitteltesFormular_"]')).map(btn => {
        const row = btn.closest('tr');
        let nachrichtId = { type: 'a', id: 0 };
        try {
          const cmd = JSON.parse(btn.getAttribute('data-req-cmd') || '{}');
          const n = cmd?.ViewMessageCommand?.nachrichtId;
          if (n) nachrichtId = { type: String(n.type), id: Number(n.id) };
        } catch { /* leave the zero id; the caller sees it */ }

        const takeover = row?.querySelector('a[id^="datenuebernahme_"]');
        const calc = row?.querySelector('button[id^="steuerberechnung_"]') as HTMLButtonElement | null;
        let abgabeXmlId: number | null = null;
        if (calc) {
          try { abgabeXmlId = JSON.parse(calc.value)?.ViewSteuerberechnung?.abgabeXmlId ?? null; } catch { /* ignore */ }
        }

        return {
          nachrichtId,
          description: (btn.textContent || '').replace(/\s+/g, ' ').trim(),
          ordnungskriterium: row ? cellByLabel(row, 'Ordnungskriterium') : '',
          sentAt: row ? cellByLabel(row, 'Übermittelt am') : '',
          status: row ? cellByLabel(row, 'Status') : '',
          aufgabeId: takeover ? takeover.id.replace('datenuebernahme_', '') : null,
          abgabeXmlId,
        };
      });
    }).then(rows => rows.map(r => ({ ...r, year: parseYear(r.description) })));
  }

  /** POSTs a reqCmd to /eportal/nachrichten from inside the logged-in page. */
  private async postReqCmd(page: Page, reqCmd: string): Promise<string> {
    const csrf = await page.evaluate(() =>
      document.querySelector('meta[name="_csrf"]')?.getAttribute('content')
      ?? (document.querySelector('input[name="_csrf"]') as HTMLInputElement | null)?.value
      ?? null);
    if (!csrf) throw new Error('CSRF token not found on the page.');

    const res = await page.evaluate(async (cmd: string, token: string) => {
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="reqCmd"\r\n\r\n${cmd}\r\n--${boundary}--\r\n`;
      const r = await fetch('/eportal/nachrichten', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'text/html, application/json',
          'content-type': `multipart/form-data; boundary=${boundary}`,
          eopfetchtype: 'interactive',
          'x-csrf-token': token,
        },
        body,
      });
      return { status: r.status, text: await r.text() };
    }, reqCmd, csrf);

    if (res.status !== 200) throw new Error(`ELSTER returned HTTP ${res.status} for reqCmd.`);
    return res.text;
  }

  private async fetchProtocol(
    page: Page,
    nachrichtId: { type: string; id: number },
  ): Promise<SubmissionProtocol> {
    const reqCmd = JSON.stringify({
      ViewMessageCommand: { nachrichtId, urlId: 'meineformulare', interactiveId: null },
    });
    const html = await this.postReqCmd(page, reqCmd);

    const parsed = await page.evaluate((fragment: string) => {
      // Scripts do not execute via innerHTML, and the fragment is ELSTER's own
      // markup, so parsing it in a detached node is safe and keeps us on one DOM.
      const root = document.createElement('div');
      root.innerHTML = fragment;

      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const title = clean(root.querySelector('.modal__title')?.textContent);

      // Header block: "Label: value" lines above the first form page.
      // Values may themselves contain colons ("Eingang auf Server: 31.07.2025,
      // 23:32:07"), so each value runs up to the next known label, not to the
      // next colon.
      const META_LABELS = 'Datenübermittler|Steuernummer|Finanzamt|Eingang auf Server|Transferticket|Erstellungsdatum';
      const meta: Record<string, string> = {};
      // Scope to the header block: without this the last label would run on
      // into the form pages, since its value is bounded only by end-of-text.
      const headerNode = root.cloneNode(true) as Element;
      headerNode
        .querySelectorAll('.eoprint__page, .eoprint__page__note, .modal__footer, button')
        .forEach(n => n.remove());
      for (const m of clean(headerNode.textContent).matchAll(
        new RegExp(`(${META_LABELS}):\\s*(.*?)(?=\\s+(?:${META_LABELS}):|$)`, 'g'),
      )) {
        meta[m[1]] = clean(m[2]);
      }

      const sections: Array<{ form: string; heading: string[]; rows: any[] }> = [];
      // Rows before the first <h1> are the protocol's own header block.
      let form = 'Kopfdaten';
      const heading: string[] = [];

      const pushRows = (table: Element) => {
        const rows = Array.from(table.querySelectorAll('tr')).map(tr => {
          const cells = Array.from(tr.querySelectorAll('td'));
          if (cells.length === 0) return null;

          // Layouts seen: [zeile, label, value] and [zeile, value] (checked fields).
          const first = clean(cells[0].textContent);
          const zeile = /^\d+$/.test(first) ? first : null;
          const rest = zeile ? cells.slice(1) : cells;
          const valueCell = rest.length > 1 ? rest[rest.length - 1] : rest[0];
          const label = rest.length > 1 ? clean(rest[0].textContent) : '';

          const named = valueCell?.querySelector('[data-name]');
          return {
            zeile,
            label,
            value: clean(valueCell?.textContent),
            fieldId: named ? named.getAttribute('data-name') : null,
          };
        }).filter(Boolean);

        if (rows.length) {
          sections.push({ form, heading: [...heading], rows });
        }
      };

      // Walk the fragment in document order so headings scope the tables under them.
      const walker = root.querySelectorAll('h1, h2, h3, h4, table.eoprint__table');
      walker.forEach(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'table') { pushRows(el); return; }
        const text = clean(el.textContent);
        if (tag === 'h1') {
          if (text.startsWith('Übertragungsprotokoll')) return; // the modal title
          form = text;
          heading.length = 0;
        } else {
          const depth = parseInt(tag[1], 10) - 2; // h2 → 0, h3 → 1, h4 → 2
          heading.length = Math.max(0, Math.min(depth, heading.length));
          heading[depth] = text;
          heading.length = depth + 1;
        }
      });

      return { title, meta, sections };
    }, html);

    const rowCount = parsed.sections.reduce((n: number, s: any) => n + s.rows.length, 0);
    return { ...parsed, rowCount } as SubmissionProtocol;
  }
}
