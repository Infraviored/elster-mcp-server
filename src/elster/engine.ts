import { Page } from 'puppeteer';
import { ElsterBase } from './base.js';
import { installDriver } from './engine-driver.js';
import { log } from '../logger.js';
import { parseEoprint } from './eoprint.js';
import { BelegUploadInput, prepareBeleg, postBelegInPage, listBelegeInPage } from './belege.js';

/**
 * Generic, form-agnostic access to ELSTER's form engine.
 *
 * Unlike the per-form flows (ustva/eur/est), which click through a fresh
 * browser per run, the engine keeps ONE logged-in browser for the lifetime of
 * the MCP process and drives every form over HTTP from inside that tab (see
 * engine-driver.ts). After login the tab is never navigated again: all page
 * state lives in the driver's parsed `EO.doc`.
 *
 * Calls are serialized — the server-side form state is a single cursor per
 * session, so two interleaved calls would jump each other's pages.
 *
 * Safety: the engine fills, checks ("Prüfen") and saves drafts. It cannot
 * send. Commands that transmit, delete a draft or log out are refused both
 * here and inside the driver.
 */
export class ElsterEngine extends ElsterBase {
  private queue: Promise<unknown> = Promise.resolve();
  private loggedIn = false;

  private static readonly FORBIDDEN = [
    /"target"\s*:\s*"SENDEN"/i,
    /Absenden/i,
    /Senden/,
    /Uebermittl|Übermittl/i,
    /DeleteEntwurfAufgabe/i,
    /Logout/i,
  ];

  static assertAllowed(what: string): void {
    for (const re of ElsterEngine.FORBIDDEN) {
      if (re.test(what)) {
        throw new Error(`Refused: "${what.slice(0, 120)}" would send, delete or log out. `
          + 'The engine only fills, checks and saves drafts; submitting is done by the user in the portal.');
      }
    }
  }

  /** Runs `fn` after every earlier call has settled. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser || !this.browser.connected || !this.page || this.page.isClosed()) {
      this.browser = null;
      this.page = null;
      this.loggedIn = false;
      await this.initBrowser();
      // A background tab gets frozen by Chrome; there is exactly one tab here.
      const pages = await this.browser!.pages();
      for (const p of pages) if (p !== this.page) await p.close().catch(() => {});
    }
    const page = this.page!;
    if (!this.loggedIn) {
      await this.ensureLoggedIn(page);
      this.loggedIn = true;
      log.info('[engine] logged in; tab parked at ' + page.url());
    }
    await page.evaluate(installDriver);
    return page;
  }

  /** Calls a driver method inside the tab; re-logs in once if the session died. */
  /**
   * Where ELSTER sends a dead session. Seen in the wild: /eportal/login/…,
   * /eportal/start, and /eportal/javaScriptTest?parentPageUrl=… (after the
   * ~30 min idle timeout).
   */
  private static readonly LOGGED_OUT = /\/eportal\/(login|start|javaScriptTest)\b|sessionEnded|abgemeldet/i;

  /** Asks ELSTER whether the session is alive, without touching form state. */
  private async sessionAlive(page: Page): Promise<boolean> {
    return page.evaluate(async (re: string) => {
      const r = await fetch('/eportal/meinelster', { credentials: 'include', redirect: 'follow' });
      return !new RegExp(re, 'i').test(r.url);
    }, ElsterEngine.LOGGED_OUT.source).catch(() => false);
  }

