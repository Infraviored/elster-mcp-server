import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Page } from 'puppeteer';

/**
 * "Meine Belege" — ELSTER's receipt store, a JSON REST API under
 * /eportal/biber/v2 (reverse-engineered 27.09.2026 from the portal's own
 * OpenAPI client in /eportal/scripts/amsel-lib.js and a captured upload).
 *
 * One receipt is ONE request, no separate file upload:
 *
 *   POST /eportal/biber/v2/belege      headers: X-CSRF-TOKEN, Content-Type: application/json
 *   { label, profil:{typ:"PERSON",id}, stichwortListe:[], zusatzAngaben:[""],
 *     documentModelVersion:{branch,revision},           ← from GET /config per year
 *     document: base64(JSON {"BibER_Belege":{Belegart,IdNr_StPfl,Veranlagungszeitraum,
 *                                             <A>:{<B>:{…fields}}}}),   ← Belegart "A/B"
 *     pdf: base64(PDF), thumbnail: base64(JPEG),
 *     seiten:[{clientId,hOcr,textErkennungUebersprungen,angaben:[]}] }   ← one per page
 *
 * The portal runs OCR in the browser and sends hOCR; we skip it
 * (textErkennungUebersprungen: true) and provide the values ourselves, which
 * is what the form's "Verfügbare Belege übernehmen" reads (einfuellbareAngaben).
 */

const MAX_BYTES = 10 * 1024 * 1024;

export interface BelegUploadInput {
  file: string;
  label?: string;
  year: number;
  /** e.g. "N/Arbeitsmittel", "N/Weitere_Wk/Sonst", "N/Fortb", "N/Dienstreise". */
  belegart: string;
  /** Leaf fields, e.g. {Art_der_Arbeitsmittel:"…", Betrag:12.99}. */
  fields: Record<string, string | number>;
  stichwoerter?: string[];
  /** IdNr of the person; default: the first person of the account. */
  idNr?: string;
}

/**
 * Amount strings → numbers for amount-like keys.
 *   "1.234,56" / "12,99"  German: dots group thousands, comma is decimal
 *   "12.99"               a single dot with 1–2 digits after it is decimal
 *   "1.234"               ambiguous (German 1234 or English 1.234) → refused
 * Getting this wrong stores a receipt 100× too large, so guessing is not an option.
 */
export function parseAmount(raw: string): number {
  const v = raw.trim().replace(/\s|€/g, '');
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(v) || /^-?\d+,\d+$/.test(v)) {
    return Number(v.replace(/\./g, '').replace(',', '.'));
  }
  if (/^-?\d+\.\d{1,2}$/.test(v)) return Number(v);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d{1,3}(\.\d{3})+$/.test(v)) {
    throw new Error(`ambiguous amount "${raw}" — write "${v.replace(/\./g, '')}" or use a comma for decimals`);
  }
  throw new Error(`not an amount: "${raw}"`);
}

function normalizeFields(fields: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === 'string' && /betrag/i.test(k) ? parseAmount(v) : v;
  }
  return out;
}

/** "N/Weitere_Wk/Sonst" + fields → {N:{Weitere_Wk:{Sonst:fields}}}. */
function nest(belegart: string, fields: Record<string, unknown>): Record<string, unknown> {
  const parts = belegart.split('/').filter(Boolean);
  let node: Record<string, unknown> = fields;
  for (let i = parts.length - 1; i >= 0; i--) node = { [parts[i]]: node };
  return node;
}

