# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # also downloads bundled Chromium (~150 MB)
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm start            # node dist/index.js (stdio MCP server)
```

There is **no test suite, no linter, and no CI** in this repo. `tsc` is the only automated check — run `npm run build` after edits.

Manual verification of a Puppeteer flow: set `ELSTER_HEADLESS=false` and run the tool; failure screenshots land in `./screenshots/` (gitignored), downloads in `./downloads/`.

## Architecture

Single-process stdio MCP server that automates the ELSTER **web portal** with a real logged-in browser session. There is no ERiC/XML submission path — everything goes through Puppeteer clicking the same Online-Formular a human uses.

Three layers:

1. **`src/index.ts`** — the whole MCP surface. `TOOLS[]` (JSON-schema tool declarations) and `dispatch()` (a single `switch`) are the only places tools are registered. Adding a tool means editing both, in the same file. Errors from `dispatch` are caught centrally and returned as `{ error }` with `isError: true`.
2. **`src/elster/*.ts`** — one class per ELSTER flow, all extending `ElsterBase`. Each owns its own browser instance.
3. **`src/session-manager.ts` + `src/config.ts` + `src/logger.ts`** — process-wide singletons.

### The async-session pattern (important)

MCP tool calls must return fast, but a UStVA/EÜR/ESt run takes minutes. So `*_start` tools are **fire-and-forget**:

- `startSession()` / `startTransmitSession()` creates a session, kicks off `this.run(...)` **without awaiting**, and returns the `sessionId` synchronously.
- The background run mutates `session.status` / `session.progress` in place; the client polls `elster_session_status`.
- Cross-call rendezvous happens through promise resolvers stashed on the session object (`_confirmResolve`, `_resultResolve`, `_doneResolve` in `InternalSession`). `elster_ustva_confirm` resolves `_confirmResolve`, which unblocks the paused background run, and awaits `_resultResolve` for the ticket.
- Sessions self-delete one hour after the run finishes (`scheduleCleanup`). Nothing is persisted — a server restart loses all sessions.

Consequence: state is **in-memory only** and each class holds a single `this.browser` / `this.page`. Two concurrent sessions of the same kind would clobber each other's browser handles.

### Safety invariants — do not weaken these

- `elster_ustva_confirm` is the **only** code path that clicks "Absenden". `runWithCheckpoint` parks at `AWAITING_CONFIRM` behind a promise with a 15-minute timeout; nothing transmits without that second explicit tool call.
- `ElsterEur` and `ElsterEst` stop at "Prüfen". EÜR then attempts "Speichern und Verlassen"; ESt just holds the browser open 30 minutes. Neither has an Absenden path.
- `fillKzInput` **throws** if an input-tax Kennziffer (60/61/66/67) gets a negative value — that always indicates a sign bug upstream, and a wrong sign here means a wrong tax filing. Do not "fix" it by clamping silently.
- Sync/history/inbox tools are read-only.

### Selector strategy

ELSTER's markup is unstable, so every interaction is defensive and layered, in this order: id/name substring selector → visible-check (`offsetParent !== null`) → text/label search via `page.evaluate` → XPath fallback. `fillKzInput` and `fillFieldByLabel` are the reference implementations of that cascade; copy them rather than writing a bare `page.click(selector)`.

Other recurring conventions:

- `ElsterBase.handleModals()` is called after nearly every navigation. ELSTER interrupts flows with "Wiederaufnahme"/"Eingabefehler"/"Formular verlassen" dialogs; the German body-text substrings it matches are the actual contract.
- Page walking (`walkThroughPages`, `walkAndFillPages`, `walkAndFill`) loops "fill current page → click Nächste Seite" with a `MAX_PAGES` cap and a `sameUrlCount >= 3` stuck-detector. Keep both guards when adding a flow.
- Fixed `setTimeout` sleeps are used everywhere instead of `waitForSelector` on the post-action state, because ELSTER re-renders asynchronously without stable markers. Timings are load-bearing.
- `log.*` writes to **stderr only** — stdout is the MCP stdio channel and must stay clean JSON-RPC.

### Config

`loadConfig()` merges, in precedence order: env var → `config.json` (path from `ELSTER_CONFIG_PATH`, default `./config.json`) → `DEFAULTS`. Result is cached in a module-level variable for the process lifetime; `resetConfigCache()` exists but nothing calls it. Never read `process.env` directly in flow code — add the key to `config.ts` and to `server.json`'s `environmentVariables` list.

`config.est.skipEurPreHook` / `ELSTER_EST_SKIP_EUR` is declared in config and documented but **not read anywhere** in the flows — dead config, not a working feature.

### Datenübernahme (carrying data over from an earlier submission)

After the year is picked on a form's entry page, ELSTER interposes
`/eportal/interpreter/fruehereAbgaben/<formSlug>-<year>`. `src/elster/datenuebernahme.ts` owns
this page; `ElsterBase.handleDatenuebernahme()` is the entry point all three flows call.

The page's contract, confirmed against the live portal:

- Each offered submission is a `<tr>` with five `<td>`s — Bezeichnung | Ordnungskriterium |
  Gesendet am | Profil | Aktionen — and a button `#uebernehmenButton_<aufgabeId>` whose
  `name="reqCmd"` value is `{"FruehereAbgabeCommand":{"aufgabeId":"…","onErrorUrl":null,"ignoreSkippableErrors":true}}`.
  Every cell is prefixed by a `.table-collapse__cellTitle` span holding the responsive column
  label — strip it before reading cell text.
- `#Continue` ("Ohne Datenübernahme fortfahren") is the opt-out and the default.
- When nothing matches, the table is replaced by a `._helper-infoEmpty` notice and only
  `#Continue` remains. Zero candidates is normal, not an error.
- Only the "Frühere Abgaben" tab is automated; the "XML-Import" tab is not.

`pickCandidate()` **throws** when the caller explicitly asked for a takeover that is not on
offer. Falling through to a blank form after the user asked to carry last year's data over
would silently produce a wrong return, so an unmet request must fail rather than degrade.

`ElsterBase.selectFormYear()` picks the year option by `<year>-` prefix rather than assuming
`<year>-v1` — older ESt years use `<year>-v_<year>`.

### Reading back what was submitted (`submissions.ts`)

"Meine Formulare" is not driven by page navigations but by ELSTER's own command
endpoint, and `ElsterSubmissions` talks to it directly instead of clicking modals:

```
POST /eportal/nachrichten
  headers: x-csrf-token: <meta[name="_csrf"]>, eopfetchtype: interactive
  body:    multipart with a single `reqCmd` field
  →        an HTML fragment
```

The fetch runs inside `page.evaluate` so the session cookie comes for free; the CSRF
token is read from the page's `_csrf` meta (or the hidden input). Commands used:

- `ViewMessageCommand{nachrichtId,urlId}` → the **Übertragungsprotokoll**, which already
  contains every submitted field. This is the one worth having.
- `DecryptModalCommand{nachrichtId,dokumentId}` → the same content as a PDF/HTML download.
  Deliberately unused: its buttons only exist *inside* the protocol fragment, so it costs a
  second round-trip for content already in hand.

Protocol markup is stable and worth parsing rather than screen-scraping text:
`.eoprint__page` is one form (its `<h1>` names it), `h2`–`h4` nest the section path, and
`table.eoprint__table` rows are `[Zeile, Label, Value]` — or `[Zeile, Value]` for checked
fields. The value cell's `<span data-name="id-N-ArbL-…-E0200204_usb1_1-1-1-1">` is **ELSTER's
own field id**, which is what `elster_est_start`'s `data` keys match against — so a parsed
protocol can be fed straight back into a new filing.

Two parsing traps, both already handled: header values contain colons
("Eingang auf Server: 31.07.2025, 23:32:07"), so meta labels are bounded by the *next label*,
not the next colon; and that scan must run on a copy with `.eoprint__page` /
`.eoprint__page__note` stripped, or the last label swallows the rest of the document.

## The form engine (`engine.ts` + `engine-driver.ts`) — use this for filling

The per-form click flows (`ustva.ts`, `eur.ts`, `est.ts`, `formfill.ts`) predate it and are
fragile. **New work goes through the engine**; it drives *any* ELSTER form over HTTP.

Why it works: the Online-Formular is a plain `application/x-www-form-urlencoded` POST to
`#form`'s `action`. Replaying it with `fetch` from inside the logged-in tab needs no clicks,
no modals and no sleeps:

| Part | Wire format |
|---|---|
| plain field | `fields[<name>]`; the name embeds the Kennzahl (`eruNWkHomeofficeE0204507`) |
| checkbox | value when checked, absent when not; `_fields[<name>]` marker always sent |
| new repeat-group row | `mzbs[<group>].newItem.fields[<name>]` + that group's `CreateMzbItem` command |
| command | `reqCmd` = JSON: `JumpToPage{target:{FormData-RID:{rid}}}`, `SwitchModus{target}`, `DeleteMzbItem`, `EditDetachedMzbSemIndex`, … |
| CSRF | `_csrf` form field (the modal endpoint wants header `x-csrf-token`) |

Every response is the next page's HTML including its navigation tree (`FormData://…` RIDs).
Validation errors come back in `.messageBox--error`; the HTTP status is always 200.

Pieces:

- `engine-driver.ts` — `installDriver()` is serialized into the page and defines
  `window.EO` (post/press/jump/fields/groups/nav/setFields/addRow/deleteRow/crawl/check/
  saveDraft/drafts/openDraft/newForm). Must stay self-contained (no imports/closures).
- `engine.ts` — `ElsterEngine` keeps **one** browser for the whole MCP process, logs in
  once, and serializes calls (the server-side form has a single cursor per session).
- `index.ts` exits when stdin closes, so the persistent browser does not outlive the client.

Invariants — do not weaken:

- **The tab is never navigated after login.** `form.submit()` / `location.href` from an
  evaluate left Chrome's renderer permanently hung twice; `fetch` never did. All page state
  lives in the parsed `EO.doc`.
- **The engine cannot send.** `ElsterEngine.assertCommand` and the driver's `guard` both
  refuse `target:"SENDEN"`, `Absenden`, `Senden`, `Übermittl…`, `DeleteEntwurfAufgabe`,
  `Logout`. Commands are **parsed and re-serialised before matching** (so `\u0053ENDEN`
  escapes are decoded) and must have exactly one command name; the canonical text is
  what gets posted. Checks stop at `SwitchModus{target:"PRUEFEN"}`.
- **One narrow exception, approved by the user on 27.09.2026:** `elster_form_review` enters
  the "Formular absenden" overview with the exact string
  `{"SwitchModus":{…"target":"SENDEN"…}}` (what a human's "Weiter" posts after a clean
  Prüfung), captures its eoprint markup and switches back to EINGABE in the same call.
  The flag that allows it lives in the driver's closure, not on `window.EO`. While the
  engine is on a `/versenden/` page, `post` accepts only EINGABE/PRUEFEN and `press` is
  refused outright — "Absenden" is `#defaultbutton` **without a value**, so it cannot be
  screened by command text. Do not widen any of this.
- Only one form can be open per ELSTER session. Opening a draft the server still holds
  lands on "kann nicht geöffnet werden"; `openDraft` re-enters via its SwitchModus button.

Portal facts learned the hard way:

- Money fields labelled "(Euro)" take **whole euros only** ("Volle Geldbeträge müssen als
  Ziffernfolge ohne Dezimaltrenner eingetragen werden"); "(Euro, Cent)" fields take `3,36`.
  Anlage N is whole-euro, Anlage EÜR is euro-and-cent.
- Detached repeat groups (e.g. `Entfernungspauschale[0]/MZBErsteTaetigkeitsstaette[0]`)
  are sub-pages; jumping to index `[n]` creates entry n, then set its fields there.
- A new Anlage for a person: `EditDetachedMzbSemIndex{target: VAnlageX[0], semanticIndex:"PersonA"}`.
- Anlage KAP "Überprüfung des Steuereinbehalts" (E1900501) requires both Sparer-Pauschbetrag
  lines (E1901401, E1901402), even when both are 0.
- Drafts: `/eportal/meineformulare`, buttons `oeffneEntwurf_<aufgabeId>` →
  `OeffneAufgabeCommand{aufgabeId}`.

Testing: `node tools/engine-selftest.mjs` (after `npm run build`) checks the safety guards
offline in a headless Chrome — escaped/compound send commands, the /versenden/ lock,
amount parsing, ambiguous takeovers. No ELSTER login needed; run it after touching the
guards. Beyond that there is no test suite. `tools/mcp-call.mjs '[["tool",{args}],…]'` calls the
built server over stdio exactly like an MCP client (needs the `ELSTER_*` env, e.g. from
`~/.elster/run-mcp.sh` minus its `exec` line); `MCP_CALL_FULL=1` disables output truncation.

### Kennziffer / field mapping

`src/elster/constants.ts` is the single source of truth for what gets filled where:

- `KENNZIFFERN` — supported UStVA codes plus `NET` (Bemessungsgrundlage) vs `TAX` (tax amount) semantics. Exposed verbatim via `elster_kennziffern_list`.
- `USTVA_PAGE_KZ_MAP` — ELSTER page slug (last URL segment) → which codes live on that page. `walkThroughPages` fills only what this map says a page contains, so a new Kennziffer needs an entry here or it is silently skipped.
- `EUR_FIELD_MAP` — friendly field name → candidate German labels + `KzNNN` patterns for the EÜR form.
- `PORTAL_URLS` — all portal entry points.

### XML

`src/elster/xml.ts` generates a UStVA XML **snapshot for archiving only**. It is never transmitted and is not ERiC-valid (`HerstellerID` is a placeholder). `detectReverseCharge` there reads `config.ustva.reverseChargeSuppliers` regexes and falls back to explicit reverse-charge phrase matching.

## Publishing

The package is registered on the MCP Registry. `package.json` version, `server.json` `version`, **and** `server.json` `packages[0].version` must be bumped together — they are cross-validated by the registry schema. `mcpName` in `package.json` must match `name` in `server.json`.

## Repo hygiene

`config.json`, `*.pfx`, `*.p12`, `screenshots/`, `downloads/` are gitignored and hold real tax credentials. Never read a user's `config.json` contents into the conversation, and use `elster_config_show` (which redacts the password) as the model for any new config-inspecting output.
