import { Page } from 'puppeteer';

/**
 * Parser for ELSTER's "eoprint" rendering — the tabular read-only view of a
 * whole form. The same markup appears in two useful places:
 *
 *   - the Übertragungsprotokoll of an already-submitted return
 *     (see submissions.ts, fetched as an HTML fragment)
 *   - the "Versenden des Formulars" review page of a form still being edited
 *     (/eportal/interpreter/versenden/<form>-<year>)
 *
 * The review page additionally badges every value with where it came from:
 *
 *   Frühere Abgabe · Bescheinigung · Beleg · Profil · Unterschiedliche Quellen
 *
 * That provenance is the whole point of reading it — it separates what the tax
 * authority already knows (eDaten) from what still has to be entered by hand.
 */

export type EoprintSource =
  | 'Frühere Abgabe' | 'Bescheinigung' | 'Beleg' | 'Profil'
  | 'Unterschiedliche Quellen' | null;

export interface EoprintRow {
  /** "Zeile" number printed on the paper form, when present. */
  zeile: string | null;
  label: string;
  value: string;
  /** ELSTER's own field identifier, e.g. "id-N-ArbL-…_usb1_1-1-1-1". */
  fieldId: string | null;
  source: EoprintSource;
}

export interface EoprintSection {
  form: string;
  heading: string[];
  rows: EoprintRow[];
}

export interface EoprintDocument {
  title: string;
  meta: Record<string, string>;
  sections: EoprintSection[];
  rowCount: number;
  /** Present on the review page: "Nachzahlung: 7,00 €" / "Erstattung: …". */
  steuerberechnung: string | null;
}

/**
 * Parses eoprint markup.
 *
 * Pass `fragment` to parse an HTML string (protocol modals); omit it to parse
 * the page that is currently open (the review page). Either way the work runs
 * in the browser, so one DOM implementation covers both.
 */