function pdfPageCount(file: string, buf: Buffer): number {
  try {
    const out = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
    const m = out.match(/^Pages:\s+(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* poppler not installed */ }
  const n = (buf.toString('latin1').match(/\/Type\s*\/Page(?!s)\b/g) || []).length;
  return Math.max(1, n);
}

/** Small JPEG of page 1 via pdftoppm; empty string when poppler is missing. */
function pdfThumbnail(file: string): string {
  try {
    const jpg = execFileSync('pdftoppm', ['-jpeg', '-scale-to', '200', '-singlefile', '-f', '1', '-l', '1', file, '-'],
      { maxBuffer: 5 * 1024 * 1024 });
    return jpg.toString('base64');
  } catch {
    return '';
  }
}

/**
 * Turns an image into a one-page PDF plus thumbnail using a throwaway tab of
 * the engine's browser (the engine's own tab must never navigate).
 */
async function imageToPdf(newPage: () => Promise<Page>, buf: Buffer, mime: string) {
  const page = await newPage();
  try {
    const src = `data:${mime};base64,${buf.toString('base64')}`;
    await page.setContent(`<html><body style="margin:0"><img id="i" src="${src}" style="display:block;max-width:100%"></body></html>`);
    await page.waitForFunction(() => (document.getElementById('i') as HTMLImageElement)?.complete);
    const { w, h } = await page.evaluate(() => {
      const i = document.getElementById('i') as HTMLImageElement;
      return { w: i.naturalWidth, h: i.naturalHeight };
    });
    // A4 width, height by aspect ratio; image scaled to fit.
    const widthMm = 210, heightMm = Math.min(2000, Math.round(210 * h / Math.max(1, w)));
    await page.setViewport({ width: 794, height: Math.round(794 * h / Math.max(1, w)) });
    const pdf = Buffer.from(await page.pdf({ width: `${widthMm}mm`, height: `${heightMm}mm`, printBackground: true, pageRanges: '1' }));
    await page.setViewport({ width: 200, height: Math.max(1, Math.round(200 * h / Math.max(1, w))) });
    const thumb = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 70 }));
    return { pdf, thumbnail: thumb.toString('base64') };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function prepareBeleg(input: BelegUploadInput, newPage: () => Promise<Page>) {
  const file = path.resolve(input.file);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();

  let pdf: Buffer, thumbnail: string, pages: number;
  if (ext === '.pdf') {
    pdf = buf; pages = pdfPageCount(file, buf); thumbnail = pdfThumbnail(file);
  } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
    const r = await imageToPdf(newPage, buf, ext === '.png' ? 'image/png' : 'image/jpeg');
    pdf = r.pdf; thumbnail = r.thumbnail; pages = 1;
  } else {
    throw new Error(`unsupported file type ${ext} (PDF, PNG, JPG)`);
  }
  if (pdf.length > MAX_BYTES) throw new Error(`file too large for ELSTER (${pdf.length} bytes, max ${MAX_BYTES})`);

  return {
    label: input.label || path.basename(file, ext),
    year: String(input.year),
    belegart: input.belegart,
    tree: nest(input.belegart, normalizeFields(input.fields)),
    stichwoerter: input.stichwoerter ?? [],
    idNr: input.idNr ?? null,
    pdf: pdf.toString('base64'),
    thumbnail,
    seiten: Array.from({ length: pages }, () => ({
      clientId: crypto.randomUUID(), hOcr: '', textErkennungUebersprungen: true, angaben: [],
    })),
  };
}

/**
 * Runs inside the logged-in tab. Self-contained (serialized by Puppeteer).
 */
export async function postBelegInPage(p: any): Promise<any> {
  const csrf = (document.querySelector('meta[name="_csrf"]') as HTMLMetaElement | null)?.content || '';
  const api = '/eportal/biber/v2';
  const get = async (u: string) => {
    const r = await fetch(api + u, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`GET ${u}: HTTP ${r.status}`);
    return r.json();
  };
  const personen = await get('/personen');
  const person = p.idNr ? personen.find((x: any) => x.idNr === p.idNr) : personen[0];
  if (!person) throw new Error(`no person ${p.idNr || ''} in Meine Belege`);
  const config = await get('/config');
  const dmv = config.veranlagungszeitraeume?.[p.year]?.belegDocumentModelVersion;
  if (!dmv) throw new Error(`year ${p.year} not offered by Meine Belege`);

  const doc = { BibER_Belege: { Belegart: p.belegart, IdNr_StPfl: person.idNr, Veranlagungszeitraum: p.year, ...p.tree } };
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
  const body = {
    label: p.label,
    profil: { typ: 'PERSON', id: person.id },
    stichwortListe: p.stichwoerter,
    pdf: p.pdf,
    thumbnail: p.thumbnail,
    seiten: p.seiten,
    documentModelVersion: dmv,
    document: b64(JSON.stringify(doc)),
    zusatzAngaben: [''],
  };
  const r = await fetch(api + '/belege', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-TOKEN': csrf },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST /belege: HTTP ${r.status} ${text.slice(0, 300)}`);
  let created: any = {};
  try { created = JSON.parse(text); } catch { /* empty body */ }
  return {
    id: created.id ?? null, label: created.label ?? p.label, status: created.status ?? null,
    einfuellbareAngaben: created.einfuellbareAngaben ?? null, seiten: p.seiten.length,
    belegart: p.belegart, year: p.year,
  };
}

/** Runs inside the logged-in tab: compact list of receipts, optionally one year. */
export async function listBelegeInPage(year: string | null): Promise<any[]> {
  const r = await fetch('/eportal/biber/v2/belege', { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET /belege: HTTP ${r.status}`);
  const arr = await r.json();
  return arr.map((x: any) => {
    let d: any = {};
    try { d = JSON.parse(decodeURIComponent(escape(atob(x.document)))).BibER_Belege || {}; } catch { /* no document */ }
    return {
      id: x.id, label: x.label, status: x.status, year: d.Veranlagungszeitraum ?? null,
      belegart: d.Belegart ?? null, werte: x.einfuellbareAngaben, seiten: x.anzahlSeiten,
    };
  }).filter((x: any) => !year || x.year === year);
}
