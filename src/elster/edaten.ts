import { Page } from 'puppeteer';
import { ElsterBase } from './base.js';
import { log } from '../logger.js';
import { PORTAL_URLS } from './constants.js';
import { NO_TAKEOVER, TakeoverChoice } from './datenuebernahme.js';
import { parseEoprint, EoprintDocument } from './eoprint.js';

/**
 * eDaten / VaSt — the "vorausgefüllte Steuererklärung".
 *
 * The tax authority already holds what employers and insurers transmitted
 * electronically: the Lohnsteuerbescheinigung, Vorsorgeaufwendungen,
 * Lohnersatzleistungen, Riester/Rürup, Rentenbezugsmitteilungen. ELSTER pulls
 * them into a new return automatically — but only from *inside* the form, and
 * only once the Anlagen have been chosen. "Bescheinigungen verwalten" in the
 * portal menu only manages consent; it never shows the data.
 *
 * The path, confirmed against the live portal:
 *
 *   /alleformulare/est  → pick year → #Enter
 *   → /interpreter/fruehereAbgaben/est-<year>      (Datenübernahme, skipped)
 *   → /wizard/seq/estaa-7/grundangaben             (Anlagenassistent)
 *        "Ohne Anlagenassistent fortfahren"
 *   → /interpreter/anlagenauswahl/est-<year>       (tick Anlagen, #Continue)
 *   → /wizard/seq/autovastuebernahme-1/autovast-progress
 *        the import runs on its own here; #Finish ("Weiter") confirms it
 *
 * Consent must already be granted ("Sie haben dem Abrufen und Vorausfüllen
 * bereits zugestimmt" under Formulare und Leistungen → Bescheinigungen
 * verwalten). Without it the autovast step is skipped silently.
 *
 * SIDE EFFECT: reaching the import necessarily creates a draft under
 * "Meine Formulare". Nothing is ever transmitted — the flow stops before
 * "Prüfen" and never touches "Absenden" — but the draft stays until deleted.
 */

/** Checkbox ids on the Anlagenauswahl page. Exact ids: `VAnlageN` and
 *  `VAnlageNDHH` both contain "AnlageN", so substring matching picks up
 *  Anlagen nobody asked for. Match exactly. */
export const ANLAGE_IDS = {
  hauptvordruck: 'VHauptvordruck',
  n: 'VAnlageN',
  nDoppelteHaushaltsfuehrung: 'VAnlageNDHH',
  vorsorgeaufwand: 'VAnlageVor',
  g: 'VAnlageG',
  s: 'VAnlageS',
  kap: 'VAnlageKAP',
  so: 'VAnlageSO',
  sonderausgaben: 'VAnlageSA',
  aussergewBelastungen: 'VAnlageAgB',
  haushaltsnah: 'VAnlageHA35a',
} as const;

/** What eDaten normally fills. Anything outside this list is on you. */
export const DEFAULT_ANLAGEN = [
  ANLAGE_IDS.hauptvordruck,
  ANLAGE_IDS.n,
  ANLAGE_IDS.vorsorgeaufwand,
];

export interface EdatenField {
  form: string;
  heading: string[];
  zeile: string | null;
  label: string;
  value: string;
  fieldId: string | null;
  /** ELSTER marks imported values; true when this came from eDaten. */
  fromEdaten: boolean;
}

export interface EdatenResult {
  year: number;
  /** True when the autovast step actually ran. */
  imported: boolean;
  /** What the portal said on the import page. */
  message: string;
  anlagen: string[];
  fields: EdatenField[];
  fieldCount: number;
  /** The "Versenden" review page: every value with its provenance badge. */
  review: EoprintDocument | null;
  draftWarning: string;
}

export class ElsterEdaten extends ElsterBase {

  async fetch(opts: { year: number; anlagen?: string[]; saveDraft?: boolean }): Promise<EdatenResult> {
    const year = opts.year;
    const anlagen = opts.anlagen?.length ? opts.anlagen : [...DEFAULT_ANLAGEN];

    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);

