# elster-mcp-server

An MCP server that lets Claude (or any MCP client) fill in **any** form on the German tax
portal [ELSTER](https://www.elster.de): Einkommensteuer with all its Anlagen, EÜR, UStVA,
and whatever else the portal offers. You talk through your return; the agent enters it,
runs ELSTER's own checks and shows you exactly what would be transmitted.

**It cannot submit.** When the return is ready, it opens it for you in a visible browser
window on the "Formular absenden" page. You read it, and you click "Absenden".

## What it can do

- **Fill any form by Kennzahl.** Fields, checkboxes, table rows and sub-pages, through the
  same HTTP requests the portal's own page sends. No screen scraping, no brittle clicks.
- **Start or continue.** New forms with the Anlagen you pick, drafts from "Meine
  Formulare", carrying over last year's submission, importing the pre-filled data the
  tax office already holds (Lohnsteuerbescheinigung, Vorsorge, …).
- **Check with ELSTER itself.** "Prüfen" returns the portal's errors and hints with the
  pages that cause them, plus the provisional result ("Erstattung: 1.655,21 €").
- **Review before sending.** Reads the final "Formular absenden" overview row by row,
  including where each value came from (Bescheinigung, Profil, Beleg, earlier filing).
- **Receipts.** Uploads PDFs and images to "Meine Belege" with their Belegart and amounts.
- **Your history as context.** Lists past submissions and reads their
  Übertragungsprotokoll field by field, so last year's return can inform this year's.
  Also reads the ELSTER inbox (Bescheide) and "Übermittelte Formulare".
- **Hand off.** Opens the finished form for you to send. See [Safety](#safety).

## Safety

Sending a tax return is your electronic signature. This server is built so that nothing
it runs can do it.

- **Allowlist, not blocklist.** Every form command is parsed, must name exactly one
  command, and that command must be on a fixed list of editing and checking commands.
  Anything else, including commands nobody has seen yet, is refused. Send, delete draft,
  delete receipt and log out are not on the list.
- **The send page is locked.** The engine may look at the "Formular absenden" overview
  (`elster_form_review`), but while it is there it can only switch back to editing.
- **Handoff instead of a send button.** `elster_form_handoff` opens the form in a
  separate, visible browser, moves it to "Formular absenden", and then *disconnects*
  from that window. The MCP keeps no handle on it, so no tool call, token or flag can
  click "Absenden", not even with an agent running in a permissive mode. Your mouse is
  the only way to send.
- **Offline self-test.** `node tools/engine-selftest.mjs` checks the guards against
  escaped, compound and disguised send commands in a headless Chrome, without logging in.

## Quick start

Requirements: Node.js ≥ 18, your ELSTER certificate file (`.pfx`) and its password.

```bash
git clone https://github.com/Infraviored/elster-mcp-server.git
cd elster-mcp-server
npm install          # also downloads a bundled Chromium (~150 MB)
npm run build
cp config.example.json config.json   # set auth.pfxPath and auth.password
```

Register it with your client, e.g. Claude Code:

```bash
claude mcp add elster -e ELSTER_CONFIG_PATH=$PWD/config.json -- node $PWD/dist/index.js
```

or Claude Desktop (`claude_desktop_config.json`, template in `examples/`):

```json
{
  "mcpServers": {
    "elster": {
      "command": "node",
      "args": ["/absolute/path/to/elster-mcp-server/dist/index.js"],
      "env": { "ELSTER_CONFIG_PATH": "/absolute/path/to/elster-mcp-server/config.json" }
    }
  }
}
```

Then just ask: *"Mach meine EÜR 2025. Hier sind meine Rechnungen …"* and run
`elster_login_test` once if you want to confirm the certificate works first.

## A typical session

```text
elster_form_new    { form: "est", year: 2025,
                     anlagen: ["VHauptvordruck", "VAnlageN", "VAnlageVor"] }
                   → eDaten imported, lands on the Startseite, returns the page tree
elster_form_page   { rid: "FormData://est-2025-v1/…/VAnlageN[0]/HomeofficePauschale[0]" }
                   → fields with Kennzahl, label, current value
elster_form_set    { values: { E0204507: 81 } }
elster_form_add_row{ group: "AufwendungenArbeitsmittel",
                     values: { E0204401: "Bürostuhl", E0204402: 429 } }
elster_form_check  → { ok: true, result: ["Erstattung: 1.655,21 €"] }
elster_form_review → every row that would be transmitted, with its source
elster_form_handoff→ a browser window opens on "Formular absenden" — you click
elster_form_handoff_wait
                   → returns when you close the window: Transferticket,
                     protocol saved as HTML + PDF
```

## Tools

| Group | Tool | What it does |
|---|---|---|
| Forms | `elster_form_new` | Starts any form: year, Datenübernahme, Anlagen, eDaten import |
| | `elster_drafts_list` / `elster_form_open` | Lists saved drafts / opens one |
| | `elster_form_page` / `elster_form_crawl` | Reads one page / walks a whole form (fields, repeat groups, navigation) |
| | `elster_form_set` | Sets fields by Kennzahl or full field name |
| | `elster_form_add_row` / `elster_form_delete_row` | Adds or removes table rows |
| | `elster_form_attach` | Uploads PDF/XML files into a form's attachments (e.g. Einspruch "Anhänge") |
| | `elster_form_press` | Escape hatch for other allowlisted form commands |
| | `elster_form_save` | Saves the form as a draft and closes it |
| Check | `elster_form_check` | Runs "Prüfen": errors, hints, provisional result |
| | `elster_form_review` | Reads the "Formular absenden" overview row by row |
| | `elster_form_handoff` | Opens the form on "Formular absenden" in a visible window; **you** send |
| | `elster_form_handoff_wait` | Waits until you close that window; if you sent, saves the transmission protocol as HTML + PDF |
| Data | `elster_edaten_fetch` | Pre-filled data the tax office holds for a year |
| | `elster_datenuebernahme_list` | Earlier submissions a new form can carry over |
| | `elster_belege_list` / `elster_beleg_upload` | Lists / uploads receipts in "Meine Belege" |
| History | `elster_submissions_list` / `elster_submission_protocol` | Past submissions and their full transmitted content |
| | `elster_submission_archive` | Saves a submission's Übertragungsprotokoll as HTML + PDF, as proof |
| | `elster_sync_history` / `elster_sync_inbox` | "Übermittelte Formulare" and the inbox, optionally with PDFs |
| Setup | `elster_login_test` / `elster_config_show` | Checks the login / shows the config (password redacted) |
| UStVA helpers | `elster_kennziffern_list`, `elster_ustva_detect_reverse_charge`, `elster_ustva_generate_xml` | Kennziffer reference, §13b detection, XML snapshot for your archive (never transmitted) |

## How it works

The ELSTER Online-Formular is an ordinary HTML form. Every "Nächste Seite", every table
row and every "Prüfen" is a `POST` of `fields[<name>]` values plus a JSON command
(`reqCmd`), and the response is the next page. The server logs in once with Puppeteer and
then replays exactly those requests with `fetch` from inside the logged-in tab. The tab
itself is never navigated again, which keeps it fast and immune to the portal's modals.

Field names embed ELSTER's Kennzahl (`…HomeofficeE0204507`), so the agent addresses
fields by the numbers printed on the paper form. Details, wire format and the portal
quirks learned along the way are in [`CLAUDE.md`](CLAUDE.md) and
[`MCP-FINDINGS.md`](MCP-FINDINGS.md).

## Configuration

`config.json` (path via `ELSTER_CONFIG_PATH`, default `./config.json`); every key can be
overridden by an environment variable: `ELSTER_PFX_PATH`, `ELSTER_PASSWORD`,
`ELSTER_HEADLESS`, `ELSTER_DOWNLOAD_DIR`, `ELSTER_SCREENSHOT_DIR`, and the taxpayer and
§13b supplier settings used by the UStVA helpers (see `config.example.json`). Env vars
win over the file. `config.json`, `*.pfx`, `downloads/` and `screenshots/` are gitignored;
they hold real credentials and tax data.

## Limitations

- One form can be open per ELSTER session; save before switching (`elster_form_save`).
- The session ends after about 30 idle minutes. The server logs in again by itself, but
  an unsaved form is then only in ELSTER's own recovery. Save before long pauses.
- Money fields labelled "(Euro)" take whole euros only; "(Euro, Cent)" take `3,36`.
- This drives the web portal, not ERiC. Official programmatic submission needs the ERiC
  library and registration as a software vendor.

## Legal notice / Rechtlicher Hinweis

**English**

- This project is an **experimental, community-built tool**. It is **not affiliated with, endorsed by, or supported by** the Bundesministerium der Finanzen, the ELSTER project, or any tax authority.
- The official, supported way to submit tax data programmatically is the **ERiC library** (registration as a software vendor required). This tool instead automates the public ELSTER **web portal** with a real user session — the same path a human user takes — using credentials YOU provide.
- The official ELSTER **terms of use ("Nutzungsbedingungen")** may restrict automated access to the portal. Whether your specific use is permitted is **your responsibility to verify** before running this software.
- **Use at your own risk.** The author(s) provide this software **AS IS, WITHOUT WARRANTY OF ANY KIND** (see [LICENSE](LICENSE)). The author(s) **accept NO liability** for incorrect tax submissions, account suspensions, missed deadlines, lost data, or any other consequences arising from the use of this software.
- This project is **not tax advice** (no "Hilfeleistung in Steuersachen" in the sense of § 2 StBerG). If you are unsure whether a submission is correct, consult a *Steuerberater*.
- Operators using this software in a **commercial context** (e.g. submitting on behalf of third parties) may be subject to the German *Steuerberatungsgesetz* and must verify their own licensing situation.

**Deutsch**

- Dieses Projekt ist ein **experimentelles, von der Community gebautes Werkzeug**. Es ist **weder vom Bundesministerium der Finanzen noch vom ELSTER-Projekt noch von einer Finanzbehörde unterstützt, autorisiert oder geprüft**.
- Der offizielle, vom BMF unterstützte Weg zur programmatischen Übermittlung von Steuerdaten ist die **ERiC-Bibliothek** (Registrierung als Softwarehersteller erforderlich). Dieses Tool nimmt stattdessen den Weg über das öffentliche **ELSTER-Webportal** — denselben Weg, den ein menschlicher Nutzer per Browser geht — mit Zertifikatsdaten, die DU bereitstellst.
- Die offiziellen **ELSTER-Nutzungsbedingungen** können automatisierten Zugriff auf das Portal einschränken oder verbieten. Es liegt **in deiner alleinigen Verantwortung** zu prüfen, ob dein konkreter Anwendungsfall erlaubt ist, bevor du dieses Tool nutzt.
- **Nutzung auf eigenes Risiko.** Die Autor:innen stellen die Software **OHNE JEGLICHE GEWÄHRLEISTUNG** bereit (siehe [LICENSE](LICENSE)). Die Autor:innen übernehmen **keine Haftung** für fehlerhafte Steuerübermittlungen, gesperrte Konten, versäumte Fristen, Datenverluste oder sonstige Folgen aus der Nutzung dieser Software.
- Dieses Projekt ist **keine Steuerberatung** im Sinne des § 2 StBerG. In Zweifelsfällen ist ein:e Steuerberater:in zu konsultieren.
- Wer diese Software **gewerblich** einsetzt (z.B. Übermittlung im Auftrag Dritter), unterliegt unter Umständen dem Steuerberatungsgesetz und muss seine Berechtigung selbst sicherstellen.

## Origin

This project started as a fork of
[lukasschwarz/elster-mcp-server](https://github.com/lukasschwarz/elster-mcp-server) by
Lukas Schwarz, which automated UStVA, EÜR and ESt by clicking through the portal. The
form engine replaced that approach entirely, so the fork was detached into its own
repository. Thanks to Lukas for the groundwork (login, submission history, inbox sync);
his MIT copyright notice is kept in [LICENSE](LICENSE).

## Contributing

Issues and PRs are welcome. Most useful: reports of forms or pages the engine does not
handle yet (the output of `elster_form_page` on that page helps), and selftest cases for
the guards. Run `npm run build && node tools/engine-selftest.mjs` before sending a PR
that touches `engine.ts` or `engine-driver.ts`.

## License

[MIT](LICENSE)
