# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # also downloads bundled Chromium (~150 MB)
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm start            # node dist/index.js (stdio MCP server)
```

No linter, no CI. `npm run build` (tsc) plus `node tools/engine-selftest.mjs` (offline guard tests) are the automated checks; see Testing under the form engine.

## Architecture

Single-process stdio MCP server that automates the ELSTER **web portal** with a real logged-in browser session. There is no ERiC submission path, and no code path that sends a return (see the form engine's invariants).

Layers:

1. **`src/index.ts`** — the whole MCP surface. `TOOLS[]` (JSON-schema tool declarations) and `dispatch()` (a single `switch`) are the only places tools are registered. Adding a tool means editing both, in the same file. Errors from `dispatch` are caught centrally and returned as `{ error }` with `isError: true`.
2. **`src/elster/engine.ts` + `engine-driver.ts`** — the form engine; all form filling goes through it (next section).
3. **Read-only portal readers**, each extending `ElsterBase` with its own short-lived browser: `submissions.ts` (history + protocols), `sync.ts` (Übermittelte Formulare, inbox), `edaten.ts` (pre-filled data), `datenuebernahme.ts` (takeover offers), `belege.ts` (receipts, used by the engine).
4. **`src/config.ts` + `src/logger.ts`** — process-wide singletons. `log.*` writes to **stderr only**; stdout is the MCP stdio channel and must stay clean JSON-RPC.

The readers still click through pages: `ElsterBase.handleModals()` after navigations (ELSTER interrupts with "Wiederaufnahme"/"Eingabefehler"/"Formular verlassen"; the German body-text substrings it matches are the contract) and fixed sleeps, because the portal re-renders without stable markers.

### Config

`loadConfig()` merges, in precedence order: env var → `config.json` (path from `ELSTER_CONFIG_PATH`, default `./config.json`) → `DEFAULTS`, cached for the process lifetime. Never read `process.env` directly — add the key to `config.ts` and to `server.json`'s `environmentVariables` list.

### Datenübernahme (carrying data over from an earlier submission)

After the year is picked on a form's entry page, ELSTER interposes
`/eportal/interpreter/fruehereAbgaben/<formSlug>-<year>`. `src/elster/datenuebernahme.ts` reads
this page for `elster_datenuebernahme_list`; the engine's `newForm` handles it over HTTP.

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

`ElsterBase.selectFormYear()` (used by the readers) picks the year option by `<year>-` prefix rather than assuming
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
own field id**; its `E…` Kennzahl is what `elster_form_set` takes, so a parsed protocol can
be fed straight back into a new filing.

Two parsing traps, both already handled: header values contain colons
("Eingang auf Server: 31.07.2025, 23:32:07"), so meta labels are bounded by the *next label*,
not the next colon; and that scan must run on a copy with `.eoprint__page` /
`.eoprint__page__note` stripped, or the last label swallows the rest of the document.

## The form engine (`engine.ts` + `engine-driver.ts`) — use this for filling

It drives *any* ELSTER form over HTTP. (It replaced per-form click flows for UStVA, EÜR and
ESt, which were removed on 28.09.2026.)

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
- **The engine cannot send or delete.** Commands go through an **allowlist**
  (`ALLOWED_COMMANDS` / `ALLOWED_MODES`, duplicated in `engine.ts` and `engine-driver.ts` —
  keep them in sync): a command is parsed and re-serialised (JSON escapes decoded), must
  have exactly one name, that name must be on the list, and `SwitchModus` may only target
  EINGABE, PRUEFEN, ANLAGENAUSWAHL, AUTOVAST_ENTRY or VAST. The canonical text is what gets
  posted. A text blocklist (send, übermittl, delete except DeleteMzbItem, lösch, logout,
  /sign, /rpc) additionally screens button ids, names, labels and values, and form actions.
  Do not "fix" a blocked flow by widening the blocklist logic; add the one command it
  needs to the allowlist, with a selftest case.
- **One narrow exception, approved by the user on 27.09.2026:** `elster_form_review` enters
  the "Formular absenden" overview with the exact string
  `{"SwitchModus":{…"target":"SENDEN"…}}` (what a human's "Weiter" posts after a clean
  Prüfung), captures its eoprint markup and switches back to EINGABE in the same call.
  The flag that allows it lives in the driver's closure, not on `window.EO`. While the
  engine is on a `/versenden/` page, `post` accepts only EINGABE/PRUEFEN and `press` is
  refused outright — "Absenden" is `#defaultbutton` **without a value**, so it cannot be
  screened by command text. Do not widen any of this.
