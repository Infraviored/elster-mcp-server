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

  /** Keep in sync with ALLOWED_COMMANDS / ALLOWED_MODES in engine-driver.ts. */
  static readonly ALLOWED_COMMANDS = new Set([
    'JumpToPage', 'JumpToItemCause', 'NextPage', 'PreviousPage', 'ToggleNavItem', 'Refresh', 'CheckAll',
    'SwitchModus',
    'AddMzbItem', 'CreateMzbItem', 'UpdateMzbItem', 'EditMzbItem', 'DeleteMzbItem', 'EditDetachedMzbSemIndex',
    'FillInProfile',
    'Enter', 'Continue', 'Cancel', 'FruehereAbgabeCommand',
    'OeffneAufgabeCommand', 'OeffneLetztenEntwurfCommand', 'SaveAufgabe', 'Finish',
  ]);
  static readonly ALLOWED_MODES = new Set(['EINGABE', 'PRUEFEN', 'ANLAGENAUSWAHL', 'AUTOVAST_ENTRY', 'VAST']);

  private static readonly FORBIDDEN = [
    /send/i,
    /uebermittl|übermittl/i,
    /delete(?!mzbitem)/i,
    /l(oe|ö)sch/i,
    /logout|abmelden/i,
    /\/(sign|rpc)\b/i,
  ];

  /** Text check for button ids and similar plain strings. */
  static assertAllowed(what: string): void {
    for (const re of ElsterEngine.FORBIDDEN) {
      if (re.test(what)) {
        throw new Error(`Refused: "${what.slice(0, 120)}" would send, delete or log out. `
          + 'The engine only fills, checks and saves drafts; submitting is done by the user in the portal.');
      }
    }
  }

  /**
   * Checks a reqCmd the same way the driver does: parsed and re-serialised
   * (so JSON escapes cannot hide anything), exactly one command name, name on
   * the allowlist, SwitchModus only to an allowed mode. Returns the canonical
   * text, which is what gets posted.
   */
  static assertCommand(command: string | object): string {
    let obj: any = command;
    if (typeof command === 'string') {
      try { obj = JSON.parse(command); } catch { throw new Error('Refused: command is not valid JSON.'); }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length !== 1) {
      throw new Error('Refused: a command must be a JSON object with exactly one command name.');
    }
    const name = Object.keys(obj)[0];
    if (!ElsterEngine.ALLOWED_COMMANDS.has(name)) {
      throw new Error(`Refused: command "${name}" is not on the engine's allowlist.`);
    }
    if (name === 'SwitchModus' && !ElsterEngine.ALLOWED_MODES.has(obj[name]?.target)) {
      throw new Error(`Refused: SwitchModus target "${obj[name]?.target}" is not allowed.`);
    }
    const text = JSON.stringify(obj);
    ElsterEngine.assertAllowed(text);
    return text;
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
  /**
   * Runs `fn` with a logged-in page, serialized. If it fails while the session
   * is dead — or leaves the driver on a logged-out URL — logs in again and
   * retries once. After a re-login an open form is closed server-side and
   * must be reopened.
   */
  private async withSession<T>(label: string, fn: (page: Page) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const page = await this.ensurePage();
        let result: T;
        try {
          result = await fn(page);
        } catch (e) {
          if (attempt === 1 && !(await this.sessionAlive(page))) {
            log.warn(`[engine] ${label} failed on a dead session, logging in again`);
            this.loggedIn = false;
            await page.evaluate(() => { (window as any).EO = undefined; }).catch(() => {});
            continue;
          }
          throw e;
        }
        const url = await page.evaluate(() => (window as any).EO?.url as string | undefined).catch(() => undefined);
        if (attempt === 1 && url && ElsterEngine.LOGGED_OUT.test(url)) {
          log.warn(`[engine] ${label}: session ended, logging in again`);
          this.loggedIn = false;
          continue;
        }
        return result;
      }
      throw new Error('ELSTER session could not be restored');
    });
  }

  /** Calls a driver method inside the tab (see withSession for re-login). */
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.withSession(method, page => page.evaluate(
      (m: string, a: unknown[]) => (window as any).EO[m](...a),
      method, args,
    ) as Promise<T>);
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
    return this.withSession('belegeList', page => page.evaluate(listBelegeInPage, year ? String(year) : null));
  }

  /**
   * Uploads one receipt to "Meine Belege" (see belege.ts for the wire format).
   * This stores a document in the user's ELSTER account; it does not submit
   * any return. Images are converted to PDF in a throwaway tab.
   */
  async belegUpload(input: BelegUploadInput) {
    // Prepare outside the retry: reading and converting the file is not session-bound.
    const prepared = await this.withSession('prepareBeleg', () => prepareBeleg(input, () => this.browser!.newPage()));
    return this.withSession('belegUpload', page => page.evaluate(postBelegInPage, prepared));
  }

  async press(opts: { buttonId?: string; command?: string | object; rid?: string }) {
    if (opts.buttonId && opts.command) throw new Error('Give either buttonId or command, not both.');
    if (opts.buttonId) ElsterEngine.assertAllowed(opts.buttonId);
    const command = opts.command ? ElsterEngine.assertCommand(opts.command) : null;
    if (!opts.buttonId && !command) throw new Error('Give either buttonId or command.');
    if (opts.rid) await this.call('jump', opts.rid);
    if (opts.buttonId) await this.call('press', opts.buttonId);
    else await this.call('post', command);
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
