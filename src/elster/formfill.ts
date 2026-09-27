import { Page } from 'puppeteer';
import { ElsterBase } from './base.js';
import { log } from '../logger.js';
import { PORTAL_URLS } from './constants.js';
import { NO_TAKEOVER, TakeoverChoice } from './datenuebernahme.js';

/**
 * Filling ESt form fields by their exact ELSTER id.
 *
 * `est.ts` matches fields by substring over id/name, which is too coarse for a
 * real Anlage N: "AnlageN" also hits "AnlageNDHH", and E0203503 appears once
 * per repeat group. The Übertragungsprotokolle of earlier years hand us the
 * authoritative ids instead — `data-name="id-N-Wk-EP-Erste_Taetig-E0203503_usb1_1-1-1-1-1"` —
 * so this module addresses fields exactly and reports what it could not find
 * rather than silently filling a neighbour.
 *
 * ELSTER uses TWO id systems, and this is the whole difficulty:
 *
 *   protocol / review page:
 *     id-N-Wk-EP-Erste_Taetig-E0203503_usb1_1-1-1-2-1
 *                             └ Kennzahl        └ repeat index
 *
 *   live input in the form:
 *     Startseite(0)_VHauptvordruck(0)_StpflPerson(0)_fields(eruESt1AAllgE0100801)
 *     └──────── section path, (n) = repeat index ────────┘        └ Kennzahl
 *
 * `getElementById(protocolId)` therefore never matches anything in the form.
 * The Kennzahl (E + 7 digits) is the one token both carry, so fields are
 * addressed by Kennzahl plus occurrence instead.
 *
 * Never submits: the flow stops at "Prüfen" and the review page.
 */

export interface FieldSpec {
  /**
   * ELSTER Kennzahl, e.g. "E0203503". Stable across years and the only token
   * the protocol ids and the live input ids have in common — see the id
   * anatomy note above.
   */
  kennzahl: string;
  value: string | number;
  /** Which repeat group, 0-based. Live ids carry it as `Section(N)`. */
  occurrence?: number;
  /** Free-text note carried into the result, for readable reports. */
  note?: string;
}

export interface FillOutcome {
  kennzahl: string;
  occurrence: number;
  fieldId?: string;
  value: string;
  status: 'set' | 'not-found' | 'readonly' | 'unchanged';
  note?: string;
  /** What the field actually held afterwards. */
  actual?: string;
}

export interface DiscoveredField {
  page: string;
  fieldId: string;
  label: string;
  type: string;
  value: string;
}

export class ElsterFormFill extends ElsterBase {

