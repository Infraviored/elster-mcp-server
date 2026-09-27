# elster-mcp-server

A **Model Context Protocol (MCP) server** that lets Claude (or any MCP-capable client)
drive the German tax portal [ELSTER](https://www.elster.de) via Puppeteer.

---

## ⚖️ Legal Notice / Rechtlicher Hinweis

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

**Practical safeguards built into the tool**

- The only tool that actually transmits data is `elster_ustva_confirm` — it requires an **explicit second call** after `elster_ustva_start` has paused at `AWAITING_CONFIRM`. Nothing is sent without that second confirmation.
- The EÜR and ESt tools **never submit**. They only fill the form up to "Prüfen" and stop, so you review and submit yourself in the ELSTER portal.
- All sync / history / inbox tools are read-only and never modify state on the ELSTER side.

---

## Features

| Tool | What it does | Submits? |
|------|--------------|----------|
| `elster_login_test` | Verifies your certificate + password can log in | No |
| `elster_config_show` | Shows the loaded config (secrets redacted) | No |
| `elster_kennziffern_list` | Returns the supported UStVA Kennziffern with descriptions | No |
| `elster_ustva_generate_xml` | Generates a UStVA XML snapshot (archive only) | No |
| `elster_ustva_detect_reverse_charge` | Detects §13b reverse-charge suppliers | No |
| `elster_datenuebernahme_list` | Lists earlier submissions ELSTER offers to carry over into a new form | No |
| `elster_ustva_start` | Logs in, fills, runs Prüfung, then **pauses for confirmation** | Pauses |
| `elster_ustva_confirm` | Clicks "Absenden" after you reviewed | **Yes** |
| `elster_eur_start` | Fills Anlage EÜR up to Prüfung, then "Speichern und Verlassen" | No |
| `elster_est_start` | Opens ESt 1 A, fills basics, runs Prüfung, keeps browser open 30 min | No |
| `elster_submissions_list` | Lists submitted forms with their nachrichtId / aufgabeId | No |
| `elster_submission_protocol` | Reads the full field-level content of past submissions | No |
| `elster_sync_history` | Reads "Übermittelte Formulare" (optionally with PDFs) | No |
| `elster_sync_inbox` | Reads ELSTER inbox (optionally with PDFs) | No |
| `elster_session_status` / `_list` / `_cancel` | Session management | No |
| `elster_drafts_list` | Lists saved drafts with their aufgabeId | No |
| `elster_form_new` / `elster_form_open` | Starts a new form (any type) or opens a draft in a persistent session | No |
| `elster_form_page` / `elster_form_crawl` | Reads a page / walks a whole form: fields by Kennzahl, repeat groups, navigation | No |
| `elster_form_set` / `_add_row` / `_delete_row` | Fills fields and table rows by Kennzahl | No |
| `elster_form_press` | Escape hatch for other form commands (send/delete refused) | No |
| `elster_form_check` / `elster_form_save` | Runs "Prüfen" (incl. provisional tax result) / saves the draft | No |

## Requirements

- **Node.js ≥ 18**
- An **ELSTER certificate file** (`.pfx`) — get it from `https://www.elster.de` → "Mein ELSTER" → "Mein Benutzerkonto" → "Zertifikat verlängern"
- The certificate password
- Your **Steuernummer** and **Bundesland-Code**

## Install

```bash
git clone https://github.com/YOUR_USERNAME/elster-mcp-server.git
cd elster-mcp-server
npm install
npm run build
```

Puppeteer will install a bundled Chromium on first install (~150 MB).

## Configuration

```bash
cp config.example.json config.json
$EDITOR config.json
```

All keys in `config.json` can be overridden by environment variables
(`ELSTER_PFX_PATH`, `ELSTER_PASSWORD`, `ELSTER_TAX_NUMBER`,
`ELSTER_STATE_CODE`, `ELSTER_NAME`, `ELSTER_FIRST_NAME`, `ELSTER_STREET`,
`ELSTER_HOUSE_NUMBER`, `ELSTER_ZIP`, `ELSTER_CITY`, `ELSTER_COUNTRY`,
`ELSTER_DOWNLOAD_DIR`, `ELSTER_SCREENSHOT_DIR`, `ELSTER_HEADLESS`,
`ELSTER_EST_SKIP_EUR`). Env vars win over the file.

You can also point the loader at a different config file via
`ELSTER_CONFIG_PATH=/path/to/your/config.json`.

The two-digit `stateCode` for your Finanzamt is published by ELSTER —
look up the current value in the official ELSTER documentation.

### Reverse-Charge supplier list

Add your `§13b UStG` suppliers under `ustva.reverseChargeSuppliers` in
`config.json`. Patterns are case-insensitive regexes matched against the
voucher's `contactName` or `description`. Example entry:

```json
{ "pattern": "your-supplier\\s+ireland", "region": "EU", "name": "Your Supplier Ireland" }
```

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "elster": {
      "command": "node",
      "args": ["/absolute/path/to/elster-mcp-server/dist/index.js"],
      "env": {
        "ELSTER_CONFIG_PATH": "/absolute/path/to/elster-mcp-server/config.json"
      }
    }
  }
}
```

See `examples/claude_desktop_config.json` for the template.

## Use with any MCP client

Run the server in stdio mode:

```bash
node dist/index.js
```

Then connect via your client's MCP transport.

## Typical UStVA flow

```text
1. elster_login_test                          → { ok: true }
2. elster_kennziffern_list                    → reference for valid codes
3. elster_ustva_start({                       → { sessionId: "ustva-..." }
     year: 2026,
     period: "Q1",
     report: { "81": 12000, "86": 300, "66": 1845.30 }
   })