  /**
   * Calls a driver method inside the tab. If the session died — detected by
   * the URL the driver ended on, or by the call failing while the session is
   * gone — logs in again and retries once. A retry after re-login starts from
   * a fresh session: an open form is closed server-side and must be reopened.
   */
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.serial(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const page = await this.ensurePage();
        let result: T;
        try {
          result = await page.evaluate(
            (m: string, a: unknown[]) => (window as any).EO[m](...a),
            method, args,
          ) as T;
        } catch (e) {
          if (attempt === 1 && !(await this.sessionAlive(page))) {
            log.warn(`[engine] ${method} failed on a dead session, logging in again`);
            this.loggedIn = false;
            await page.evaluate(() => { (window as any).EO = undefined; }).catch(() => {});
            continue;
          }
          throw e;
        }
        const url = await page.evaluate(() => (window as any).EO.url as string);
        if (attempt === 1 && ElsterEngine.LOGGED_OUT.test(url)) {
          log.warn('[engine] session ended, logging in again');
          this.loggedIn = false;
          continue;
        }
        return result;
      }
      throw new Error('ELSTER session could not be restored');
    });
  }

  private summary(withNav = true) {
    return this.call<any>('summary', { withNav });
  }

  /** Closes the persistent browser; called when the MCP client goes away. */
  async shutdown(): Promise<void> {
    this.loggedIn = false;
    await this.closeBrowser().catch(() => {});
  }

  // ---- public API (one method per MCP tool) -------------------------------

  async drafts() {
    return this.call<any[]>('drafts');
  }

  async open(aufgabeId?: number) {
    const opened = await this.call<any>('openDraft', aufgabeId);
    return { ...opened, page: await this.summary() };
  }

  async newForm(opts: { form: string; year: number; anlagen?: string[]; takeover?: string; importEdaten?: boolean }) {
    const res = await this.call<any>('newForm', opts.form, opts.year, opts.anlagen ?? null,
      opts.takeover ?? null, opts.importEdaten ?? true);
    return { ...res, page: await this.summary() };
  }

  async readPage(rid?: string) {
    if (rid) await this.call('jump', rid);
    return this.summary();
  }

  async set(rid: string | undefined, values: Record<string, unknown>) {
    if (rid) await this.call('jump', rid);
    await this.call('setFields', values);
    const names = await this.call<string[]>('getLastSetNames');
    if (rid) await this.call('jump', rid);
    // Compact on purpose: echoing the whole page cost ~8k tokens per call.
    const [set, errors, title, rid2] = await Promise.all([
      this.call<any[]>('valuesOf', names), this.call<string[]>('errors'),
      this.call<string>('title'), this.call<string | null>('rid'),
    ]);
    return { rid: rid2, title, errors, set };
  }

  async addRow(rid: string | undefined, group: string, values: Record<string, unknown>) {
    if (rid) await this.call('jump', rid);
    await this.call('addRow', group, values);
    return this.groupResult(group);
  }

  async deleteRow(rid: string | undefined, group: string, index: number) {
    if (rid) await this.call('jump', rid);
    await this.call('deleteRow', group, index);
    return this.groupResult(group);
  }

  private async groupResult(group: string) {
    const page = await this.summary(false);
    const g = page.groups.find((x: any) => x.group === group);
    const sums = page.fields.filter((f: any) => f.value !== '' && /Sum/.test(f.name))
      .map((f: any) => ({ kennzahl: f.kennzahl, value: f.value, label: f.label.slice(0, 80) }));
    return { rid: page.rid, errors: page.errors, group: g && { group: g.group, entries: g.entries, rows: g.rows }, sums };
  }

  /** Receipts in "Meine Belege", optionally filtered by year. Read-only. */
  async belegeList(year?: number) {
    return this.serial(async () => {
      const page = await this.ensurePage();
      return page.evaluate(listBelegeInPage, year ? String(year) : null);
    });
  }

  /**
   * Uploads one receipt to "Meine Belege" (see belege.ts for the wire format).
   * This stores a document in the user's ELSTER account; it does not submit
   * any return. Images are converted to PDF in a throwaway tab.
   */
  async belegUpload(input: BelegUploadInput) {
    return this.serial(async () => {
      const page = await this.ensurePage();
      const prepared = await prepareBeleg(input, () => this.browser!.newPage());
      return page.evaluate(postBelegInPage, prepared);
    });
  }

  async press(opts: { buttonId?: string; command?: string | object; rid?: string }) {
    const text = opts.buttonId ?? (typeof opts.command === 'string' ? opts.command : JSON.stringify(opts.command ?? ''));
    ElsterEngine.assertAllowed(text);
    if (opts.rid) await this.call('jump', opts.rid);
    if (opts.buttonId) await this.call('press', opts.buttonId);
    else if (opts.command) await this.call('post', opts.command);
    else throw new Error('Give either buttonId or command.');
    return this.summary();
  }

  async crawl(rootRid: string, maxPages = 60) {
    return this.call<any>('crawl', rootRid, maxPages);
  }

  async check() {
    return this.call<any>('check');
  }

  /**
   * The final overview ELSTER shows before "Absenden", parsed row by row.
   * Read-only: the driver enters the overview, captures it and returns to
   * editing in the same call; see engine-driver.ts review().
   */
  async review() {
    const r = await this.call<any>('review');
    if (!r.ok) return { ok: false, check: r.check, note: r.note };
    const doc = await this.serial(() => parseEoprint(this.page!, r.html));
    const sections = doc.sections.map(sec => ({
      form: sec.form,
      heading: sec.heading.join(' › '),
      rows: sec.rows.map(row => ({
        zeile: row.zeile,
        label: row.label,
        value: row.value,
        kennzahl: (row.fieldId?.match(/E\d{7}/) || [null])[0],
        source: row.source ?? undefined,
      })),
    }));
    return { ok: true, result: r.check?.result, meta: doc.meta, rowCount: doc.rowCount, sections };
  }

  async save() {
    const r = await this.call<any>('saveDraft');
    return { saved: /meinelster/.test(r.url), ...r };
  }
}
