/**
 * In-page driver for ELSTER's form engine ("interpreter").
 *
 * `installDriver` is serialized by Puppeteer and executed inside the logged-in
 * ELSTER tab, so it must stay self-contained: no imports, no closures over
 * module scope, plain DOM APIs only.
 *
 * Why this exists: every Online-Formular is a plain urlencoded POST to the
 * `action` of `#form`. Inputs are named `fields[<name>]` (the name embeds the
 * Kennzahl, e.g. `eruNWkHomeofficeE0204507`), checkboxes add a `_fields[...]`
 * marker, repeat-group rows use `mzbs[<group>].newItem.fields[<name>]`, and a
 * single `reqCmd` JSON says what to do (JumpToPage, CreateMzbItem, SwitchModus,
 * ...). Replaying that with `fetch` drives any form without clicks, modals or
 * timing — and without ever navigating the tab, which twice left Chrome's
 * renderer hung for good.
 *
 * State: `EO.doc` is the last response, parsed. Every POST starts from that
 * page's own form, so CSRF token and hidden fields are always the ones the
 * server just handed out.
 */
export function installDriver(): string {
  const w = window as any;
  if (w.EO && w.EO.version === 10) return 'already installed';

  // ── Safety ──────────────────────────────────────────────────────────────
  // ALLOWLIST: the only reqCmd names this engine may post. Anything else —
  // including commands nobody has seen yet — is refused. A blocklist can never
  // be complete (reviews found "senden", "DeleteAufgabe", loescheEntwurf_… all
  // slipping past one); an allowlist fails closed. Keep in sync with
  // ALLOWED_COMMANDS in engine.ts; tools/engine-selftest.mjs checks both.
  const ALLOWED_COMMANDS = new Set([
    'JumpToPage', 'JumpToItemCause', 'NextPage', 'PreviousPage', 'ToggleNavItem', 'Refresh', 'CheckAll',
    'SwitchModus',
    'AddMzbItem', 'CreateMzbItem', 'UpdateMzbItem', 'EditMzbItem', 'DeleteMzbItem', 'EditDetachedMzbSemIndex',
    'FillInProfile',
    'Enter', 'Continue', 'Cancel', 'FruehereAbgabeCommand',
    'OeffneAufgabeCommand', 'OeffneLetztenEntwurfCommand', 'SaveAufgabe', 'Finish',
  ]);
  // SwitchModus may only move between editing, checking and the Anlagen/eDaten
  // selection. SENDEN is the send overview (review() only), TRANSFERAUFGABE
  // sends a support request.
  const ALLOWED_MODES = new Set(['EINGABE', 'PRUEFEN', 'ANLAGENAUSWAHL', 'AUTOVAST_ENTRY', 'VAST']);

  // Second line of defence on anything that is text: button ids, names, values.
  // DeleteMzbItem (removing a row inside the form) is legitimate; deleting a
  // draft or a receipt is not.
  const FORBIDDEN = [
    /send/i,
    /uebermittl|übermittl/i,
    /delete(?!mzbitem)/i,
    /l(oe|ö)sch/i,
    /logout|abmelden/i,
    /\/(sign|rpc)\b/i,
  ];

  // The one exception (explicitly approved by the user, 27.09.2026): showing
  // the "Formular absenden" overview is the same SwitchModus a human's "Weiter"
  // posts after a clean Prüfung. It displays the final data; transmitting needs
  // a further button on that page, which stays forbidden. Only review() may
  // lift the guard, only for this exact string, and the flag lives in this
  // closure — not on window.EO, so nothing callable from outside can set it.
  const REVIEW_CMD = '{"SwitchModus":{"ignoreSkippableErrors":false,"target":"SENDEN","force":false}}';
  let reviewing = false;

  /** Plain strings (button ids, names, values): pattern check only. */
  const guardText = (s: string) => {
    for (const re of FORBIDDEN) {
      if (re.test(s)) throw new Error(`refused (send/delete/logout): ${s.slice(0, 160)}`);
    }
  };

  const onSendingPage = (url: string) => /versenden|\/sign\b/i.test(url);

  /**
   * reqCmd JSON: parsed and re-serialised (so "\u0053ENDEN" escapes decode to
   * what ELSTER reads), exactly one command name, that name on the allowlist,
   * SwitchModus only to an allowed mode. Returns the canonical text — it is
   * what gets posted, so the checked command and the sent one are identical.
   */
  const guard = (cmd: string): { text: string; name: string; body: any } => {
    let obj: any;
    try { obj = JSON.parse(cmd); } catch { throw new Error(`refused: command is not JSON: ${cmd.slice(0, 80)}`); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length !== 1) {
      throw new Error('refused: a command must be a JSON object with exactly one command name');
    }
    const text = JSON.stringify(obj);
    const name = Object.keys(obj)[0];
    const body = obj[name];
    if (reviewing && text === REVIEW_CMD) return { text, name, body };
    if (!ALLOWED_COMMANDS.has(name)) throw new Error(`refused: command "${name}" is not on the allowlist`);
    if (name === 'SwitchModus' && !ALLOWED_MODES.has(body?.target)) {
      throw new Error(`refused: SwitchModus target "${body?.target}" is not allowed`);
    }
    guardText(text);
    return { text, name, body };
  };

  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const serialize = (f: HTMLFormElement): URLSearchParams => {
    const body = new URLSearchParams();
    for (const el of Array.from(f.querySelectorAll('input[name],select[name],textarea[name]')) as HTMLInputElement[]) {
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      if (['submit', 'button', 'file', 'image', 'reset'].includes(el.type)) continue;
      if (el.name === 'reqCmd') continue;
      body.append(el.name, el.value);
    }
    return body;
  };

  const EO: any = {
    version: 10,
    doc: document as Document,
    url: location.href,

    _parse(html: string, url: string) {
      this.doc = new DOMParser().parseFromString(html, 'text/html');
      this.url = url;
    },

    form(): HTMLFormElement | null {
      return this.doc.getElementById('form') as HTMLFormElement | null;
    },

    title(): string {
      return clean(this.doc.querySelector('h1')?.textContent).slice(0, 160);
    },

    csrf(): string | undefined {
      return (this.doc.querySelector('meta[name="_csrf"]') as HTMLMetaElement | null)?.content
        || (this.doc.querySelector('input[name="_csrf"]') as HTMLInputElement | null)?.value
        || (document.querySelector('meta[name="_csrf"]') as HTMLMetaElement | null)?.content;
    },

    async load(url: string) {
      // Even a GET can act (/eportal/abmelden logs out). Only same-origin
      // /eportal/ paths, resolved first so "../" cannot escape, then screened.
      const target = new URL(url, location.origin);
      if (target.origin !== location.origin || !target.pathname.startsWith('/eportal/')) {
        throw new Error(`refused: load outside /eportal/: ${target.href}`);
      }
      guardText(target.pathname + target.search);
      this.lastRid = null;
      const r = await fetch(target.href, { credentials: 'include', redirect: 'follow' });
      this._parse(await r.text(), r.url);
      return { status: r.status, url: r.url, title: this.title() };
    },

    /** Posts #form of the current page with a command and field overrides. */
    async post(reqCmd: any, overrides: Record<string, string | null> = {}, appends: [string, string][] = []) {
      const checked = guard(typeof reqCmd === 'string' ? reqCmd : JSON.stringify(reqCmd));
      const cmd = checked.text;
      // On the sending page the only way anywhere is back to editing/checking.
      if (onSendingPage(this.url)
          && !(checked.name === 'SwitchModus' && ['EINGABE', 'PRUEFEN'].includes(checked.body?.target))) {
        throw new Error(`refused: only SwitchModus EINGABE/PRUEFEN allowed on the sending page, got ${cmd.slice(0, 120)}`);
      }
      const jumpRid: string | undefined = checked.name === 'JumpToPage'
        ? checked.body?.target?.['FormData-RID']?.rid : undefined;
      const f = this.form();
      if (!f) throw new Error(`current page has no #form (${this.url})`);
      const body = serialize(f);
      for (const [k, v] of Object.entries(overrides)) {
        if (v === null) body.delete(k); else body.set(k, String(v));
      }
      for (const [k, v] of appends) body.append(k, v);
      body.set('reqCmd', cmd);
      // Row commands and field saves stay on the page; only real navigation
      // makes the remembered RID stale.
      if (/"(NextPage|PreviousPage|SwitchModus|JumpToItemCause|Continue|Cancel|Enter|OeffneAufgabe\w*|EditDetachedMzbSemIndex|SaveAufgabe)"/.test(cmd)) {
        this.lastRid = null;
      }
      const action = new URL(f.getAttribute('action') || this.url, this.url).href;
      if (/\/(sign|rpc)\b/i.test(action)) throw new Error(`refused: form posts to ${action}`);
      const r = await fetch(action, { method: 'POST', body, credentials: 'include', redirect: 'follow' });
      this._parse(await r.text(), r.url);
      if (jumpRid) this.lastRid = jumpRid;
      return { status: r.status, url: r.url, title: this.title() };
    },

    /** Presses a submit button by id: posts its own form with its name/value. */
    async press(buttonId: string, overrides: Record<string, string | null> = {}, appends: [string, string][] = []) {
      if (onSendingPage(this.url)) {
        throw new Error('refused: no button presses on the sending page ("Absenden" has no command value to screen)');
      }
      const b = this.doc.getElementById(buttonId) as HTMLButtonElement | null;
      if (!b) throw new Error(`no button #${buttonId} on ${this.url}`);
      // Screen everything the press would reveal: id, visible text, name, value.
      guardText(buttonId);
      guardText(clean(b.textContent));
      guardText(b.name || '');
      // reqCmd buttons carry JSON commands: allowlist + canonical form. Any other
      // named button must not carry a value that looks like a command at all.
      let value = b.value;
      if (b.name === 'reqCmd') {
        if (!b.value) throw new Error(`refused: reqCmd button #${buttonId} has no command`);
        value = guard(b.value).text;
      } else {
        guardText(b.value || '');
        if (/^\s*[{\[]/.test(b.value || '')) throw new Error(`refused: button #${buttonId} carries JSON outside reqCmd`);
      }
      const f = (b.form || b.closest('form')) as HTMLFormElement | null;
      if (!f) throw new Error(`button #${buttonId} has no form`);
      const body = serialize(f);
      for (const [k, v] of Object.entries(overrides)) {
        if (v === null) body.delete(k); else body.set(k, String(v));
      }
      for (const [k, v] of appends) body.append(k, v);
      if (b.name) body.set(b.name, value);
      this.lastRid = null;
      const action = new URL(f.getAttribute('action') || this.url, this.url).href;
      if (/\/(sign|rpc)\b|versenden/i.test(action)) throw new Error(`refused: form posts to ${action}`);
      const method = (f.getAttribute('method') || 'post').toUpperCase();
      const r = method === 'GET'
        ? await fetch((() => { const u = new URL(action); body.forEach((v, k) => u.searchParams.append(k, v)); return u.href; })(),
            { credentials: 'include', redirect: 'follow' })
        : await fetch(action, { method: 'POST', body, credentials: 'include', redirect: 'follow' });
      this._parse(await r.text(), r.url);
      return { status: r.status, url: r.url, title: this.title() };
    },

    jumpCmd(rid: string) {
      return { JumpToPage: { target: { 'FormData-RID': { rid } }, semanticIndexFieldValue: null, ignoreSkippableErrors: false } };
    },

    lastRid: null as string | null,

    async jump(rid: string) {
      const r = await this.post(this.jumpCmd(rid));
      this.lastRid = rid;
      return r;
    },

    labelOf(el: HTMLElement): string {
      const byFor = el.id ? this.doc.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const t = byFor?.textContent
        || el.closest('.formItem,fieldset,tr')?.querySelector('label,legend,th')?.textContent || '';
      return clean(t).slice(0, 160);
    },

    describe(el: HTMLInputElement) {
      const isToggle = el.type === 'checkbox' || el.type === 'radio';
      return {
        name: el.name,
        kennzahl: (el.name.match(/E\d{7}/) || [null])[0],
        type: el.type || el.tagName.toLowerCase(),
        value: isToggle ? (el.checked ? el.value : '') : el.value,
        choice: isToggle ? el.value : undefined,
        options: el.tagName === 'SELECT'
          ? Array.from((el as unknown as HTMLSelectElement).options).map(o => `${o.value}=${clean(o.text)}`)
          : undefined,
        label: this.labelOf(el),
      };
    },

    /** Plain fields of the current page (not repeat-group templates). */
    fields() {
      const f = this.form();
      if (!f) return [];
      return Array.from(f.querySelectorAll('[name^="fields["]'))
        .filter((e: any) => e.type !== 'hidden')
        .map((e: any) => this.describe(e));
    },

    /**
     * Named inputs of #form outside `fields[...]` / `mzbs[...]` — e.g. the
     * Steuernummer dialog (`stnrDialogs[...].steuernummer.nummer`) or profile
     * pickers. Settable with their full name.
     */
    otherInputs() {
      const f = this.form();
      if (!f) return [];
      return (Array.from(f.querySelectorAll('input[name],select[name],textarea[name]')) as HTMLInputElement[])
        .filter(e => !/^(_?fields\[|mzbs\[|_csrf$|reqCmd$|suchstring$|fieldsResetSource\[)/.test(e.name))
        .filter(e => e.type !== 'hidden' && !['submit', 'button', 'file'].includes(e.type))
        .map(e => this.describe(e));
    },

    /** Repeat groups ("Mzb") on the current page: committed rows + template. */
    groups() {
      return Array.from(this.doc.querySelectorAll('.mzb[data-form-model-id]')).map((m: any) => {
        const group = m.getAttribute('data-form-model-id');
        const rows = Array.from(m.querySelectorAll('tr[data-mzb-row]'))
          .map((tr: any) => clean(tr.innerText || tr.textContent))
          .filter((t: string) => t && !/^Neuer Eintrag/.test(t))
          .map((t: string) => t.replace(/ Eintrag (bearbeiten|löschen|übernehmen)/g, '').slice(0, 200));
        // "E6002302: Bezeichnung" — add_row takes the Kennzahl as key.
        const template = Array.from(this.form()?.querySelectorAll(`[name^="mzbs[${group}].newItem.fields["]`) || [])
          .filter((e: any) => e.type !== 'hidden')
          .map((e: any) => {
            const d = this.describe(e);
            return `${d.kennzahl || d.name}: ${d.label}` + (d.options ? ` {${d.options.join('; ')}}` : '');
          });
        // Detached groups keep their rows on sub-pages; list those RIDs.
        const subPages = Array.from(m.querySelectorAll('button[name="reqCmd"]'))
          .map((b: any) => b.value).filter((v: string) => /JumpToPage/.test(v))
          .map((v: string) => (v.match(/"rid":"([^"]+)"/) || [])[1]).filter(Boolean);
        return { group, entries: Number(m.getAttribute('data-mzb-entries') || 0), rows, template, subPages: Array.from(new Set(subPages)) };
      });
    },

    nav(): string[] {
      return Array.from(this.doc.querySelectorAll('[id^="FormData://"]'))
        .map((e: any) => e.id as string)
        .filter(id => !id.endsWith('_toggleElement') && !id.endsWith('_tsGroup') && !id.includes('_error('));
    },

    /** Buttons that do something other than plain navigation. */
    commands() {
      return Array.from(this.doc.querySelectorAll('button[name="reqCmd"]'))
        .map((b: any) => ({ id: b.id, text: clean(b.textContent).slice(0, 80), command: b.value as string }))
        // Covered elsewhere: row buttons by `groups` + add_row/delete_row,
        // paging and modes by jump/check/save. What remains is the unusual stuff
        // worth pressing (EditDetachedMzbSemIndex, FillInProfile, Refresh, ...).
        .filter(c => !/"(JumpToPage|ToggleNavItem|SwitchToMeineBelege|JumpToItemCause|AddMzbItem|CreateMzbItem|DeleteMzbItem|EditMzbItem|UpdateMzbItem|ClearMzbItems|NextPage|PreviousPage)"/.test(c.command))
        .filter(c => !/"SwitchModus"/.test(c.command))
        .filter((c, i, a) => a.findIndex(x => x.command === c.command) === i);
    },

    errors(): string[] {
      return Array.from(this.doc.querySelectorAll('.messageBox--error, .feedback--error, .message--error, .formItem__error'))
        .map((e: any) => clean(e.textContent)).filter(Boolean)
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).slice(0, 20);
    },

    /**
     * RID of the page being shown. ELSTER marks the current navigation entry
     * with a hidden "Sie befinden sich hier" prefix; pages reached by our own
     * jump are known anyway.
     */
    rid(): string | null {
      const cur = (Array.from(this.doc.querySelectorAll('[id^="FormData://"]')) as HTMLElement[])
        .find(e => /Sie befinden sich hier/.test(e.textContent || '') && !e.id.endsWith('_toggleElement'));
      return cur?.id || this.lastRid || null;
    },

    summary(opts: { withNav?: boolean } = {}) {
      return {
        url: this.url,
        title: this.title(),
        rid: this.rid(),
        fields: this.fields(),
        otherInputs: this.otherInputs(),
        groups: this.groups(),
        commands: this.commands(),
        errors: this.errors(),
        nav: opts.withNav === false ? undefined : this.nav(),
      };
    },

    /** Maps keys (full field name or Kennzahl) to `fields[...]` names on the page. */
    resolve(keys: string[], prefix: string) {
      const f = this.form();
      const names: string[] = Array.from(new Set(
        (Array.from(f?.querySelectorAll(`[name^="${prefix}"]`) || []) as HTMLInputElement[])
          .filter(e => e.type !== 'hidden').map(e => e.name)));
      const out: Record<string, string> = {};
      const all = new Set((Array.from(f?.querySelectorAll('input[name],select[name],textarea[name]') || []) as HTMLInputElement[]).map(e => e.name));
      for (const k of keys) {
        // A full input name (e.g. "stnrDialogs[...].steuernummer.nummer") is used as is.
        if (all.has(k)) { out[k] = k; continue; }
        const exact = names.filter(n => n === `${prefix}${k}]`);
        const hits = exact.length === 1 ? exact : names.filter(n => n.includes(k));
        if (hits.length !== 1) {
          throw new Error(hits.length === 0
            ? `no field matching "${k}" on this page; available: ${names.map(n => n.slice(prefix.length, -1)).join(', ')}`
            : `"${k}" is ambiguous here: ${hits.join(', ')}`);
        }
        out[k] = hits[0];
      }
      return out;
    },

    /** Turns key/value pairs into post overrides, handling checkboxes. */
    overridesFor(values: Record<string, any>, prefix: string) {
      const map = this.resolve(Object.keys(values), prefix);
      const ov: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(values)) {
        const name = map[k];
        const el = this.form().querySelector(`[name="${CSS.escape(name)}"]`) as HTMLInputElement;
        if (el?.type === 'checkbox') {
          ov[name] = (v === true || v === 'true' || v === 1 || v === '1' || v === 'X') ? el.value : null;
        } else {
          ov[name] = v === null || v === undefined ? '' : String(v);
        }
      }
      return ov;
    },

    /** Current values of the given input names, for compact tool responses. */
    valuesOf(names: string[]) {
      const f = this.form();
      return names.map(n => {
        const els = Array.from(f?.querySelectorAll(`[name="${CSS.escape(n)}"]`) || []) as HTMLInputElement[];
        const el = els.find(e => e.type !== 'hidden') || els[0];
        if (!el) return { name: n, value: null };
        const isToggle = el.type === 'checkbox' || el.type === 'radio';
        const v = isToggle ? (els.find(e => e.checked)?.value ?? '') : el.value;
        return { name: n, kennzahl: (n.match(/E\d{7}/) || [null])[0], value: v, label: this.labelOf(el).slice(0, 80) };
      });
    },

    lastSetNames: [] as string[],

    getLastSetNames() { return this.lastSetNames; },

    async setFields(values: Record<string, any>) {
      const self = this.rid() || null;
      const ov = this.overridesFor(values, 'fields[');
      this.lastSetNames = Object.keys(ov);
      // Saving = posting the page back; re-jumping to the same page keeps us here.
      // Saving means posting the page back to itself. Without knowing which
      // page this is, any other command would move away (NextPage did) and the
      // read-back would describe the wrong page — so refuse instead.
      if (!self) throw new Error('current page RID unknown — pass rid to elster_form_set');
      return this.post(this.jumpCmd(self), ov);
    },

    async addRow(group: string, values: Record<string, any>) {
      const btn = (Array.from(this.doc.querySelectorAll('button[name="reqCmd"]')) as HTMLButtonElement[])
        .find(b => b.value.includes('"CreateMzbItem"') && b.value.includes(`/${group}[`));
      if (!btn) {
        const avail = this.groups().map((g: any) => g.group).join(', ');
        throw new Error(`no inline repeat group "${group}" here; groups: ${avail || 'none'}`);
      }
      const ov = this.overridesFor(values, `mzbs[${group}].newItem.fields[`);
      return this.post(btn.value, ov);
    },

    async deleteRow(group: string, index: number) {
      const btn = (Array.from(this.doc.querySelectorAll('button[name="reqCmd"]')) as HTMLButtonElement[])
        .find(b => b.value.includes('"DeleteMzbItem"') && b.value.includes(`/${group}[${index}]"`));
      if (!btn) throw new Error(`no row ${index} in group "${group}" here`);
      return this.post(btn.value);
    },

    async crawl(rootRid: string, maxPages: number) {
      const seen = new Set<string>();
      const queue = [rootRid];
      const pages: any[] = [];
      while (queue.length && pages.length < maxPages) {
        const rid = queue.shift()!;
        if (seen.has(rid)) continue;
        seen.add(rid);
        await this.jump(rid);
        pages.push({
          rid,
          title: this.title(),
          fields: this.fields().map((f: any) => ({ name: f.name.slice(7, -1), kennzahl: f.kennzahl, type: f.type, value: f.value, label: f.label })),
          groups: this.groups().map((g: any) => ({ group: g.group, entries: g.entries, template: g.template, subPages: g.subPages })),
        });
        for (const n of this.nav()) if (n.startsWith(rootRid + '/') && !seen.has(n)) queue.push(n);
        for (const g of pages[pages.length - 1].groups) for (const s of g.subPages) if (!seen.has(s)) queue.push(s);
      }
      return { rootRid, pages, truncated: queue.length > 0 };
    },

    async check() {
      const r = await this.post({ SwitchModus: { ignoreSkippableErrors: false, target: 'PRUEFEN', force: false } });
      const main = clean((this.doc.querySelector('main') as any)?.innerText || this.doc.querySelector('main')?.textContent);
      const panel = Array.from(this.doc.querySelectorAll('nav, [class*=errorList]'))
        .map((e: any) => clean(e.innerText || e.textContent)).filter(t => /Fehler|Hinweis/.test(t));
      const result = (main.match(/(Erstattung|Nachzahlung|Gewinn|Verlust)[^:]{0,40}:\s*-?[\d.]+,\d{2}\s*€/g) || []);
      return { ...r, ok: /keine Fehler/i.test(main), headline: main.slice(0, 700), result, panel: panel.slice(0, 2).map(t => t.slice(0, 3000)) };
    },

    /**
     * Reads the "Formular absenden" overview — exactly what would be
     * transmitted — without transmitting. Requires a clean Prüfung first,
     * enters the overview with the single allowed SwitchModus, captures its
     * eoprint markup and returns to editing before anything else can run.
     */
    async review() {
      const c = await this.check();
      if (!c.ok) return { ok: false, check: c, html: null };
      reviewing = true;
      try { await this.post(REVIEW_CMD); } finally { reviewing = false; }
      // Whatever happens while reading, leave the sending page again.
      try {
        if (!onSendingPage(this.url)) {
          return { ok: false, check: c, html: null, note: `overview not reached (${this.url})` };
        }
        const box = this.doc.querySelector('.sendingPage') || this.doc.querySelector('main');
        return { ok: true, check: { result: c.result }, html: box ? box.innerHTML : '' };
      } finally {
        if (onSendingPage(this.url)) await this.enterEditMode();
      }
    },

    async enterEditMode() {
      return this.post({ SwitchModus: { ignoreSkippableErrors: false, target: 'EINGABE', force: false } });
    },

    async saveDraft() {
      let a = this.doc.getElementById('verlassenModal');
      if (!a) { await this.enterEditMode(); a = this.doc.getElementById('verlassenModal'); }
      if (!a) throw new Error('no "Speichern und Formular verlassen" on the current page');
      // The modal endpoint and its one command are fixed; do not trust the
      // page to name another URL or command for this credentialed POST.
      const source = new URL(a.getAttribute('data-source') || '/eportal/interpretermodal', location.origin);
      if (source.origin !== location.origin || source.pathname !== '/eportal/interpretermodal') {
        throw new Error(`refused: save modal from unexpected URL ${source.href}`);
      }
      let modalCmd: any;
      try { modalCmd = JSON.parse(a.getAttribute('data-req-cmd') || ''); } catch { modalCmd = null; }
      if (!modalCmd || Object.keys(modalCmd).length !== 1 || !modalCmd.SpeichernUndVerlassenModalCommand) {
        throw new Error('refused: unexpected save-modal command');
      }
      const fd = new FormData();
      fd.append('reqCmd', JSON.stringify(modalCmd));
      const r = await fetch(source.href, {
        method: 'POST', body: fd, credentials: 'include',
        headers: { 'x-csrf-token': this.csrf() || '', eopfetchtype: 'interactive' },
      });
      const modal = new DOMParser().parseFromString(await r.text(), 'text/html');
      const save = modal.getElementById('saveAufgabe') as HTMLButtonElement | null;
      if (!save) throw new Error('save dialog did not offer "Speichern und Verlassen"');
      return this.post(save.value || save.getAttribute('data-req-cmd'));
    },

    async drafts() {
      await this.load('/eportal/meineformulare');
      const c = this.doc.getElementById('meineFormulare-entwuerfe_content');
      return Array.from(c?.querySelectorAll('tr') || []).map((tr: any) => {
        const open = tr.querySelector('button[id^="oeffneEntwurf_"]') as HTMLButtonElement | null;
        if (!open) return null;
        const cells = Array.from(tr.querySelectorAll('td')).map((td: any) =>
          clean(td.innerText || td.textContent).replace(/^(Entwurf|Ordnungskriterium|Profil|Gespeichert am|Gültig bis)\s*/, ''));
        return { aufgabeId: Number(open.id.replace('oeffneEntwurf_', '')), bezeichnung: cells[0], ordnungskriterium: cells[1], gespeichertAm: cells[3], gueltigBis: cells[4] };
      }).filter(Boolean);
    },

    /** Opens a draft; re-enters it when the server still holds it open. */
    async openDraft(aufgabeId?: number) {
      const list = await this.drafts();
      const id = aufgabeId || list[0]?.aufgabeId;
      if (!id) throw new Error('no drafts');
      await this.press(`oeffneEntwurf_${id}`);
      if (/kann nicht geöffnet werden/.test(this.title())) {
        const b = (Array.from(this.doc.querySelectorAll('button[name="reqCmd"]')) as HTMLButtonElement[])
          .find(x => /"target":"EINGABE"/.test(x.value));
        if (!b) throw new Error('draft is locked and offers no way back in');
        await this.post(b.value);
      }
      return { aufgabeId: id, url: this.url, title: this.title() };
    },

    /**
     * Starts a new form: year → Datenübernahme → Anlagenauswahl → (eDaten) →
     * Startseite. Stops early on any page it does not recognise and returns it.
     */
    async newForm(slug: string, year: number, anlagen: string[] | null, takeover: string | null, importEdaten: boolean) {
      const steps: string[] = [];
      if (!/^[a-z0-9_-]{2,40}$/i.test(slug)) throw new Error(`invalid form slug "${slug}"`);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error(`invalid year ${year}`);
      await this.load(`/eportal/formulare-leistungen/alleformulare/${slug}`);
      const sel = this.doc.getElementById('zeitraumJahr') as HTMLSelectElement | null;
      if (!sel) throw new Error(`form "${slug}" has no year selection (${this.title()})`);
      // "<year>-v1" / "<year>-v_<year>" usually; some forms use the bare year.
      const opt = Array.from(sel.options).find(o => o.value.startsWith(`${year}-`))
        ?? Array.from(sel.options).find(o => o.value === String(year));
      if (!opt) throw new Error(`year ${year} not offered for ${slug}: ${Array.from(sel.options).map(o => o.value).join(', ')}`);
      await this.press('Enter', { [sel.name]: opt.value });
      steps.push(this.url);

      for (let i = 0; i < 6; i++) {
        if (/eingabefortsetzen/.test(this.url)) {
          throw new Error('a form of this type is already open in this session — save or open it via elster_form_open first');
        }
        if (/fruehereAbgaben/.test(this.url)) {
          if (takeover) {
            const b = this.doc.getElementById(`uebernehmenButton_${takeover}`);
            if (!b) throw new Error(`takeover ${takeover} not offered`);
            await this.press(`uebernehmenButton_${takeover}`);
          } else {
            await this.press('Continue');
          }
        } else if (/anlagenauswahl/.test(this.url)) {
          if (anlagen && anlagen.length) {
            const f = this.form();
            for (const cb of Array.from(f.querySelectorAll('input[name="selectedAnlagen"]')) as HTMLInputElement[]) cb.checked = false;
            await this.press('Continue', {}, anlagen.map(a => ['selectedAnlagen', a] as [string, string]));
          } else {
            await this.press('Continue');
          }
        } else if (/autovast/.test(this.url)) {
          if (importEdaten) {
            if (!this.doc.getElementById('Finish')) break;
            await this.press('Finish');
          } else {
            // Skipping the import: take the page's own way on without it, if it
            // offers one on the allowlist; otherwise say so instead of leaving
            // the caller stranded on the wizard.
            const skip = (Array.from(this.doc.querySelectorAll('button[name="reqCmd"]')) as HTMLButtonElement[])
              .find(b => /ohne|überspringen|nicht übernehmen|weiter/i.test(clean(b.textContent))
                && /"(Continue|Cancel)"/.test(b.value));
            if (!skip) {
              throw new Error('eDaten import page reached and it offers no way to skip it; '
                + 'call elster_form_new with importEdaten:true, or continue via elster_form_page/press');
            }
            await this.press(skip.id);
          }
        } else {
          break;
        }
        steps.push(this.url);
      }
      return { steps, url: this.url, title: this.title() };
    },
  };

  w.EO = EO;
  return 'installed';
}