      log.info(`[eDaten] Opening ESt form for ${year}...`);
      await page.goto(PORTAL_URLS.estForm, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));
      await this.selectFormYear(page, year);
      await this.handleModals(page);

      // The takeover page would carry last year's entries over. For a pure
      // eDaten read that only adds noise, so it is always declined here.
      await this.handleDatenuebernahme(page, NO_TAKEOVER as TakeoverChoice, log.info);

      await this.skipAnlagenassistent(page);
      await this.selectAnlagen(page, anlagen);
      const { imported, message } = await this.runImport(page);
      const fields = imported ? await this.readImportedFields(page) : [];
      const review = await this.readReviewPage(page);

      // Autosave inside the form is only a session-recovery state, not an
      // Entwurf — closing the browser loses it, and handleModals declines the
      // "Wiederaufnahme" prompt on the next visit. Only an explicit
      // "Speichern und Formular verlassen" produces a draft that survives.
      if (opts.saveDraft) await this.saveAndLeave(page);

      return {
        year,
        imported,
        message,
        anlagen,
        fields,
        fieldCount: fields.length,
        review,
        draftWarning:
          'A draft was created under "Meine Formulare". Nothing was transmitted. Delete it if unwanted.',
      };
    } finally {
      await this.closeBrowser();
    }
  }

  private async skipAnlagenassistent(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, a')).find(
        e => /Ohne Anlagenassistent fortfahren/i.test(e.textContent || '')
          && (e as HTMLElement).offsetParent !== null,
      );
      if (!b) return false;
      (b as HTMLElement).click();
      return true;
    });
    if (!clicked) {
      log.info('[eDaten] No Anlagenassistent page — already past it.');
      return;
    }
    await new Promise(r => setTimeout(r, 7000));
    await this.handleModals(page);
  }

  private async selectAnlagen(page: Page, wanted: string[]): Promise<void> {
    const result = await page.evaluate((ids: string[]) => {
      const seen: string[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const cb = document.querySelector(`input[type=checkbox][id="${id}"]`) as HTMLInputElement | null;
        if (!cb) { missing.push(id); continue; }
        if (!cb.checked) cb.click();
        seen.push(id);
      }
      return { seen, missing };
    }, wanted);

    if (result.missing.length) {
      log.warn(`[eDaten] Anlagen not found on the selection page: ${result.missing.join(', ')}`);
    }
    log.info(`[eDaten] Anlagen selected: ${result.seen.join(', ')}`);

    await new Promise(r => setTimeout(r, 1500));
    const applied = await page.evaluate(() => {
      const b = document.querySelector('#Continue') as HTMLButtonElement | null;
      if (!b) return false;
      b.click();
      return true;
    });
    if (!applied) throw new Error('"Übernehmen" button on the Anlagenauswahl page not found.');

    await new Promise(r => setTimeout(r, 8000));
    await this.handleModals(page);
  }

  /**
   * The import runs by itself on autovast-progress; #Finish confirms it.
   * When consent is missing or nothing is on file, ELSTER skips this page
   * entirely and lands straight in the form.
   */
  private async runImport(page: Page): Promise<{ imported: boolean; message: string }> {
    const onImportPage = page.url().includes('autovast');
    if (!onImportPage) {
      return {
        imported: false,
        message: 'ELSTER did not run an eDaten import — no consent, or nothing on file for this year.',
      };
    }

    const message = await page.evaluate(() =>
      (document.querySelector('h1, .modal__title')?.textContent || document.title)
        .replace(/\s+/g, ' ').trim());
    log.info(`[eDaten] ${message}`);

    const clicked = await page.evaluate(() => {
      const b = document.querySelector('#Finish') as HTMLButtonElement | null;
      if (b && b.offsetParent !== null) { b.click(); return true; }
      const alt = Array.from(document.querySelectorAll('button')).find(
        e => (e.textContent || '').trim() === 'Weiter' && (e as HTMLElement).offsetParent !== null);
      if (alt) { (alt as HTMLButtonElement).click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('"Weiter" on the eDaten import page not found.');

    await new Promise(r => setTimeout(r, 8000));
    await this.handleModals(page);
    return { imported: true, message };
  }

  /**
   * Reads back what landed in the form. ELSTER renders imported values with a
   * provenance marker (the "Übernommen aus …" badge), which is what
   * `fromEdaten` reflects.
   */
  private async readImportedFields(page: Page): Promise<EdatenField[]> {
    const out: EdatenField[] = [];

    // Walking "Nächste Seite" from the start only reaches the Hauptvordruck
    // pages. The Anlagen hang off the left navigation tree, so jump there
    // directly for the ones eDaten actually fills.
    for (const anlage of ['Anlage N', 'Anlage Vorsorgeaufwand']) {
      const jumped = await this.openNavEntry(page, anlage);
      if (!jumped) { log.warn(`[eDaten] Navigation entry "${anlage}" not found.`); continue; }
      const pages = await this.collectFormPages(page);
      for (const p of pages) out.push(...p);
    }

    if (out.length === 0) {
      const pages = await this.collectFormPages(page);
      for (const p of pages) out.push(...p);
    }
    return out;
  }

  /**
   * Opens "Versenden des Formulars" and parses the review table. That page is
   * the only place that shows every field together with where its value came
   * from — Bescheinigung (eDaten), Profil, frühere Abgabe or own entry — which
   * is exactly what distinguishes pre-filled data from what still has to be
   * typed. Reading it never submits; "Absenden" sits further down and is not
   * touched.
   */
  private async readReviewPage(page: Page): Promise<EoprintDocument | null> {
    const opened = await page.evaluate(() => {
      const b = document.querySelector('#SwitchModusSenden') as HTMLElement | null;
      if (b && b.offsetParent !== null) { b.click(); return true; }
      const alt = Array.from(document.querySelectorAll('button, a')).find(
        e => /Versenden/i.test(e.textContent || '') && (e as HTMLElement).offsetParent !== null);
      if (alt) { (alt as HTMLElement).click(); return true; }
      return false;
    }).catch(() => false);
    if (!opened) { log.warn('[eDaten] "Versenden des Formulars" tab not found.'); return null; }

    // The review page renders the whole form and takes a while; poll for the
    // eoprint tables instead of sleeping blindly, and keep dismissing the
    // session-timeout warning that a long idle wait would otherwise trigger.
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 2500));
      await this.handleModals(page);
      const ready = await page.evaluate(() =>
        document.querySelectorAll('table').length > 0
        && /versenden/i.test(location.href)).catch(() => false);
      if (ready) break;
    }
    log.info(`[eDaten] Review page: ${page.url()}`);
    return parseEoprint(page);
  }

  /** Clicks an entry in the form's left navigation tree. */
  private async openNavEntry(page: Page, label: string): Promise<boolean> {
    const ok = await page.evaluate((txt: string) => {
      const els = Array.from(document.querySelectorAll('a, button, li'));
      const hit = els.find(e => {
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        return t.startsWith(txt) && t.length < txt.length + 40
          && (e as HTMLElement).offsetParent !== null;
      });
      if (!hit) return false;
      (hit as HTMLElement).click();
      return true;
    }, label).catch(() => false);
    if (ok) {
      await new Promise(r => setTimeout(r, 4000));
      await this.handleModals(page);
    }
    return ok;
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
    if (!clicked) { log.warn('[eDaten] "Speichern und Formular verlassen" not found.'); return; }

    await new Promise(r => setTimeout(r, 3000));
    // A confirmation modal follows; handleModals declines "leave" dialogs, so
    // confirm this one explicitly instead.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(e => {
        const t = (e.textContent || '').trim();
        return (t === 'Speichern und Verlassen' || t === 'Speichern' || t === 'Ja')
          && (e as HTMLElement).offsetParent !== null;
      });
      if (b) (b as HTMLButtonElement).click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));
    log.info('[eDaten] Draft saved.');
  }

  private async collectFormPages(page: Page): Promise<EdatenField[][]> {
    const collected: EdatenField[][] = [];
    const MAX_PAGES = 30;
    let lastUrl = '';
    let same = 0;

    for (let i = 0; i < MAX_PAGES; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const url = page.url();
      if (url === lastUrl) {
        if (++same >= 3) break;
      } else same = 0;
      lastUrl = url;

      await this.handleModals(page);
      collected.push(await this.readCurrentPage(page));

      const advanced = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(e => {
          const t = (e.textContent || '').trim();
          return (t.includes('Nächste Seite') || t === 'Weiter')
            && (e as HTMLElement).offsetParent !== null;
        });
        if (!b) return false;
        (b as HTMLButtonElement).click();
        return true;
      });
      if (!advanced) break;
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    return collected;
  }

  private async readCurrentPage(page: Page): Promise<EdatenField[]> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const form = clean(document.querySelector('h1')?.textContent);
      const out: any[] = [];

      document.querySelectorAll('input[type=text], input:not([type]), input[type=number]')
        .forEach(el => {
          const inp = el as HTMLInputElement;
          if (inp.type === 'hidden' || !inp.value) return;

          const row = inp.closest('tr, .form-group, .field, li, div');
          let label = '';
          if (inp.id) label = clean(document.querySelector(`label[for="${inp.id}"]`)?.textContent);
          if (!label && row) {
            const l = row.querySelector('label, .table-collapse__cellTitle');
            label = clean(l?.textContent);
          }
          const zeileEl = row?.querySelector('.eoprint__tableCell, .zeilennummer');
          const zeile = zeileEl && /^\d+$/.test(clean(zeileEl.textContent))
            ? clean(zeileEl.textContent) : null;

          // ELSTER badges imported values with a provenance hint.
          const marker = row?.textContent || '';
          const fromEdaten = /Übernommen aus|übermittelte Daten|eDaten|Bescheinigung/i.test(marker);

          out.push({
            form,
            heading: [],
            zeile,
            label: label.slice(0, 200),
            value: inp.value,
            fieldId: inp.id || inp.name || null,
            fromEdaten,
          });
        });
      return out;
    });
  }
}
