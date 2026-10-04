import puppeteer, { Browser, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';
import { PORTAL_URLS } from './constants.js';
import {
  TakeoverChoice,
  TakeoverCandidate,
  isDatenuebernahmePage,
  listTakeoverCandidates,
  pickCandidate,
  clickTakeover,
  continueWithoutTakeover,
  formatCandidates,
} from './datenuebernahme.js';

export class ElsterBase {
  protected browser: Browser | null = null;
  protected page: Page | null = null;

  protected async initBrowser(): Promise<{ browser: Browser; page: Page }> {
    const cfg = loadConfig();
    this.browser = await puppeteer.launch({
      headless: cfg.runtime.headless,
      args: cfg.runtime.browserArgs,
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 1024 });

    const downloadDir = path.resolve(cfg.runtime.downloadDir);
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    const client = await this.page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });

    const browserClient = await this.browser.target().createCDPSession();
    await browserClient.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    return { browser: this.browser, page: this.page };
  }

  protected async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  protected screenshotPath(name: string): string {
    const cfg = loadConfig();
    const dir = path.resolve(cfg.runtime.screenshotDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${name}.png`);
  }

  protected async screenshot(page: Page, name: string): Promise<string> {
    const file = this.screenshotPath(name);
    try { await page.screenshot({ path: file, fullPage: true }); } catch { /* best effort */ }
    return file;
  }

  protected async ensureLoggedIn(page: Page): Promise<boolean> {
    const cfg = loadConfig();
    if (!cfg.auth.pfxPath) throw new Error('ELSTER_PFX_PATH not configured.');
    if (!fs.existsSync(cfg.auth.pfxPath)) {
      throw new Error(`ELSTER certificate not found at: ${cfg.auth.pfxPath}`);
    }

    // Straight to the certificate login. Going via the start page, its login
    // link and a "Zertifikat" method link that no longer exists cost ~12 s of
    // networkidle waits and a 10 s selector timeout on every login.
    log.info('Opening certificate login...');
    await page.goto(PORTAL_URLS.loginCert, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const isLoggedIn = (u: string) => u.includes('mein-elster/startseite') || u.includes('eportal/mein-elster')
      || u.includes('eportal/meinelster');
    if (isLoggedIn(page.url())) {
      log.info('Already logged in.');
      return true;
    }

    const uploadSelector = 'input[type="file"], #loginZertifikat-dateiauswahl';
    await page.waitForSelector(uploadSelector, { timeout: 20000 });
    const uploadInput = await page.$(uploadSelector);
    if (!uploadInput) throw new Error('Certificate upload field not found.');
    // @ts-expect-error - puppeteer's typing on $() returns generic ElementHandle
    await uploadInput.uploadFile(cfg.auth.pfxPath);
    log.info('Certificate selected.');

    // Selecting the certificate makes ELSTER re-render the login box, which
    // wipes anything already typed into the password field. Instead of a fixed
    // wait: type, give the re-render a moment, and retype until the value
    // sticks. A silently emptied field would only surface as "Passwort enthält
    // weniger als 6 Zeichen" after the submit.
    const passSelector = '#password, input[type="password"], input[id*="passwort"]';
    await page.waitForSelector(passSelector, { timeout: 10000 });

    let typed = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 1 ? 400 : 600));
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el) { el.value = ''; el.focus(); }
      }, passSelector);
      await page.type(passSelector, cfg.auth.password);
      await new Promise(r => setTimeout(r, 400));
      typed = await page.evaluate(
        (sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value.length ?? 0,
        passSelector);
      if (typed === cfg.auth.password.length) break;
      log.warn(`Password field held ${typed} of ${cfg.auth.password.length} characters, retrying (${attempt}/6).`);
    }
    if (typed !== cfg.auth.password.length) {
      throw new Error('Password field would not accept the full password.');
    }

    log.info('Submitting login...');
    // Never select by `button[type=submit]` alone: ELSTER renders the header's
    // chat, search and contrast icons as submit buttons too, so the first match
    // in document order is #chatLinkHeader — clicking it reloads the page and
    // silently discards the uploaded certificate.
    const submitSelector = '#bestaetigenButton, #loginZertifikat-login';
    let loginBtn = await page.$(submitSelector);
    if (!loginBtn) {
      const handle = await page.evaluateHandle(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(b => (b.textContent || '').trim() === 'Login'
          && (b as HTMLElement).offsetParent !== null) || null;
      });
      loginBtn = handle.asElement() as any;
    }
    if (!loginBtn) throw new Error('Login button not found.');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      loginBtn.click(),
    ]);

    const finalUrl = page.url();
    if (isLoggedIn(finalUrl)) {
      log.info('Login successful.');
      return true;
    }
    // After a session that ended without "Abmelden", ELSTER lands on an
    // interstitial asking whether to keep the auto-saved form state. The login
    // itself succeeded. Declining keeps the last explicitly saved draft as is.
    if (finalUrl.includes('eportal/temporaereaufgaben')) {
      log.info('Login successful; declining auto-saved form recovery.');
      await page.evaluate(() =>
        (document.getElementById('temporaereaufgaben_nein_button') as HTMLElement | null)?.click());
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return true;
    }

    const errorText = await page.evaluate(() => {
      const err = document.querySelector('.alert-danger, .error-message, .feedback--error');
      return err ? err.textContent?.trim() : null;
    });
    if (errorText) throw new Error(`ELSTER login error: ${errorText}`);
    // A silent `false` used to strand callers on the login page while they
    // reported success, so state the failure with the page we ended up on.
    throw new Error(`ELSTER login did not reach Mein ELSTER; still at ${finalUrl}`);
  }

  /**
   * Selects a tax year on a form's entry page and clicks "Weiter" (#Enter).
   *
   * Option values are not uniformly `<year>-v1` — older ESt years use
   * `<year>-v_<year>` — so match on the `<year>-` prefix instead of guessing.
   */
  protected async selectFormYear(page: Page, year: number): Promise<void> {
    await page.waitForSelector('#zeitraumJahr', { timeout: 15000 });

    const value = await page.evaluate((y) => {
      const sel = document.querySelector('#zeitraumJahr') as HTMLSelectElement | null;
      if (!sel) return null;
      const opt = Array.from(sel.options).find(o => o.value.startsWith(`${y}-`))
        ?? Array.from(sel.options).find(o => o.value.includes(String(y)));
      return opt ? opt.value : null;
    }, year);

    if (!value) throw new Error(`Tax year ${year} is not offered on this form.`);
    await page.select('#zeitraumJahr', value);

    const enter = await page.$('#Enter');
    if (!enter) throw new Error('Form start button (#Enter) not found.');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      enter.click(),
    ]);
    await new Promise(r => setTimeout(r, 3000));
  }

  /**
   * Handles the "Datenübernahme" interstitial that ELSTER shows after the year
   * has been picked. Returns the candidate that was carried over, or null when
   * the flow continued without a takeover (including when the page never
   * appeared at all).
   *
   * Throws when `choice` names a submission ELSTER does not offer — see
   * pickCandidate().
   */
  protected async handleDatenuebernahme(
    page: Page,
    choice: TakeoverChoice,
    logMsg: (m: string) => void = log.info,
  ): Promise<TakeoverCandidate | null> {
    if (!await isDatenuebernahmePage(page)) return null;

    const candidates = await listTakeoverCandidates(page);
    logMsg(`Datenübernahme page: ${formatCandidates(candidates)}`);

    // Throws on an unmet explicit request, before anything is clicked.
    const picked = pickCandidate(candidates, choice);

    if (picked) {
      logMsg(`Taking over "${picked.description}" (aufgabeId ${picked.aufgabeId})...`);
      if (!await clickTakeover(page, picked.aufgabeId)) {
        throw new Error(`"Übernehmen" button for aufgabeId ${picked.aufgabeId} could not be clicked.`);
      }
    } else {
      logMsg('Continuing without Datenübernahme.');
      if (!await continueWithoutTakeover(page)) {
        log.warn('"Ohne Datenübernahme fortfahren" button not found.');
      }
    }

    await new Promise(r => setTimeout(r, 3000));
    await this.handleModals(page);

    if (await isDatenuebernahmePage(page)) {
      log.warn('Still on the Datenübernahme page after clicking — ELSTER may have rejected the choice.');
    }
    return picked;
  }

  /**
   * Generic modal handler — declines session-resume prompts and similar dialogs.
   */
  protected async handleModals(page: Page): Promise<void> {
    try {
      const result = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, .btn'));
        const body = document.body.innerText;

        // ELSTER logs out after ~30 min idle and warns first. Automated runs
        // sit still between steps, so the warning fires on long flows and
        // blocks everything underneath. Always extend rather than dismiss.
        if (body.includes('Ihre Sitzung läuft ab') || body.includes('Automatisches Logout')) {
          const extend = document.querySelector('#extendSessionButton') as HTMLElement | null;
          if (extend && extend.offsetParent !== null) { extend.click(); return 'session extended'; }
          const btn = btns.find(b => /Sitzung fortsetzen/i.test(b.textContent || '')
            && (b as HTMLElement).offsetParent !== null);
          if (btn) { (btn as HTMLElement).click(); return 'session extended'; }
        }

        if (body.includes('Eingabefehler gefunden') || body.includes('In einem Feld ist ein Eingabefehler')) {
          const btn = btns.find(b => b.textContent?.trim().includes('Zum Fehler'));
          if (btn) { (btn as HTMLElement).click(); return 'input-error modal closed'; }
        }

        // Shown on the form's Startseite right after a Datenübernahme. It is a
        // plain overlay with no outcome attached, but it swallows every click
        // underneath, so the page walk stalls until it is dismissed.
        if (body.includes('Das Formular ist jetzt vorausgefüllt')
            || (body.includes('Willkommen!') && body.includes('früheren Abgabe'))) {
          const btn = btns.find(b => {
            const t = (b.textContent || '').trim();
            return (t === 'Schließen' || t === 'Weiter') && (b as HTMLElement).offsetParent !== null;
          });
          if (btn) { (btn as HTMLElement).click(); return 'Datenübernahme welcome modal closed'; }
        }

        if (body.includes('Wiederaufnahme') || body.includes('wiederaufnehmen') ||
            body.includes('gespeicherten Stand') || body.includes('vorherigen Eingaben') ||
            body.includes('automatische Wiederherstellung') || body.includes('letzten Stand der Bearbeitung')) {
          const nein = btns.find(b => b.textContent?.trim() === 'Nein');
          if (nein) { (nein as HTMLElement).click(); return 'resume rejected'; }
        }

        if (body.includes('Möchten Sie das Formular verlassen') || body.includes('Temporäre Aufgaben')) {
          const cancel = btns.find(b => {
            const t = (b.textContent || '').toLowerCase();
            return t.includes('nein') || t.includes('abbrechen') || t.includes('bleiben');
          });
          if (cancel) { (cancel as HTMLElement).click(); return 'leave-form modal cancelled'; }
        }

        return null;
      });
      if (result) log.info(`Modal handled: ${result}`);
    } catch { /* swallow */ }
  }
}