4. elster_session_status({ sessionId })       → poll until status == AWAITING_CONFIRM
   (open the screenshot at screenshotPath to verify)
5. elster_ustva_confirm({ sessionId })        → { success: true, ticket: "..." }
```

## Typical EÜR flow

```text
1. elster_login_test
2. elster_eur_start({
     year: 2025,
     data: {
       betriebseinnahmen: 50000,
       fahrzeugkosten: 1200,
       afa: 800,
       homeOffice: 1260
     }
   })
3. elster_session_status (poll until SAVED or AWAITING_REVIEW)
4. open the ELSTER portal in your browser → "Meine Formulare" → review the draft → submit manually
```

## Datenübernahme (Vorjahresdaten übernehmen)

ELSTER can copy an earlier submission of the same form into a new one — the
"Datenübernahme" step it offers right after you pick the tax year. The three
`*_start` tools expose it through an optional `takeover` argument:

| `takeover` | Effect |
|---|---|
| omitted / `"none"` | Start from a blank form (default) |
| `"latest"` | Carry over the most recently sent submission |
| `2024` | Carry over that tax year's submission |
| `"537842781"` | Carry over that exact `aufgabeId` |

Check what is on offer first — this never fills or submits anything:

```text
elster_datenuebernahme_list({ form: "est", year: 2025 })
→ {
    "candidates": [
      { "aufgabeId": "537842781",
        "description": "ESt unbeschränkt (ESt 1 A) 2024, …",
        "sentAt": "31.07.2025 23:32 Uhr", "year": 2024 },
      …
    ]
  }

elster_est_start({ year: 2025, data: {}, takeover: 2024 })
```

If the requested submission is not on offer the call fails instead of quietly
starting a blank form — carrying nothing over when you asked for last year's
data would produce a wrong return. An empty candidate list is normal: ELSTER
only offers a takeover once a matching form has actually been submitted.

## Past submissions as context

`elster_submission_protocol` reads the "Übertragungsprotokoll" of returns you have
already filed — every field that was actually transmitted, with its Zeile number,
label, value and ELSTER field id, grouped by form and section:

```text
elster_submissions_list({ formFilter: "ESt unbeschränkt" })
→ [{ nachrichtId: { type: "a", id: 178614775 }, year: 2024,
     ordnungskriterium: "…", aufgabeId: "537842781", abgabeXmlId: 51359059 }, …]

elster_submission_protocol({ formFilter: "ESt unbeschränkt", years: [2024] })
→ { title: "Übertragungsprotokoll …",
    meta: { Finanzamt, Transferticket, "Eingang auf Server", … },
    sections: [ { form: "Anlage N (…)",
                  heading: ["Werbungskosten", "Aufwendungen für Arbeitsmittel"],
                  rows: [ { zeile: "5", label: "…", value: "…",
                            fieldId: "id-N-ArbL-…-E0200204_usb1_1-1-1-1" } ] } ] }
```

The `fieldId` is ELSTER's own identifier, which is exactly what `elster_est_start`'s
`data` keys are matched against — so last year's protocol can be read, adjusted and
fed back into this year's form.

Note that this returns real personal tax data (identification number, bank details,
income). It is read-only and never leaves your machine, but treat the output like the
tax return it is.

## Security notes

- **Never commit your `.env`, `config.json`, or `.pfx`.** They are gitignored by default.
- The certificate password is read from env / config and passed to Puppeteer — make sure
  the host running this server is trusted.
- Set `ELSTER_HEADLESS=false` once to watch the first run and confirm everything is wired correctly.

## Limitations

- The ELSTER portal selectors can change. If a flow breaks, run with `ELSTER_HEADLESS=false`
  and check the screenshots written to `./screenshots/`.
- The ESt tool is intentionally a thin wrapper — German income-tax forms (Anlage G, V, N, S, KAP …)
  are dozens of different forms with thousands of fields. This server provides the framework
  (login, open, fill-by-label-or-id, Prüfen) and leaves the field choices to you.
- No XML submission path. Official programmatic submission requires the ERiC library
  (registration as a software vendor). This server uses the same Online-Formular path
  that any taxpayer uses.

## License

[MIT](LICENSE)

## Contributing

PRs welcome. The most useful additions are:

1. More robust selectors for changed ELSTER pages
2. Pre-filled Anlage G / V / N / S templates for ESt
3. A typed `report` schema validator for `elster_ustva_*`

When opening an issue, please run with `ELSTER_HEADLESS=false` and attach the
screenshot under `./screenshots/` that shows the failure.