- **Sending is the user's click, by construction.** `elster_form_handoff` saves the form,
  launches a *separate, visible* browser with its own login, opens the draft there via the
  driver, runs Prüfung, `goto`s the resulting page (so ELSTER's own signing scripts load)
  and clicks only the button whose value is exactly the SENDEN SwitchModus. Then it calls
  `browser.disconnect()`: the MCP keeps no handle on that window, so nothing it runs can
  click "Absenden" — not even in bypass mode, where any token or flag the server checks
  would be readable by the agent. Until that browser process exits, `withSession` refuses
  every engine call, because an engine re-login could end the user's session mid-sending.
  Do not add a code path that clicks "Absenden", with or without confirmation.
  `elster_form_handoff_wait` blocks until that process exits (or a timeout). `elster_form_handoff`
  snapshots the submission ids first; anything new afterwards is what the user sent, and its
  Übertragungsprotokoll is saved as HTML + PDF (`ElsterSubmissions.archive`, also exposed as
  `elster_submission_archive`). The agent learns the outcome without asking the user.
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
- Attachments (Einspruch "5 - Anhänge", group `anhang_mzb`): each file is POSTed as multipart
  `{file, reqCmd}` to the page URL, with `reqCmd` = the file input's `data-req-cmd`
  (`UploadMzbAnhang`) and the CSRF header named by `<meta name="_csrf_header">`. The JSON answer's
  `anhangData` (`anhangUploadData[<id>].*`) is appended to the next form post, which must be the
  "Hochladen starten" button (`CreateMzbAnhangItems`); any other command drops the uploads.
  `elster_form_attach` does this. PDF/XML only, 10 MB per file.
- Login goes straight to `/eportal/login/softpse` (~4 s). The old route via the start page and a
  no-longer-existing "Zertifikat" link cost ~20 s, half of it a selector timeout.
- Forms without a tax year (Einspruch) offer one form version (`23-v_23`) in `#zeitraumJahr`;
  `newForm` takes it.
- Drafts: `/eportal/meineformulare`, buttons `oeffneEntwurf_<aufgabeId>` →
  `OeffneAufgabeCommand{aufgabeId}`.

Testing: `node tools/engine-selftest.mjs` (after `npm run build`) checks the safety guards
offline in a headless Chrome — escaped/compound send commands, the /versenden/ lock,
amount parsing, ambiguous takeovers. No ELSTER login needed; run it after touching the
guards. Beyond that there is no test suite. `tools/mcp-call.mjs '[["tool",{args}],…]'` calls the
built server over stdio exactly like an MCP client (needs the `ELSTER_*` env, e.g. from
`~/.elster/run-mcp.sh` minus its `exec` line); `MCP_CALL_FULL=1` disables output truncation.

### Constants

`src/elster/constants.ts`: `KENNZIFFERN` (UStVA codes with `NET` Bemessungsgrundlage vs
`TAX` amount semantics, exposed via `elster_kennziffern_list`) and `PORTAL_URLS`.

### XML

`src/elster/xml.ts` generates a UStVA XML **snapshot for archiving only**. It is never transmitted and is not ERiC-valid (`HerstellerID` is a placeholder). `detectReverseCharge` there reads `config.ustva.reverseChargeSuppliers` regexes and falls back to explicit reverse-charge phrase matching.

## Publishing

The package is registered on the MCP Registry. `package.json` version, `server.json` `version`, **and** `server.json` `packages[0].version` must be bumped together — they are cross-validated by the registry schema. `mcpName` in `package.json` must match `name` in `server.json`.

## Repo hygiene

`config.json`, `*.pfx`, `*.p12`, `screenshots/`, `downloads/` are gitignored and hold real tax credentials. Never read a user's `config.json` contents into the conversation, and use `elster_config_show` (which redacts the password) as the model for any new config-inspecting output.
