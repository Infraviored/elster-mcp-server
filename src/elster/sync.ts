import { Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { ElsterBase } from './base.js';
import { log } from '../logger.js';
import { loadConfig } from '../config.js';
import { PORTAL_URLS } from './constants.js';

export interface HistoryItem {
  date: string;
  type: string;
  year: number;
  month: number;
  description: string;
  elsterId: string;
  pdfPath?: string;
}

export interface InboxMessage {
  id: string;
  elsterId: string;
  subject: string;
  /** Date shown in the inbox, as YYYY-MM-DD. */
  date: string;
  read: boolean;
  pdfPath?: string;
  /** Downloaded attachments (the actual Bescheid PDFs), one folder per message. */
  attachments?: string[];
}

export class ElsterSync extends ElsterBase {

  /**
   * Lists "Übermittelte Formulare" (submitted-form history) from the ELSTER portal.
   * Optionally downloads PDFs.
   */
  async syncHistory(opts: { years?: number[]; downloadPdfs?: boolean } = {}): Promise<HistoryItem[]> {
    const years = opts.years ?? [new Date().getFullYear(), new Date().getFullYear() - 1];
    log.info('Syncing ELSTER history...');
    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await this.handleModals(page);

      await page.evaluate(() => {
        const a = document.createElement('a');
        a.href = '/eportal/meineformulare';
        a.id = 'temp_history_link';
        document.body.appendChild(a);
        a.click();
      });
      await new Promise(r => setTimeout(r, 4000));
      await this.handleModals(page);

      const tabClicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button, span'));
        const target = links.find(l => {
          const t = l.textContent?.trim().toLowerCase() || '';
          return t.includes('übermittelte') && t.includes('formulare');
        }) as HTMLElement;
        if (target) { target.click(); return true; }
        return false;
      });
      if (tabClicked) await new Promise(r => setTimeout(r, 3000));
      else {
        await page.goto(`${PORTAL_URLS.meineFormulare}#meineFormulare-uebermittelt`,
          { waitUntil: 'networkidle2' }).catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
      }

      await this.handleModals(page);
      try {
        await page.waitForSelector('table, .list-row, .table-row, [id*="Table"]', { timeout: 15000 });
      } catch { log.warn('No table found.'); }

      const all: HistoryItem[] = [];
      const initial = await this.extractHistoryItems(page);
      all.push(...initial);

      for (const y of years) {
        const filtered = await page.evaluate((year) => {
          const selects = Array.from(document.querySelectorAll('select'));
          const yearSelect = selects.find(s => (s.textContent?.toLowerCase() || '').includes(year.toString())) as HTMLSelectElement;
          if (yearSelect) {
            const option = Array.from(yearSelect.options).find(o => o.text.includes(year.toString()));
            if (option) {
              yearSelect.value = option.value;
              yearSelect.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }, y);
        if (filtered) {
          await new Promise(r => setTimeout(r, 4000));
          const items = await this.extractHistoryItems(page);
          all.push(...items);
        }
      }

      const unique = Array.from(
        new Map(all.map(i => [i.elsterId || `${i.type}_${i.date}`, i])).values(),
      );

      if (opts.downloadPdfs) {
        const cfg = loadConfig();
        const dir = path.resolve(cfg.runtime.downloadDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        for (const item of unique) {
          if (!item.elsterId) continue;
          const pdf = await this.downloadHistoryPdf(page, item, dir).catch(() => null);
          if (pdf) item.pdfPath = pdf;
        }
      }

      return unique;
    } finally {
      await this.closeBrowser();
    }
  }

  /**
   * Lists messages in the ELSTER inbox ("Posteingang") and optionally downloads PDFs.
   * Each message returned can be looked up later by its `elsterId`.
   */
  async syncInbox(opts: {
    downloadPdfs?: boolean;
    downloadAttachments?: boolean;
    elsterIds?: string[];
    maxPages?: number;
  } = {}): Promise<InboxMessage[]> {
    const maxPages = opts.maxPages ?? 20;
    log.info('Syncing ELSTER inbox...');
    const { page } = await this.initBrowser();
    try {
      await this.ensureLoggedIn(page);
      await this.handleModals(page);

      const cfg = loadConfig();
      const downloadDir = path.resolve(cfg.runtime.downloadDir);
      if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

      await page.goto(PORTAL_URLS.posteingang, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await this.handleModals(page);

      const collected: InboxMessage[] = [];
      let pageNum = 0;
      while (pageNum < maxPages) {
        pageNum++;
        await new Promise(r => setTimeout(r, 1500));
        const messages = await this.extractInboxMessages(page);
        if (messages.length === 0) break;

        for (const msg of messages) {
          if (opts.elsterIds?.length && !opts.elsterIds.includes(msg.elsterId)) continue;
          if (opts.downloadPdfs || opts.downloadAttachments) {
            try {
              if (await this.openInboxMessage(page, msg)) {
                if (opts.downloadPdfs) {
                  const pdf = await this.saveInboxMessagePdf(page, msg, downloadDir);
                  if (pdf) msg.pdfPath = pdf;
                }
                if (opts.downloadAttachments) {
                  msg.attachments = await this.downloadInboxAttachments(page, msg, downloadDir);
                }
                await this.closeInboxMessage(page);
              }
            } catch (e: any) {
              log.warn(`Failed to download ${msg.elsterId}: ${e.message}`);
            }
          }
          collected.push(msg);
        }
        if (opts.elsterIds?.length && opts.elsterIds.every(id => collected.some(m => m.elsterId === id))) break;

        const firstIdBefore = messages[0]?.id || '';
        const pageBtnClicked = await page.evaluate(() => {
          const btn = document.getElementById('MeinPosteingangTable_pagination_next_page') as HTMLButtonElement;
          if (btn && !btn.disabled && btn.offsetParent !== null) { btn.click(); return true; }
          return false;
        });
        if (!pageBtnClicked) break;

        let advanced = false;
        for (let w = 0; w < 5; w++) {
          await new Promise(r => setTimeout(r, 1000));
          const newFirstId = await page.evaluate(() => document.querySelector('[id^="viewNachricht"]')?.id || '');
          if (newFirstId && newFirstId !== firstIdBefore) { advanced = true; break; }
        }
        if (!advanced) break;
      }

      return collected;
    } finally {
      await this.closeBrowser();
    }
  }

  private async extractHistoryItems(page: Page): Promise<HistoryItem[]> {
    return page.evaluate(() => {
      const results: any[] = [];
      const TYPE_MAP: [string, string][] = [
        ['Umsatzsteuer-Voranmeldung', 'USTVA'], ['UStVA', 'USTVA'],
        ['ESt', 'EST'], ['Einkommensteuer', 'EST'],
        ['Körperschaftsteuer', 'KST'], ['EÜR', 'EÜR'],
        ['Einnahmenüberschussrechnung', 'EÜR'],
        ['Gewerbesteuer', 'GEW'], ['Lohnsteuer', 'LST'],
        ['Bescheid', 'BESCHEID'],
      ];
      const detectType = (t: string) => {
        for (const [k, v] of TYPE_MAP) if (t.includes(k)) return v;
        return 'OTHER';
      };
      const detectYear = (t: string, fallback: number) => {
        const m = t.match(/\b(20\d{2})\b/);
        return m ? parseInt(m[1]) : fallback;
      };
      const detectMonth = (t: string): number => {
        if (t.match(/\bIV\.\s*Kalendervierteljahr/)) return 12;
        if (t.match(/\bIII\.\s*Kalendervierteljahr/)) return 9;
        if (t.match(/\bII\.\s*Kalendervierteljahr/)) return 6;
        if (t.match(/\bI\.\s*Kalendervierteljahr/)) return 3;
        const q = t.match(/([1-4])\.\s*Quartal|Q([1-4])/i);
        if (q) return parseInt(q[1] || q[2]) * 3;
        const months: Record<string, number> = {
          Januar: 1, Februar: 2, 'März': 3, April: 4, Mai: 5, Juni: 6,
          Juli: 7, August: 8, September: 9, Oktober: 10, November: 11, Dezember: 12,
        };
        for (const [name, num] of Object.entries(months)) if (t.includes(name)) return num;
        return 0;
      };

      const rows = Array.from(document.querySelectorAll('table tr, .list-row, .table-row, [role="row"], .list-group-item'));
      for (const row of rows) {
        if (row.closest('thead') || row.closest('th') || (row as HTMLElement).offsetParent === null) continue;
        const btn = row.querySelector('[id^="showActions_"],[id^="showUebermitteltesFormular_"],[id^="viewNachricht"], button, a') as HTMLElement;
        const tds = Array.from(row.querySelectorAll('td, .cell, [role="gridcell"]'))
          .map(c => (c.textContent || '').trim().replace(/\s+/g, ' '));
        const full = tds.join(' ');
        if (full.length < 5) continue;
        const dateMatch = full.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        const date = dateMatch ? new Date(+dateMatch[3], +dateMatch[2] - 1, +dateMatch[1]) : new Date();
        const finalBtn = btn || row.querySelector('a, button') as HTMLElement;
        if (!finalBtn) continue;

        results.push({
          date: date.toISOString(),
          type: detectType(full),
          year: detectYear(full, date.getFullYear()),
          month: detectMonth(full),
          description: tds.slice(0, 6).join(' | ').substring(0, 250),
          elsterId: (finalBtn.id || '').replace(/\D/g, '') || date.getTime().toString(),
        });
      }
      return results;
    });
  }

  private async extractInboxMessages(page: Page): Promise<InboxMessage[]> {
    return page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      return rows.map(row => {
        if (row.closest('thead') || row.closest('th')) return null;
        const viewBtn = row.querySelector('[id^="viewNachricht"],[onclick*="viewNachricht"]') as HTMLElement;
        if (!viewBtn) return null;
        let btnId = viewBtn.id;
        if (!btnId) {
          const m = viewBtn.getAttribute('onclick')?.match(/viewNachricht\('(\d+)'\)/);
          if (m) btnId = 'viewNachricht' + m[1];
        }
        if (!btnId) return null;
        // The button text starts with the read state ("gelesen"/"ungelesen").
        const raw = ((viewBtn.querySelector('.interactive-icon__text') || viewBtn || row).textContent || '')
          .replace(/\s+/g, ' ').trim();
        const state = raw.match(/^(ungelesen|gelesen)\s*/i);
        const subject = (state ? raw.slice(state[0].length) : raw) || 'No subject';
        const dateTd = Array.from(row.querySelectorAll('td')).find(td => /\d{2}\.\d{2}\.\d{4}/.test(td.textContent || ''));
        const m = dateTd?.textContent?.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        // Kept as the calendar date ELSTER shows; toISOString() of a local
        // midnight would shift it to the previous day.
        const date = m ? `${m[3]}-${m[2]}-${m[1]}` : '';
        return {
          id: btnId,
          elsterId: btnId.replace(/\D/g, ''),
          subject,
          date,
          read: !state || state[1].toLowerCase() === 'gelesen',
        };
      }).filter((m): m is InboxMessage => m !== null);
    });
  }

  private async downloadHistoryPdf(page: Page, item: HistoryItem, downloadDir: string): Promise<string | null> {
    try {
      const fileName = `elster_hist_${item.elsterId || Date.now()}.pdf`;
      const fullPath = path.join(downloadDir, fileName);

      const actionClicked = await page.evaluate((id: string) => {
        let btn = document.getElementById(id) as HTMLElement;
        if (!btn) {
          const rows = Array.from(document.querySelectorAll('table tr'));
          const row = rows.find(r => r.textContent?.includes(id));
          if (row) btn = row.querySelector('[id^="showActions_"], button, a') as HTMLElement;
        }
        if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
        return false;
      }, item.elsterId);
      if (!actionClicked) return null;
      await new Promise(r => setTimeout(r, 1500));

      const viewClicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button, .interactive'));
        const target = links.find(l => {
          const t = l.textContent?.trim().toLowerCase() || '';
          return t.includes('anzeigen') || t.includes('nachricht') || t.includes('formular');
        }) as HTMLElement;
        if (target) { target.click(); return true; }
        return false;
      });
      if (!viewClicked) return null;
      await new Promise(r => setTimeout(r, 4000));
      await this.handleModals(page);

      await page.evaluate(() => {
        const modal = document.querySelector('.modal-content, .detail-view');
        if (modal) {
          const style = document.createElement('style');
          style.id = 'pdf-clean-style';
          style.innerHTML = `body > *:not(.modal):not(.modal-backdrop):not(.detail-view){display:none!important}.modal{position:static!important;display:block!important;opacity:1!important}.modal-backdrop{display:none!important}.modal-dialog{margin:0!important;max-width:none!important;width:100%!important}.modal-content{border:none!important;box-shadow:none!important}.modal-header,.modal-footer,.no-print{display:none!important}`;
          document.head.appendChild(style);
        }
      });
      await page.pdf({ path: fullPath, format: 'A4', printBackground: true });
      await page.evaluate(() => { document.getElementById('pdf-clean-style')?.remove(); });

      return fullPath;
    } catch {
      return null;
    }
  }

  /** Opens a message's modal in the inbox list. False if it did not render. */
  private async openInboxMessage(page: Page, msg: InboxMessage): Promise<boolean> {
    const exists = await page.evaluate((id) => !!document.getElementById(id), msg.id);
    if (!exists) return false;
    await page.evaluate((id) => document.getElementById(id)!.scrollIntoView({ block: 'center' }), msg.id);
    await page.click(`#${msg.id}`).catch(() => {});
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const ready = await page.evaluate(() => {
        const b = document.querySelector<HTMLElement>('.modal--openOnLoad');
        return !!b && b.getBoundingClientRect().height > 0 && (b.textContent?.trim()?.length || 0) > 150;
      });
      if (ready) return true;
    }
    return false;
  }

  private async closeInboxMessage(page: Page): Promise<void> {
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise(r => setTimeout(r, 800));
  }

  /** Prints the open message's text (not its attachments) to a PDF. */
  private async saveInboxMessagePdf(page: Page, msg: InboxMessage, downloadDir: string): Promise<string | null> {
    const safe = msg.subject.replace(/[^a-zA-Z0-9äöüÄÖÜ_-]/g, '_').substring(0, 60);
    const fullPath = path.join(downloadDir, `elster_inbox_${msg.elsterId}_${safe}.pdf`);
    const wrapper = await page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('.modal--openOnLoad');
      const w = b?.querySelector<HTMLElement>('.modal__wrapper') || b;
      if (!w || (w.textContent?.trim()?.length || 0) < 100) return '';
      return w.innerHTML || '';
    });
    if (!wrapper) return null;

    const title = (msg.subject || 'ELSTER Nachricht').replace(/[<>]/g, '');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Arial,sans-serif;padding:30px;font-size:14px;line-height:1.6}
