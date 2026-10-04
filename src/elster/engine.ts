import fs from 'fs';
import path from 'path';
import puppeteer, { Page } from 'puppeteer';
import { loadConfig } from '../config.js';
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
  /** True while a handoff window (see handoff()) is open for the user. */
  private handoffOpen = false;

  /** Keep in sync with ALLOWED_COMMANDS / ALLOWED_MODES in engine-driver.ts. */
  static readonly ALLOWED_COMMANDS = new Set([
    'JumpToPage', 'JumpToItemCause', 'NextPage', 'PreviousPage', 'ToggleNavItem', 'Refresh', 'CheckAll',
    'SwitchModus',
    'AddMzbItem', 'CreateMzbItem', 'UpdateMzbItem', 'EditMzbItem', 'DeleteMzbItem', 'EditDetachedMzbSemIndex',
    'FillInProfile',
    'Enter', 'Continue', 'Cancel', 'FruehereAbgabeCommand',
    'OeffneAufgabeCommand', 'OeffneLetztenEntwurfCommand', 'SaveAufgabe', 'Finish',
    'UploadMzbAnhang', 'CreateMzbAnhangItems',
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
      if (this.handoffOpen) {
        throw new Error('A handoff window is open for the user to send. The engine is paused until it is '
          + 'closed, so a re-login here cannot end that session.');
      }
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
    if (!/^[a-z0-9_-]{2,40}$/i.test(opts.form)) throw new Error(`Refused: invalid form slug "${opts.form}".`);
    if (opts.takeover != null && !/^\d{1,15}$/.test(String(opts.takeover))) {
      throw new Error(`Refused: takeover must be a numeric aufgabeId, got "${opts.takeover}".`);
    }
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
    // setFields posts the page back to itself; the response already is that
    // page, with ELSTER's validation messages. Jumping again would reload it
    // clean and swallow the errors.
    await this.call('setFields', values);
    const names = await this.call<string[]>('getLastSetNames');
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

  /** Uploads local PDF/XML files into an attachment group (Einspruch "Anhänge"). */
  async attach(rid: string | undefined, group: string, paths: string[]) {
    const files = paths.map(p => {
      const ext = path.extname(p).toLowerCase();
      if (!['.pdf', '.xml'].includes(ext)) throw new Error(`${p}: only .pdf and .xml are accepted`);
      const buf = fs.readFileSync(p);
      if (buf.length > 10 * 1024 * 1024) throw new Error(`${p}: larger than 10 MB`);
      return { name: path.basename(p), type: ext === '.pdf' ? 'application/pdf' : 'application/xml', b64: buf.toString('base64') };
    });
    if (rid) await this.call('jump', rid);
    const r = await this.call<any>('attach', group, files);
    return { ...r, ...(await this.groupResult(group)) };
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

  /**
   * Hands the finished form to the user for sending.
   *
   * Saves the form open in the engine, then opens a SEPARATE, VISIBLE browser
   * with its own login, opens that draft there, runs "Prüfen" and — only if it
   * is clean — clicks "Weiter" onto the "Formular absenden" page. Then the
   * puppeteer connection to that window is dropped: from here on the MCP has
   * no handle on it at all. "Absenden" is clicked by the user, never by code.
   *
   * The engine refuses further calls until that window is closed, because a
   * re-login from the engine could end the user's session mid-sending.
   */
  async handoff(aufgabeId?: number) {
    if (this.handoffOpen) throw new Error('A handoff window is already open.');

    // The draft has to be saved, or the new session cannot open it.
    const url = await this.withSession('url', p => p.evaluate(() => ((window as any).EO?.url as string) || ''));
    const saved = /\/eportal\/interpreter\//.test(url);
    if (saved) await this.save();
    const drafts = await this.drafts();
    // Saving gives the draft a new aufgabeId; the newest draft is the one just saved.
    const id = saved ? drafts[0]?.aufgabeId : (aufgabeId ?? drafts[0]?.aufgabeId);
    if (!id) throw new Error('no draft to hand off');
    if (!saved && aufgabeId && !drafts.some((d: any) => d.aufgabeId === aufgabeId)) {
      throw new Error(`draft ${aufgabeId} not found; see elster_drafts_list`);
    }

    const cfg = loadConfig();
    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: cfg.runtime.browserArgs.filter(a => !/^--(headless|window-size)/.test(a)).concat('--start-maximized'),
    });
    this.handoffOpen = true;
    const proc = browser.process();
    proc?.once('exit', () => { this.handoffOpen = false; log.info('[handoff] window closed; engine resumes'); });

    let stage = 'login';
    try {
      const page = (await browser.pages())[0] ?? await browser.newPage();
      await this.ensureLoggedIn(page);
      stage = 'open draft';
      await page.evaluate(installDriver);
      await page.evaluate((i: number) => (window as any).EO.openDraft(i), id);
      stage = 'check';
      const check = await page.evaluate(() => (window as any).EO.check());
      // Render the server's current state natively so the page is live and
      // ELSTER's own scripts (which sign on "Absenden") are loaded.
      const at = await page.evaluate(() => (window as any).EO.url as string);
      await page.goto(at, { waitUntil: 'networkidle2', timeout: 60000 });
      if (!check.ok) {
        return this.detach(browser, { ok: false, aufgabeId: id, url: page.url(), errors: check.panel,
          note: 'Prüfung has errors. The window shows them; fix them there or close it and fix via the engine.' });
      }
      stage = 'Weiter';
      // The exact command a human's "Weiter" posts after a clean Prüfung.
      const REVIEW = JSON.stringify({ SwitchModus: { ignoreSkippableErrors: false, target: 'SENDEN', force: false } });
      const found = await page.evaluate((cmd: string) =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('button[name="reqCmd"]')).some(b => {
          try { return JSON.stringify(JSON.parse(b.value)) === cmd; } catch { return false; }
        }), REVIEW);
      if (found) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
          page.evaluate((cmd: string) => {
            Array.from(document.querySelectorAll<HTMLButtonElement>('button[name="reqCmd"]')).find(b => {
              try { return JSON.stringify(JSON.parse(b.value)) === cmd; } catch { return false; }
            })!.click();
          }, REVIEW),
        ]);
      }
      const onSendPage = /\/versenden\//.test(page.url());
      return this.detach(browser, {
        ok: onSendPage, aufgabeId: id, url: page.url(), result: check.result,
        note: onSendPage
          ? 'The window shows "Formular absenden". Nothing has been sent. The user reviews it and clicks '
            + '"Absenden" themselves, then closes the window; the engine is paused until then.'
          : 'Prüfung is clean but the window did not reach "Formular absenden"; the user clicks "Weiter" there.',
      });
    } catch (e) {
      // Leave the window to the user either way; never close their session.
      await this.detach(browser, null);
      throw new Error(`handoff failed at ${stage}: ${(e as Error).message}. The window stays open.`);
    }
  }

  /** Drops the puppeteer connection; the window stays open for the user. */
  private async detach<T>(browser: import('puppeteer').Browser, result: T): Promise<T> {
    await browser.disconnect().catch(() => {});
    return result;
  }
}