  /**
   * Opens the ESt form for a year with the given Anlagen and runs the eDaten
   * import, leaving the browser inside the form. Shared entry point for both
   * discovery and filling.
   */
  private async openForm(page: Page, year: number, anlagen: string[]): Promise<void> {
    await page.goto(PORTAL_URLS.estForm, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    await this.selectFormYear(page, year);
    await this.handleModals(page);
    await this.handleDatenuebernahme(page, NO_TAKEOVER as TakeoverChoice, log.info);

    // Skip the Anlagenassistent; we pick the Anlagen ourselves.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, a')).find(
        e => /Ohne Anlagenassistent fortfahren/i.test(e.textContent || '')
          && (e as HTMLElement).offsetParent !== null);
      if (b) (b as HTMLElement).click();
    });
    await this.settle(page, 7000);

    const picked = await page.evaluate((ids: string[]) => {
      const seen: string[] = [], missing: string[] = [];
      for (const id of ids) {
        const cb = document.querySelector(`input[type=checkbox][id="${id}"]`) as HTMLInputElement | null;
        if (!cb) { missing.push(id); continue; }
        if (!cb.checked) cb.click();
        seen.push(id);
      }
      return { seen, missing };
    }, anlagen);
    if (picked.missing.length) log.warn(`[fill] Anlagen not offered: ${picked.missing.join(', ')}`);
    log.info(`[fill] Anlagen: ${picked.seen.join(', ')}`);

    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => (document.querySelector('#Continue') as HTMLButtonElement | null)?.click());
    await this.settle(page, 8000);

    // eDaten import page, if it appears.
    if (page.url().includes('autovast')) {
      await page.evaluate(() => {
        const b = document.querySelector('#Finish') as HTMLButtonElement | null;
        if (b) b.click();
      });
      await this.settle(page, 8000);
    }
  }

  /**
   * Waits while keeping modals away. ELSTER warns about session expiry after a
   * while of no interaction, and long automated flows look exactly like that,
   * so the dialog has to be cleared repeatedly rather than once.
   */
  private async settle(page: Page, ms: number): Promise<void> {
    const step = 2000;
    for (let waited = 0; waited < ms; waited += step) {
      await new Promise(r => setTimeout(r, step));
      await this.handleModals(page);
      await this.keepSessionAlive(page);
    }
  }

  /** Dismisses the "Ihre Sitzung läuft ab" dialog wherever it renders. */
  private async keepSessionAlive(page: Page): Promise<void> {
    await page.evaluate(() => {
      const b = document.querySelector('#extendSessionButton') as HTMLElement | null;
      if (b && b.offsetParent !== null) { b.click(); return; }
      const alt = Array.from(document.querySelectorAll('button')).find(
        e => /Sitzung fortsetzen/i.test(e.textContent || '')
          && (e as HTMLElement).offsetParent !== null);
      if (alt) (alt as HTMLElement).click();
    }).catch(() => {});
  }

  /**
   * Walks every page of the form and records each input's id, label and value.
   * Use it to learn the ids of sections no earlier protocol covers — the
   * Reisekosten block, for instance, only exists once a trip was declared.
   */
  async discover(opts: { year: number; anlagen: string[]; navEntries?: string[] })
    : Promise<{ year: number; fields: DiscoveredField[]; pages: string[] }> {
    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await this.openForm(page, opts.year, opts.anlagen);

      const fields: DiscoveredField[] = [];
      const pages: string[] = [];

      const dumpHere = async () => {
        const got = await page.evaluate(() => {
          const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
          const pageName = clean(document.querySelector('h1')?.textContent) || location.href;
          const out: any[] = [];
          document.querySelectorAll('input, select, textarea').forEach(el => {
            const i = el as HTMLInputElement;
            if (i.type === 'hidden' || (!i.id && !i.name)) return;
            if (/^_csrf|reqCmd|ClientTableStatus/.test(i.name || '')) return;
            let label = '';
            if (i.id) label = clean(document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent);
            if (!label) {
              const row = i.closest('tr, .form-group, .field, li');
              label = clean(row?.querySelector('label')?.textContent);
            }
            out.push({ page: pageName, fieldId: i.id || i.name, label, type: i.type || i.tagName, value: i.value || '' });
          });
          return out;
        });
        if (got.length) { pages.push(got[0].page); fields.push(...got); }
      };

      for (const entry of opts.navEntries ?? []) {
        const ok = await this.openNav(page, entry);
        if (!ok) { log.warn(`[discover] nav "${entry}" not found`); continue; }
        for (let i = 0; i < 25; i++) {
          await dumpHere();
          if (!await this.nextPage(page)) break;
        }
      }
      if (!opts.navEntries?.length) {
        for (let i = 0; i < 40; i++) {
          await dumpHere();
          if (!await this.nextPage(page)) break;
        }
      }
      return { year: opts.year, fields, pages: [...new Set(pages)] };
    } finally {
      await this.closeBrowser();
    }
  }

  /**
   * Opens an Anlage from the navigation area. Entries are buttons whose ids are
   * `VHauptvordruck`, `VAnlageVor`, `MAVSAnlageN`, `MAVSAnlageG`, … — the `MAVS`
   * prefix marks Anlagen added after the initial selection. Their visible text
   * is "Daten vorhanden: Anlagen N", not "Anlage N", so matching on text fails;
   * address them by id and fall back to a loose text match.
   */
  private async openNav(page: Page, target: string): Promise<boolean> {
    // The navigation area starts collapsed; its entries exist in the DOM but
    // have no offsetParent, so any visibility check discards them. Expand it
    // first — #lug is "Navigationsbereich vollständig anzeigen".
    await page.evaluate(() => {
      const open = document.getElementById('lug') as HTMLElement | null;
      if (open && open.offsetParent !== null) open.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));
    await this.handleModals(page);

    const ok = await page.evaluate((t: string) => {
      const byId = document.getElementById(t)
        ?? document.getElementById(`MAVS${t}`)
        ?? document.getElementById(`V${t}`);
      // Click even when still hidden: the entry is functional either way, and
      // requiring visibility was exactly what made this fail before.
      if (byId) { (byId as HTMLElement).click(); return true; }
      const needle = t.replace(/^(MAVS|V)/, '').toLowerCase();
      const hit = Array.from(document.querySelectorAll('a, button')).find(e => {
        const txt = (e.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return txt.includes(needle) && (e as HTMLElement).offsetParent !== null;
      });
      if (!hit) return false;
      (hit as HTMLElement).click();
      return true;
    }, target).catch(() => false);
    if (ok) await this.settle(page, 5000);
    return ok;
  }

  /** Kennzahl embedded in a protocol id, e.g. "E0203503". */
  static kennzahlOf(protocolId: string): string | null {
    const m = protocolId.match(/\b(E\d{7})\b/);
    return m ? m[1] : null;
  }

  private async nextPage(page: Page): Promise<boolean> {
    const before = page.url();
    const ok = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(e => {
        const t = (e.textContent || '').trim();
        return t.includes('Nächste Seite') && (e as HTMLElement).offsetParent !== null;
      });
      if (!b) return false;
      (b as HTMLButtonElement).click();
      return true;
    });
    if (!ok) return false;
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await this.settle(page, 2000);
    return page.url() !== before;
  }

  /**
   * Sets the given fields wherever they appear, walking the whole form so that
   * fields on different pages are all reached. Returns one outcome per spec —
   * a field that was never found is reported, never silently skipped.
   */
  /**
   * Fills fields by Kennzahl across the requested Anlagen, and returns the
   * complete field inventory of every page it visited. The inventory is the
   * point as much as the filling: sections no earlier protocol covered — the
   * Reisekosten block, for instance — only reveal their Kennzahlen here.
   *
   * A field that is never found is reported as `not-found`, never skipped.
   */
  async fill(opts: {
    year: number;
    anlagen: string[];
    /** Navigation targets to visit, e.g. ["AnlageN", "AnlageG", "AnlageKAP"]. */
    visit?: string[];
    fields: FieldSpec[];
    saveDraft?: boolean;
  }): Promise<{
    year: number;
    outcomes: FillOutcome[];
    inventory: DiscoveredField[];
    pagesVisited: string[];
  }> {
    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await this.openForm(page, opts.year, opts.anlagen);

      const pending = new Map(
        opts.fields.map(f => [`${f.kennzahl}#${f.occurrence ?? 0}`, f]),
      );
      const outcomes: FillOutcome[] = [];
      const inventory: DiscoveredField[] = [];
      const pagesVisited: string[] = [];

      const processPage = async () => {
        const dump = await this.dumpPage(page);
        if (dump.length) {
          inventory.push(...dump);
          pagesVisited.push(dump[0].page);
        }
        if (!pending.size) return;

        const specs = [...pending.entries()].map(([key, f]) => ({
          key, kennzahl: f.kennzahl, occurrence: f.occurrence ?? 0, value: String(f.value),
        }));
        const done = await page.evaluate((list: any[]) => {
          const res: any[] = [];
          for (const f of list) {
            // Live ids embed the Kennzahl; repeat groups differ only in the
            // (n) path indices, so take them in document order.
            const hits = Array.from(
              document.querySelectorAll(`input[id*="${f.kennzahl}"], select[id*="${f.kennzahl}"], textarea[id*="${f.kennzahl}"]`),
            ) as HTMLInputElement[];
            const el = hits[f.occurrence];
            if (!el) continue;
            if (el.disabled || el.readOnly) {
              res.push({ ...f, status: 'readonly', fieldId: el.id }); continue;
            }
            if (el.type === 'checkbox' || el.type === 'radio') {
              const want = /^(1|true|ja|x)$/i.test(f.value);
              if (el.checked !== want) el.click();
              res.push({ ...f, status: el.checked === want ? 'set' : 'unchanged', fieldId: el.id, actual: String(el.checked) });
              continue;
            }
            el.focus();
            el.value = f.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.blur();
            res.push({ ...f, status: el.value === f.value ? 'set' : 'unchanged', fieldId: el.id, actual: el.value });
          }
          return res;
        }, specs);

        for (const d of done) {
          const spec = pending.get(d.key);
          outcomes.push({
            kennzahl: d.kennzahl, occurrence: d.occurrence, fieldId: d.fieldId,
            value: d.value, status: d.status, actual: d.actual, note: spec?.note,
          });
          pending.delete(d.key);
        }
        if (done.length) await this.settle(page, 1500);
      };

      // Hauptvordruck first, then each requested Anlage.
      for (let i = 0; i < 20; i++) {
        await processPage();
        if (!await this.nextPage(page)) break;
      }
      for (const target of opts.visit ?? []) {
        // The navigation entries live on the form's Startseite only; after
        // walking the Hauptvordruck we are nine pages away from them.
        await this.gotoStart(page, opts.year);
        if (!await this.openAnlage(page, target)) {
          log.warn(`[fill] could not open "${target}"`);
          continue;
        }
        for (let i = 0; i < 30; i++) {
          await processPage();
          if (!await this.nextPage(page)) break;
        }
      }

      for (const f of pending.values()) {
        outcomes.push({
          kennzahl: f.kennzahl, occurrence: f.occurrence ?? 0,
          value: String(f.value), status: 'not-found', note: f.note,
        });
      }

      if (opts.saveDraft) await this.saveAndLeave(page);
      return { year: opts.year, outcomes, inventory, pagesVisited: [...new Set(pagesVisited)] };
    } finally {
      await this.closeBrowser();
    }
  }

  /** Returns to the form's Startseite, where the navigation entries live. */
  private async gotoStart(page: Page, year: number): Promise<void> {
    await page.goto(
      `https://www.elster.de/eportal/interpreter/eingabe/est-${year}/Startseite`,
      { waitUntil: 'networkidle2', timeout: 60000 },
    ).catch(() => {});
    await this.settle(page, 3000);
  }

  /** Records every visible input on the current page. */
  private async dumpPage(page: Page): Promise<DiscoveredField[]> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const pageName = clean(document.querySelector('h1')?.textContent) || location.href;
      const out: any[] = [];
      document.querySelectorAll('input, select, textarea').forEach(el => {
        const i = el as HTMLInputElement;
        if (i.type === 'hidden' || i.type === 'search' || (!i.id && !i.name)) return;
        if (/^_csrf|reqCmd|ClientTableStatus/.test(i.name || '')) return;
        let label = '';
        if (i.id) label = clean(document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent);
        if (!label) label = clean(i.closest('tr, .form-group, .field, li')?.querySelector('label')?.textContent);
        out.push({ page: pageName, fieldId: i.id || i.name, label, type: i.type || i.tagName, value: i.value || '' });
      });
      return out;
    }).catch(() => []);
  }

  /**
   * Navigating to an Anlage is two-stage: the navigation button (#MAVSAnlageN)
   * opens a link page listing the variants — Anlage N, N-AUS, N-DHH, N-Gre —
   * which carries no input fields at all. The wanted variant has to be clicked
   * there before the actual form pages appear.
   */
  private async openAnlage(page: Page, target: string): Promise<boolean> {
    if (!await this.openNav(page, target)) return false;

    const hasFields = await page.evaluate(() =>
      document.querySelectorAll('input[id*="_fields("]').length > 0).catch(() => false);
    if (hasFields) return true;

    const label = target.replace(/^(MAVS|V)/, '').replace(/^Anlage/, 'Anlage ');
    const drilled = await page.evaluate((want: string) => {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      const links = Array.from(document.querySelectorAll('a, button'))
        .filter(e => (e as HTMLElement).offsetParent !== null);
      // Exact match first: "Anlage N" must not select "Anlage N-AUS".
      const exact = links.find(e => norm(e.textContent || '') === want);
      const hit = exact ?? links.find(e => {
        const t = norm(e.textContent || '');
        return t.startsWith(want) && !/AUS|DHH|Gre|Hilfe/i.test(t);
      });
      if (!hit) return false;
      (hit as HTMLElement).click();
      return true;
    }, label).catch(() => false);

    if (drilled) await this.settle(page, 5000);
    return drilled;
  }

  private async saveAndLeave(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, a')).find(
        e => /Speichern und Formular verlassen/i.test(e.textContent || '')
          && (e as HTMLElement).offsetParent !== null);
      if (!b) return false;
      (b as HTMLElement).click();
      return true;
    });
    if (!clicked) { log.warn('[fill] save-and-leave button not found'); return; }
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(e => {
        const t = (e.textContent || '').trim();
        return (t === 'Speichern und Verlassen' || t === 'Speichern' || t === 'Ja')
          && (e as HTMLElement).offsetParent !== null;
      });
      if (b) (b as HTMLButtonElement).click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));
    log.info('[fill] draft saved');
  }
}