h1{font-size:20px;border-bottom:2px solid #333;padding-bottom:10px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px}
button,.btn{display:none!important}</style></head><body>
<h1>${title}</h1>
<p style="color:#666;font-size:12px">Datum: ${msg.date}</p>
${wrapper}</body></html>`;

    const newPage = await page.browser().newPage();
    try {
      await newPage.setContent(html, { waitUntil: 'networkidle0' });
      await newPage.pdf({
        path: fullPath, format: 'A4', printBackground: false,
        margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
      });
    } finally { await newPage.close(); }
    return fs.existsSync(fullPath) && fs.statSync(fullPath).size > 500 ? fullPath : null;
  }

  /**
   * Downloads the attachments of the open message — for a Bescheid, the
   * Bescheid itself; the message text only says one is attached.
   *
   * Each attachment is a button `<name>AnhangHerunterladen` carrying
   * `DecryptModalCommand{nachrichtId, dokumentId}`. The file arrives
   * encrypted; ELSTER's own page script decrypts it via /eportal/rpc with the
   * logged-in certificate and then triggers a browser download. So the button
   * is clicked in the real page and the file is picked up from disk.
   */
  private async downloadInboxAttachments(page: Page, msg: InboxMessage, downloadDir: string): Promise<string[]> {
    const dir = path.join(downloadDir, 'inbox', msg.elsterId);
    fs.mkdirSync(dir, { recursive: true });
    const cdp = await page.browser().target().createCDPSession();
    // 'allow' keeps ELSTER's file name; initBrowser's 'allowAndName' would store a GUID.
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });

    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.modal--openOnLoad [id$="AnhangHerunterladen"]'))
        .map(b => b.id));
    const saved: string[] = [];
    for (const id of buttons) {
      const before = new Set(fs.readdirSync(dir));
      await page.evaluate((i) => document.getElementById(i)?.click(), id);
      const file = await this.waitForNewFile(dir, before, 45000);
      if (file) saved.push(file);
      else log.warn(`Attachment ${id} of message ${msg.elsterId} did not arrive`);
    }
    await cdp.detach().catch(() => {});
    return saved;
  }

  /** Waits for a finished download (no .crdownload, size stable) not in `before`. */
  private async waitForNewFile(dir: string, before: Set<string>, timeoutMs: number): Promise<string | null> {
    let last = -1;
    for (let t = 0; t < timeoutMs; t += 500) {
      await new Promise(r => setTimeout(r, 500));
      const fresh = fs.readdirSync(dir).filter(f => !before.has(f));
      if (!fresh.length || fresh.some(f => f.endsWith('.crdownload'))) continue;
      const full = path.join(dir, fresh[0]);
      const size = fs.statSync(full).size;
      if (size > 0 && size === last) return full;
      last = size;
    }
    return null;
  }
}
