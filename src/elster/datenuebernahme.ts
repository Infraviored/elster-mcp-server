import { Page } from 'puppeteer';
import { log } from '../logger.js';

/**
 * ELSTER "Datenübernahme" — carrying data over from an earlier submission.
 *
 * After picking a year on a form's entry page, ELSTER interposes a page at
 * /eportal/interpreter/fruehereAbgaben/<formSlug>-<year> offering two tabs:
 * "Frühere Abgaben" (a table of earlier submissions of the same form type) and
 * "XML-Import". Each table row carries a button
 *
 *   <button id="uebernehmenButton_<aufgabeId>" name="reqCmd"
 *           value='{"FruehereAbgabeCommand":{"aufgabeId":"...","onErrorUrl":null,
 *                   "ignoreSkippableErrors":true}}'>Übernehmen</button>
 *
 * and the page as a whole offers #Continue ("Ohne Datenübernahme fortfahren").
 * When no earlier submission matches, the table is replaced by a
 * ._helper-infoEmpty notice and only #Continue remains.
 *
 * Only the "Frühere Abgaben" tab is handled here; XML-Import is not automated.
 */

export interface TakeoverCandidate {
  aufgabeId: string;
  /** e.g. "ESt unbeschränkt (ESt 1 A) 2024, Max Mustermann" */
  description: string;
  /** ELSTER's own reference for the earlier submission, e.g. "9131YNFL31RI4" */
  ordnungskriterium: string;
  /** e.g. "31.07.2025 23:32 Uhr" */
  sentAt: string;
  profil: string;
  /** Tax year parsed out of `description`, when one is recognisable. */
  year: number | null;
  /** `sentAt` as an epoch ms timestamp, or null if unparsable. */
  sentAtTs: number | null;
}

export type TakeoverChoice =
  | { mode: 'none' }
  | { mode: 'latest' }
  | { mode: 'year'; year: number }
  | { mode: 'aufgabeId'; aufgabeId: string };

export const NO_TAKEOVER: TakeoverChoice = { mode: 'none' };

function isYear(n: number): boolean {
  return n >= 1990 && n <= 2099;
}

/** "31.07.2025 23:32 Uhr" → epoch ms (local time), or null. */
function parseGermanDateTime(s: string): number | null {
  const m = s.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi] = m;
  const t = new Date(
    parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10),
    hh ? parseInt(hh, 10) : 0, mi ? parseInt(mi, 10) : 0,
  ).getTime();
  return Number.isNaN(t) ? null : t;
}

function parseYearFromDescription(desc: string): number | null {
  for (const m of desc.matchAll(/\b(\d{4})\b/g)) {
    const n = parseInt(m[1], 10);
    if (isYear(n)) return n;
  }
  return null;
}

/** True when the browser currently sits on a Datenübernahme page. */
export async function isDatenuebernahmePage(page: Page): Promise<boolean> {
  if (page.url().includes('/fruehereAbgaben/')) return true;
  return page.evaluate(() => {
    if (document.title.includes('Datenübernahme')) return true;
    const btn = document.querySelector('#Continue');
    return !!btn && (btn.textContent || '').includes('Ohne Datenübernahme');
  }).catch(() => false);
}

/**
 * Reads the "Frühere Abgaben" table. Returns [] when ELSTER has nothing to
 * offer (empty-state notice) — that is a normal situation, not an error.
 */