export async function parseEoprint(page: Page, fragment?: string): Promise<EoprintDocument> {
  const parsed = await page.evaluate((frag: string | null) => {
    const root = (() => {
      if (frag == null) return document.body;
      // Scripts do not execute via innerHTML and the markup is ELSTER's own.
      const d = document.createElement('div');
      d.innerHTML = frag;
      return d;
    })();

    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

    const SOURCES = ['Frühere Abgabe', 'Bescheinigung', 'Beleg', 'Profil', 'Unterschiedliche Quellen'];
    const CHROME = 'button, a, .table-collapse__cellTitle, [class*="interactive"], script, style';

    /** Strips buttons, links, column labels and the provenance badge. */
    const cellValue = (cell: Element): { value: string; source: string | null } => {
      const clone = cell.cloneNode(true) as Element;
      clone.querySelectorAll(CHROME).forEach(n => n.remove());
      let text = clean(clone.textContent);

      let source: string | null = null;
      for (const s of SOURCES) {
        const marker = `Übernommen aus ${s}`;
        const idx = text.indexOf(marker);
        if (idx !== -1) {
          source = s;
          text = clean(text.slice(0, idx) + text.slice(idx + marker.length));
          break;
        }
      }
      // The sending overview marks provenance with an attribute instead of text.
      if (!source) {
        const attr = cell.querySelector('[data-print-source]')?.getAttribute('data-print-source');
        const map: Record<string, string> = {
          submission: 'Frühere Abgabe', report: 'Bescheinigung', receipt: 'Beleg',
          profile: 'Profil', any: 'Unterschiedliche Quellen',
        };
        if (attr && map[attr]) source = map[attr];
      }
      // The badge sometimes survives only as its own element.
      if (!source) {
        const badge = clean(cell.textContent);
        for (const s of SOURCES) {
          if (badge.includes(`Übernommen aus ${s}`)) { source = s; break; }
        }
      }
      text = text.replace(/^\s*Angabe bearbeiten\s*/i, '').trim();
      return { value: text, source };
    };

    const title = clean(
      root.querySelector('.modal__title')?.textContent
      ?? root.querySelector('h1')?.textContent
      ?? document.title,
    );

    // Header block of a protocol: bounded by the next known label, because the
    // values themselves contain colons ("Eingang auf Server: …, 23:32:07").
    const META = 'Datenübermittler|Steuernummer|Finanzamt|Eingang auf Server|Transferticket|Erstellungsdatum';
    const meta: Record<string, string> = {};
    const headerNode = root.cloneNode(true) as Element;
    headerNode.querySelectorAll('.eoprint__page, .eoprint__page__note, .modal__footer, button')
      .forEach(n => n.remove());
    // <p>s are glued together by textContent; join them with spaces first.
    const headerText = Array.from(headerNode.querySelectorAll('p')).map(p => p.textContent).join(' ')
      || headerNode.textContent;
    for (const m of clean(headerText).matchAll(
      new RegExp(`(${META}):\\s*(.*?)(?=\\s+(?:${META}):|$)`, 'g'),
    )) meta[m[1]] = clean(m[2]);

    const bodyText = clean(root.textContent);
    const calc = bodyText.match(/(Nachzahlung|Erstattung):\s*([\d.,]+\s*€)/);
    const steuerberechnung = calc ? `${calc[1]}: ${calc[2]}` : null;

    const sections: any[] = [];
    let form = 'Kopfdaten';
    const heading: string[] = [];

    const pushTable = (table: Element) => {
      const rows = Array.from(table.querySelectorAll('tr')).map(tr => {
        // The sending overview puts labels in <th>; protocols use <td>.
        const cells = Array.from(tr.querySelectorAll('td, th'));
        if (!cells.length) return null;

        const first = clean(cells[0].textContent);
        const zeile = /^\d+$/.test(first) ? first : null;
        const rest = zeile ? cells.slice(1) : cells;
        const valueCell = rest.length > 1 ? rest[rest.length - 1] : rest[0];
        if (!valueCell) return null;

        const named = valueCell.querySelector('[data-name]');
        // A ticked checkbox is printed as its label alone, in a "checkedField" cell.
        if (rest.length === 1 && valueCell.classList.contains('eoprint__tableCell--checkedField')) {
          const c = cellValue(valueCell);
          return { zeile, label: c.value, value: 'angekreuzt', fieldId: named ? named.getAttribute('data-name') : null, source: c.source };
        }
        const { value, source } = cellValue(valueCell);
        const labelCell = rest.length > 1 ? rest[0] : null;
        const label = labelCell ? cellValue(labelCell).value : '';

        if (!value && !label) return null;
        return { zeile, label, value, fieldId: named ? named.getAttribute('data-name') : null, source };
      }).filter(Boolean);

      // Without an <h1> per form (sending overview) the <h2> names the Anlage.
      const f = form === 'Kopfdaten' && heading[0] ? heading[0] : form;
      const h = f === heading[0] ? heading.slice(1) : [...heading];
      if (rows.length) sections.push({ form: f, heading: h, rows });
    };

    root.querySelectorAll('h1, h2, h3, h4, h5, table.eoprint__table, table').forEach(el => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'table') { pushTable(el); return; }
      const text = clean(el.textContent);
      if (!text) return;
      if (tag === 'h1') {
        if (/^Übertragungsprotokoll|^Formular absenden/.test(text)) return;
        form = text;
        heading.length = 0;
      } else {
        const depth = parseInt(tag[1], 10) - 2;
        heading.length = Math.max(0, Math.min(depth, heading.length));
        heading[depth] = text;
        heading.length = depth + 1;
      }
    });

    return { title, meta, sections, steuerberechnung };
  }, fragment ?? null);

  const rowCount = parsed.sections.reduce((n: number, s: any) => n + s.rows.length, 0);
  return { ...parsed, rowCount } as EoprintDocument;
}