export async function listTakeoverCandidates(page: Page): Promise<TakeoverCandidate[]> {
  const raw = await page.evaluate(() => {
    // Column order: Bezeichnung des Formulars | Ordnungskriterium | Gesendet am | Profil | Aktionen.
    // Each <td> is prefixed by a .table-collapse__cellTitle span holding the
    // responsive column label, which has to be stripped off the cell text.
    const cellText = (td: Element): string => {
      const clone = td.cloneNode(true) as Element;
      clone.querySelectorAll('.table-collapse__cellTitle, button').forEach(n => n.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    };

    return Array.from(document.querySelectorAll('button[id^="uebernehmenButton_"]')).map(btn => {
      const aufgabeId = btn.id.replace('uebernehmenButton_', '');
      const row = btn.closest('tr');
      const cells = row ? Array.from(row.querySelectorAll('td')).map(cellText) : [];
      return {
        aufgabeId,
        description: cells[0] || '',
        ordnungskriterium: cells[1] || '',
        sentAt: cells[2] || '',
        profil: cells[3] || '',
      };
    });
  }).catch(() => [] as Array<Record<string, string>>);

  return raw.map(r => ({
    aufgabeId: r.aufgabeId,
    description: r.description,
    ordnungskriterium: r.ordnungskriterium,
    sentAt: r.sentAt,
    profil: r.profil,
    year: parseYearFromDescription(r.description),
    sentAtTs: parseGermanDateTime(r.sentAt),
  }));
}

/**
 * Resolves a choice against the offered candidates.
 *
 * Throws when the caller explicitly asked for a takeover that is not on offer.
 * Silently filling an empty form after the user asked to carry last year's data
 * over would produce a wrong return, so an unmet request must fail loudly.
 */
export function pickCandidate(
  candidates: TakeoverCandidate[],
  choice: TakeoverChoice,
): TakeoverCandidate | null {
  if (choice.mode === 'none') return null;

  const describe = () => candidates.length
    ? candidates.map(c => `${c.aufgabeId} (${c.description})`).join('; ')
    : 'none offered';

  switch (choice.mode) {
    case 'latest': {
      if (candidates.length === 0) {
        throw new Error('takeover="latest" requested but ELSTER offers no earlier submission for this form.');
      }
      // The table defaults to AENDERUNGSDATUM DESCENDING, but sort explicitly
      // rather than trusting the rendered order.
      const dated = candidates.filter(c => c.sentAtTs != null);
      if (dated.length === 0) return candidates[0];
      return dated.reduce((a, b) => (b.sentAtTs! > a.sentAtTs! ? b : a));
    }
    case 'year': {
      const hits = candidates.filter(c => c.year === choice.year);
      if (hits.length === 0) {
        throw new Error(
          `takeover=${choice.year} requested but no earlier submission for that year is offered. Available: ${describe()}.`,
        );
      }
      // Several per year is normal (UStVA months/quarters, ESt original plus
      // correction). Picking one would carry over the wrong period's values.
      if (hits.length > 1) {
        throw new Error(
          `takeover=${choice.year} is ambiguous: ${hits.length} submissions for that year. `
          + `Pass the aufgabeId instead: ${hits.map(c => `${c.aufgabeId} (${c.description})`).join('; ')}.`,
        );
      }
      return hits[0];
    }
    case 'aufgabeId': {
      const hit = candidates.find(c => c.aufgabeId === choice.aufgabeId);
      if (!hit) {
        throw new Error(
          `takeover aufgabeId "${choice.aufgabeId}" is not offered. Available: ${describe()}.`,
        );
      }
      return hit;
    }
  }
}

async function clickAndWait(page: Page, selector: string): Promise<boolean> {
  const handle = await page.$(selector).catch(() => null);
  if (!handle) return false;
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
    handle.click(),
  ]);
  return true;
}

/** Clicks the "Übernehmen" button of one row. */
export async function clickTakeover(page: Page, aufgabeId: string): Promise<boolean> {
  const ok = await clickAndWait(page, `#uebernehmenButton_${CSS_escape(aufgabeId)}`);
  if (ok) return true;

  // Fallback: match on the reqCmd payload rather than the element id.
  return page.evaluate((id) => {
    const btns = Array.from(document.querySelectorAll('button[name="reqCmd"]'));
    const btn = btns.find(b => (b as HTMLButtonElement).value.includes(`"aufgabeId":"${id}"`));
    if (!btn) return false;
    (btn as HTMLButtonElement).click();
    return true;
  }, aufgabeId).catch(() => false);
}

/** ids here are always numeric, but keep selector construction honest. */
function CSS_escape(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '');
}

/** Clicks "Ohne Datenübernahme fortfahren". */
export async function continueWithoutTakeover(page: Page): Promise<boolean> {
  const ok = await clickAndWait(page, '#Continue');
  if (ok) return true;

  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
    const btn = btns.find(b => {
      const txt = b.textContent?.trim() || (b as HTMLInputElement).value || '';
      return txt.includes('Ohne Datenübernahme') || txt.includes('ohne Datenübernahme');
    });
    if (!btn) return false;
    (btn as HTMLElement).click();
    return true;
  }).catch(() => false);
}

export function formatCandidates(candidates: TakeoverCandidate[]): string {
  if (candidates.length === 0) return 'no earlier submissions offered';
  return candidates
    .map(c => `${c.aufgabeId}: ${c.description} (sent ${c.sentAt})`)
    .join(' | ');
}

