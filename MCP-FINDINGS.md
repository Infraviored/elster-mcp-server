# MCP-FINDINGS

> **Stand 27.09.2026:** Die generische Engine ist gebaut und über echtes MCP getestet
> (`src/elster/engine.ts`, `engine-driver.ts`, Tools `elster_form_*` + `elster_drafts_list`).
> Die Prototypen `tools/probe.mjs`, `cdp.mjs`, `eo.mjs`, `eo-driver.js`, `capture.mjs`,
> `wake.mjs`, `live-browser.mjs`, `click.mjs` sind entfernt — ihr Wissen steckt im Code
> und in CLAUDE.md („The form engine"). Zum Testen bleibt `tools/mcp-call.mjs`.
> Die älteren Befunde unten zu Klick-Navigation (formfill.ts) sind damit überholt.


Gesammelt während der echten Nutzung für die ESt 2025. Kein Refactoring-Plan,
sondern was beim Arbeiten weh tat. Neueste zuerst innerhalb der Kategorien.

---

## BUGS — gefunden und noch offen

### B1. `parseEoprint` nimmt `.modal__title` vor `<h1>`
`src/elster/eoprint.ts`. Auf der Versenden-Seite gibt es kein Modal, aber wenn
eines offen ist (z. B. der Session-Timeout-Dialog), wird dessen Titel als
Dokumenttitel geparst und der Rest ignoriert. Ergebnis war zweimal
`title: "Ihre Sitzung läuft ab", rowCount: 0`.
**Fix:** Auf der Versenden-Seite `h1` bevorzugen; `.modal__title` nur für
Protokoll-Fragmente.

### B2. Session-Timeout-Modal wird von `handleModals` nicht erwischt
`src/elster/base.ts`. Der Zweig auf `Ihre Sitzung läuft ab` wurde ergänzt, hat
aber nicht gegriffen — vermutlich steckt der Dialog nicht in `document.body.innerText`
wie die anderen, oder er rendert erst nach dem Check.
**Fix:** `#extendSessionButton` unabhängig vom Body-Text prüfen, und einen
Keepalive einbauen (alle ~5 min eine Mausbewegung oder ein harmloser Klick),
weil lange Automatisierungsläufe zwangsläufig idle aussehen.

### B3. Checkbox-Auswahl per Substring trifft zu viel
`edaten.ts` hatte `VAnlageN` per `includes` gematcht und damit auch
`VAnlageNDHH` (doppelte Haushaltsführung) angehakt. Bereits auf exakte IDs
umgestellt, aber dieselbe Klasse Fehler steckt in `est.ts` `fillById`, das
weiterhin `(inp.id || inp.name).includes(hint)` benutzt.
**Fix:** Exakte-ID-Variante als Default, Substring nur explizit angefordert.

### B4. Entwürfe entstehen nur bei explizitem Speichern
Die Autospeicherung im Formular („Letzte automatische Speicherung vor: 0 min")
ist eine Sitzungs-Wiederherstellung, kein Entwurf. `handleModals` lehnt die
Wiederaufnahme beim nächsten Besuch mit „Nein" ab — damit ist alles weg.
Erst `Speichern und Formular verlassen` erzeugt einen echten Entwurf.
War ursprünglich falsch dokumentiert (ich hatte vier Entwürfe vermutet, es
waren null).
**Fix:** In `edaten.ts` bereits als `saveDraft` umgesetzt. Sollte für
`est.ts` / `eur.ts` genauso verfügbar sein, und `handleModals` sollte die
Wiederaufnahme nicht blind ablehnen, sondern konfigurierbar.

---

### B5. Zwei verschiedene ID-Systeme — der zentrale Stolperstein
Die Übertragungsprotokolle und die Versenden-Seite liefern **semantische**
IDs im `data-name`:

```
id-N-Wk-EP-Erste_Taetig-E0203503_usb1_1-1-1-1-1
id-ESt1A-Allg-E0101601_usb1_1-1-1-1
```

Das **Eingabeformular** benutzt dagegen seitenbezogene IDs:

```
Startseite(0)_fields(eruVorsatzZeitraum)
Startseite(0)_fields(eruESt1AArt_ErklE0100001)
```

Muster dort: `<Seitenname>(<Index>)_fields(eru<Abschnitt><Kennzahl>)`.

`document.getElementById(protokoll_id)` findet im Formular also **nie** etwas.
Genau daran ist der erste Füllversuch gescheitert (0 von N Feldern gesetzt).

**Die Brücke ist die Kennzahl.** `E0203503`, `E0100001`, `E0101601` kommen in
beiden Systemen vor. Ein Matcher muss also die Kennzahl aus der Protokoll-ID
extrahieren und im Formular nach einem Input suchen, dessen ID sie enthält —
plus den Wiederholungsindex, wenn es Mehrfachangaben gibt.

**Fix:** Helfer `kennzahlOf(protocolId)` plus `findInputByKennzahl(page, kz, idx)`.
Damit werden Protokolle zur Feldkarte für das Ausfüllen — der eigentliche
Mehrwert der ganzen Übung.

### B6. Navigationseinträge heißen anders als gedacht
Die Anlagen im Navigationsbereich sind Buttons mit IDs `VHauptvordruck`,
`MAVSAnlageN`, `MAVSAnlageG`, `MAVSAnlageKAP`, `VAnlageVor` — und der sichtbare
Text lautet `"Daten vorhanden: Anlagen N"`, nicht `"Anlage N"`. Die Textsuche
nach `startsWith("Anlage N")` schlug deshalb zweimal fehl (in `edaten.ts` und
`formfill.ts`).
**Fix:** Über die Element-ID navigieren, nicht über den Text. Das Präfix `MAVS`
markiert offenbar nachträglich hinzugefügte Anlagen, `V` die ursprünglichen.
Der Zusatz `"Daten vorhanden:"` zeigt an, dass eDaten dort etwas eingefüllt hat —
nützlich als Kontrolle.

### B7. Navigation zur Anlage ist zweistufig
`#MAVSAnlageN` führt nicht ins Anlage-N-Formular, sondern auf eine
**Auswahlseite**, auf der zwischen Anlage N, N-AUS, N-DHH und N-Gre gewählt
wird. Erst von dort geht es in die eigentlichen Eingabeseiten. Der
Discovery-Lauf fand deshalb nur 3 Felder statt der erwarteten ~60.
**Fix:** Nach `openNav` prüfen, ob eine Zwischenauswahl vorliegt, und die
gewünschte Anlage dort nochmal anklicken.

### B8. Navigation läuft über `reqCmd` + `JumpToPage`, nicht über Klicks — GELÖST

Der wichtigste Fund. Die Einträge im Navigationsbereich sind **Submit-Buttons**
eines einzigen Formulars `#form` (POST auf die eigene URL), deren `value` ein
JumpToPage-Kommando mit einer FormData-RID trägt:

```
name="reqCmd"
value={"JumpToPage":{"target":{"FormData-RID":
        {"rid":"FormData://est-2025-v1/Startseite[0]/MAVSAnlageN[0]"}},...}}
```

Weder `element.click()` aus `page.evaluate` noch ein echter `page.click()`
lösen die Navigation aus — beides bleibt wirkungslos. Was funktioniert:

```js
const btn  = document.getElementById('MAVSAnlageN');
const form = document.getElementById('form');
const h = document.createElement('input');
h.type = 'hidden'; h.name = 'reqCmd'; h.value = btn.value;
form.appendChild(h);
form.submit();
```

Danach steht die URL auf `/eingabe/est-2025/Startseite/MAVSAnlageN`.

**Die RID ist hierarchisch und spiegelt exakt die Feld-ID-Pfade:**

```
RID   FormData://est-2025-v1/Startseite[0]/MAVSAnlageN[0]/VAnlageN[0]
Feld  Startseite(0)_MAVSAnlageN(0)_VAnlageN(0)_fields(eru…E0203503)
```

Auf tieferen Seiten sind die Navigationsbuttons dann selbst nach ihrer RID
benannt (`id="FormData://est-2025-v1/Startseite[0]/MAVSAnlageN[0]/VAnlageN[0]"`),
was das Ansteuern beliebiger Formularseiten direkt ermöglicht.

Direkte URLs funktionieren **nicht** — `/eingabe/est-2025/AnlageN` und alle
Varianten liefern 404. Der Weg führt immer über JumpToPage.

**Konsequenz fürs MCP:** ein `jumpTo(rid)`-Primitiv ersetzt die gesamte
bisherige Klick- und Textsuch-Akrobatik. Damit ist jede Seite des Formulars in
einem Schritt erreichbar, statt sich über „Nächste Seite" durchzuhangeln.

### B9. `puppeteer.connect` hängt an einem toten about:blank-Target
Beim Wiederverbinden an einen laufenden Browser läuft `Network.enable` in den
Timeout, wenn ein zweites, hängendes Target existiert. `targetFilter` beim
`connect` half nicht zuverlässig.
**Fix:** Beim Parken nur ein einziges Tab offen lassen (`browser.pages()`
aufräumen), und `protocolTimeout` hochsetzen.

## STATUS AUSFÜLLEN — Stand 26.09.2026

Das automatische Befüllen der ESt **funktioniert noch nicht**. Offen sind B5
(Kennzahl-Matching), B6 (erledigt) und B7 (Zwischenauswahl). Jeder
Erkundungslauf kostet drei bis vier Minuten Portalzeit, und der Pfad ist
tiefer als angenommen:

```
alleformulare/est → Jahr → Datenübernahme → Anlagenassistent überspringen
→ Anlagenauswahl → eDaten-Import → Startseite des Formulars
→ Navigationsbereich → Anlagen-Zwischenauswahl → Anlage-N-Seiten
```

Solange das nicht steht, ist manuelles Eintragen aus einer vorbereiteten Liste
der schnellere und sicherere Weg. Die Automatisierung bleibt sinnvoll — aber
als eigenes Arbeitspaket, nicht unter Abgabedruck.

## LÜCKEN — was das MCP nicht kann

### L1. Kein Tool zum gezielten Befüllen einzelner Felder
`elster_est_start` nimmt `data` als Map von ID-Hinweisen und matcht per
Substring über alle Inputs. Für eine echte Anlage N mit Entfernungspauschale,
Reisekosten und Arbeitsmitteln ist das zu grob — man trifft Nachbarfelder.

Gleichzeitig ist die Lösung schon da: die Übertragungsprotokolle liefern die
**echten ELSTER-Feld-IDs** (`data-name="id-N-ArbL-LStB_1_5_Einz-E0200204_usb1_1-1-1-1"`).
**Idee:** `elster_form_fill({ year, form, fields: [{fieldId, value}] })` mit
exakter ID, plus Rückmeldung welche Felder gesetzt/nicht gefunden wurden.

### L2. Anlage G und Anlage EÜR sind nicht Teil des ESt-Flows
`eur.ts` füllt die Anlage EÜR als **eigenständiges Formular**. In der
Einkommensteuererklärung ist die EÜR aber eine Anlage. Anlage G gibt es
überhaupt nicht.
**Fix:** Anlagenauswahl (`VAnlageG`, `VAnlageEUER`) in den ESt-Flow ziehen,
`eur.ts` so umbauen, dass es sowohl standalone als auch als Anlage arbeitet.

### L3. Keine Anlage KAP
Vier Zahlen, aber gar nicht abgedeckt.

### L4. Kein Lesen des aktuellen Formularstands
Man kann füllen und prüfen, aber nicht „zeig mir was jetzt drinsteht".
`edaten.ts` `readReviewPage` ist der Anfang davon — sollte ein eigenes Tool
sein: `elster_form_review({ year })`.

### L5. eDaten nur über den Formular-Umweg
Fachlich korrekt (ELSTER bietet es nicht anders an), aber das Tool muss dafür
Anlagen auswählen und einen Entwurf erzeugen. Nebenwirkungsfrei geht es nicht.
Sollte in der Tool-Beschreibung deutlicher stehen.

---

## STRUKTUR — was ich anders bauen würde

### S1. `submissions.ts` parst eoprint selbst, statt `eoprint.ts` zu nutzen
Doppelte Implementierung derselben Logik. `eoprint.ts` wurde später extrahiert;
`submissions.ts` läuft noch auf der alten Kopie. Migrieren, sobald die ESt
durch ist — nicht vorher, weil der Pfad verifiziert funktioniert.

### S2. Feste `setTimeout`-Sleeps überall
Laut CLAUDE.md bewusst so, weil ELSTER ohne stabile Marker nachlädt. In der
Praxis kosten sie viel Wartezeit und provozieren das Session-Timeout (B2).
**Idee:** Ein `waitForStable(page, predicate, timeout)`, das pollt und dabei
`handleModals` aufruft — in `edaten.readReviewPage` schon so gemacht.

### S3. Sessions sind nur im Speicher
Serverneustart verliert alles. Für lange Formularsitzungen unschön.
Niedrige Priorität.

### S4. `config.est.skipEurPreHook` ist tot
In `config.ts` und `server.json` deklariert, nirgends gelesen. Entfernen oder
implementieren.

---

## KLEINKRAM

- `screenshotDir` / `downloadDir` sind relativ zum cwd des Serverprozesses.
  Bei Start über einen Wrapper landen Screenshots irgendwo. Sollte absolut
  aufgelöst oder relativ zum Config-Pfad sein.
- `puppeteer@23` ist deprecated, `npm audit` meldet 7 high severity.
- `elster_sync_history` liefert `description` als zusammengeklebten Rohtext.
  `elster_submissions_list` macht es richtig — das alte Tool sollte darauf
  umgestellt oder entfernt werden.

## B10 — Login-Button wurde per `button[type="submit"]` gesucht (behoben 27.09.2026)

`ensureLoggedIn` griff mit `page.$('button[type="submit"], …')` zu. ELSTER
rendert die Kopfzeilen-Icons (Chat, Suche, Kontrastmodus) ebenfalls als
`<button type="submit">`, und das erste Element in Dokumentordnung ist
`#chatLinkHeader`. Geklickt wurde also das Chat-Icon: die Seite lud neu, das
hochgeladene Zertifikat war weg, das Passwortfeld leer.

Symptom: Login endete auf `/eportal/login/softpse`, ohne Fehlermeldung im DOM.

Fix: `#bestaetigenButton` zuerst, Textsuche `=== 'Login'` als Fallback, und
niemals ein nacktes `button[type=submit]`.

## B11 — `ensureLoggedIn` gab bei Fehlschlag still `false` zurück (behoben 27.09.2026)

Kein Aufrufer prüfte den Rückgabewert. `tools/live-browser.mjs` schrieb
„LOGGED IN" und parkte anschließend auf der Login-Seite; `openForm` fand dort
keine Anlagen-Checkboxen und protokollierte nur „Anlagen not offered".
Der Fehlschlag wurde also erst drei Schritte später und mit falscher Ursache
sichtbar.

Fix: `ensureLoggedIn` wirft jetzt und nennt die erreichte URL.

## B12 — Login landet auf `/eportal/temporaereaufgaben` (behoben 27.09.2026)

Nach einer Sitzung ohne „Abmelden" schiebt ELSTER eine Zwischenseite ein:
„Formular wurde verlassen ohne zu Speichern … letzten Stand speichern?"
(`#temporaereaufgaben_ja_button` / `#temporaereaufgaben_nein_button`).
Die Erfolgsprüfung kannte die URL nicht und meldete einen Fehlschlag, obwohl
der Login durch war. Jetzt: als Erfolg werten, „Nein" klicken (der zuletzt
explizit gespeicherte Entwurf bleibt unverändert).

## B9 (Update) — puppeteer.connect hängt, Renderer friert ein

`puppeteer.connect` hängt in `Network.enable`, sobald ein Target nicht sauber
antwortet. Einmal fror zusätzlich der Renderer des ELSTER-Tabs komplett ein
(kein `Runtime.evaluate` mehr, kein Dialog offen); ein neuer Tab verlor die
Sitzung. Für Probes deshalb `tools/cdp.mjs`: rohes CDP auf dem Page-Socket,
ohne Puppeteer-Initialisierung.

## DURCHBRUCH 27.09.2026 — Formular-Engine per fetch statt Klicks

Das Online-Formular ist ein schlichter `application/x-www-form-urlencoded`-POST
an die `action` von `#form`. Wer ihn mit `fetch` nachbaut, fährt jedes
Formular ohne einen einzigen Klick, ohne Modals, ohne Timing.

Protokoll:

| Teil | Form |
|---|---|
| einfaches Feld | `fields[<name>]`, der Name enthält die Kennzahl (`eruNWkHomeofficeE0204507`) |
| Checkbox-Marker | `_fields[<name>]` |
| Tabellenzeile (Mzb) | `mzbs[<Gruppe>].newItem.fields[<name>]` + Befehl `CreateMzbItem` der Gruppe |
| Befehl | `reqCmd` = JSON, z. B. `{"JumpToPage":{"target":{"FormData-RID":{"rid":"…"}},…}}` |
| CSRF | `_csrf` als Formularfeld |
| Speichern | Modal per `POST /eportal/interpretermodal` (`SpeichernUndVerlassenModalCommand`, Header `x-csrf-token`, `eopfetchtype: interactive`) → darin `#saveAufgabe` = `{"SaveAufgabe":…}` |

Jeder POST liefert die nächste Seite als HTML, inkl. neuem Navigationsbaum
(alle `FormData://…`-RIDs der Ebene). Unterseiten von Mehrfachbereichen
(`MZBErsteTaetigkeitsstaette[0]`) sind eigene RIDs; ein Sprung auf `[n]` legt
den n-ten Eintrag an.

Validierung: Geldbeträge in der Anlage N **nur volle Euro** ohne Trennzeichen
(„Volle Geldbeträge müssen als Ziffernfolge ohne Dezimaltrenner eingetragen
werden"). Fehler stehen in `.messageBox--error`, nicht im Statuscode (immer 200).

Prototyp: `tools/eo-driver.js` (window.EO: jump, post, fields, inputs, nav,
crawl, addRow, setFields, saveDraft) + `tools/cdp.mjs` / `tools/eo.mjs`.
Ergebnis: komplette Anlage N 2025 in einem Lauf befüllt, zurückgelesen,
gespeichert.

Nächster Schritt für den MCP: `src/elster/engine.ts` mit genau dieser API und
generischen Tools `elster_form_read` / `elster_form_write` / `elster_form_crawl`
statt formularspezifischer Klick-Flows.

### Nachtrag Engine (27.09.2026)

- ESt 2025 vollständig per fetch-Treiber befüllt, Prüfung fehlerfrei, ELSTER-
  Erstattung weicht um weniger als 1 € von der eigenen Kontrollrechnung ab.
- Entwurf öffnen ohne Tab-Navigation: `POST /eportal/meinelster`
  `reqCmd={"OeffneLetztenEntwurfCommand":{"aufgabeId":N}}`. Hält der Server das
  Formular noch offen, kommt „Entwurf kann nicht geöffnet werden" mit einem
  SwitchModus-Button zum Wiedereintritt (`EO.enter`).
- Prüfen = `SwitchModus{target:"PRUEFEN"}`; die Antwort enthält direkt
  „Steuerberechnung (vorläufig) Erstattung: …". Senden wäre target "SENDEN" —
  der Treiber kennt diesen Befehl bewusst nicht.
- Neue Anlage anlegen: `EditDetachedMzbSemIndex{target:VAnlageX[0],semanticIndex:"PersonA"}`.
- Anlage KAP: Antrag Zeile 4 verlangt Angaben zum Sparer-Pauschbetrag in
  beiden Zeilen (E1901401 und E1901402), auch wenn beide 0 sind.
- **Tab nie selbst navigieren lassen** (`form.submit()`, `location.href`):
  zweimal hing danach der Renderer dauerhaft. Reines fetch hing nie.

## Engine im Echtbetrieb (EÜR 2025, 27.09.2026) — behoben

- **E1** `elster_form_set` gab die ganze Seite doppelt zurück (`fields` + `page`, inkl.
  Auswahllisten mit 40 Optionen) — ~8k Tokens pro Aufruf. Jetzt nur die gesetzten
  Felder mit Rücklese-Wert + Fehler. `add_row`/`delete_row`: nur Gruppe + Summenfelder.
- **E2** Eingaben außerhalb `fields[…]` waren unsichtbar und nicht setzbar — betrifft die
  Steuernummer (`stnrDialogs[dialogeruVorsatzStNr].steuernummer.bundesland|nummer`) und
  Finanzamts-Dialoge. `elster_form_page` listet sie jetzt als `otherInputs`; `set` nimmt
  jeden vollen Eingabenamen direkt.
- **E3** Schlüsselauflösung per Teilstring: `eruEUERAllgE6000602` traf auch
  `…_TID_eol`/`_PG_eol`/`_KOE_eol` → „ambiguous". Exakter Name gewinnt jetzt.
- „Profil verwenden" (`FillInProfile`) scheitert per HTTP mit „Angaben aus dem gewählten
  Profil konnten nicht übernommen werden" — Profilauswahl fehlt im Request. Umgehung:
  Steuernummer direkt über `stnrDialogs[…]` setzen.
- ELSTER-Validierung, die man vorher nicht sieht: „Art des Betriebs" max. 25 Zeichen;
  abweichender WJ-Beginn (E6000302) verlangt auch das Ende (E6000303).
- **E4 (behoben)** `elster_form_page`/`press` listen jeden Mehrfachbereich-Knopf
  (Add/Create/Delete je Gruppe) unter `commands` — auf der Gewinnermittlungsseite ~40
  Einträge, ~15k Tokens. `groups` deckt das ab; Mzb-Befehle aus `commands` filtern,
  leere Gruppen-Templates nur auf Wunsch.
- **E5 (behoben)** `add_row` meldet `rid: null`, wenn die Seite per Sprung erreicht wurde —
  `post()` setzt `lastRid` zurück, und die „Sie befinden sich hier"-Markierung fehlt auf
  manchen Seiten.
- EÜR 2025: Zeilen 106/107 (Entnahmen/Einlagen) sind **Pflicht** (§ 4 Abs. 4a S. 6 EStG),
  sonst Prüffehler — nicht nur bei Schuldzinsen.

  Fix E4: `commands` filtert Add/Create/Delete/Edit/Update/ClearMzbItems, Next/Previous
  und alle SwitchModus; Templates als `"E6002302: Bezeichnung"`; JSON ohne Einrückung.
  Gewinnermittlungsseite ~48k → 8,5k Zeichen. Fix E5: `lastRid` wird nur bei echten
  Navigationsbefehlen verworfen.

## Review-Tool `elster_form_review` (27.09.2026)

Die Absende-Übersicht ist nur per `SwitchModus{target:"SENDEN"}` erreichbar (ein GET auf
`/eportal/interpreter/versenden/<slug>` leitet sonst auf die Prüfseite zurück). Sie
enthält eoprint-Markup wie das Übertragungsprotokoll, inkl. Transferticket; Quelle steht
als `data-print-source` (report/profile/receipt/submission/any), Labels in `<th>`,
angekreuzte Felder als `<th class="…--checkedField">`. `eoprint.ts` versteht jetzt beides.

**Erster echter Fund:** ESt Zeile 65 (E0204901) stand auf „Ja". Das Feld fragt, ob die
Fahrten *mit Firmenwagen oder Sammelbeförderung* stattfanden — bei „Ja" dürfen keine
Fahrtkosten in Zeile 66 stehen, das FA hätte die PKW-Fahrtkosten gestrichen. Gesetzt worden war
es beim Ausfüllen ohne sichtbares Label (Radio „Ja/Nein"). ELSTERs Prüfung meldet das
**nicht** und die Vorberechnung ändert sich nicht — nur das Review zeigt den Fragetext.
Lehre: vor dem Absenden immer `elster_form_review` und jede Ja/Nein-Zeile lesen.

Offen (klein): `labelOf` liefert bei Radios das Options-Label („Ja") statt der Frage.

## Belege-API „biber" (27.09.2026, per Chrome beobachtet, noch nichts hochgeladen)

REST unter `/eportal/biber/v2`, OpenAPI-generierter Client in `/eportal/scripts/amsel-lib.js`
(öffentlich, ~6,7 MB). Header `X-CSRF-TOKEN` (aus `meta[name=_csrf]`), JSON.

- `GET /config` → maxUploadGroesse 10 MB, maxAnzahlSeitenProBeleg 100, ocrTimeoutMillis 60000,
  documentModelVersion je VZ (2025: branch 1, revision 1.5)
- `GET /belege` → Liste; `GET/PUT/DELETE /belege/{id}`; `POST /belege` legt an
- `POST /attachment/upload` (multipart `file`) → `{attachmentId, uploadedFile, thumbnailSmall, thumbnailBig}`
- `POST /belegerkennung` (OCR-Vorschlag), `GET /personen|/mietobjekte|/stichwoerter|/veranlagungszeitraeume|/quota`
- Beleg: `{label, profil:{typ:"PERSON",id}, stichwortListe, documentModelVersion, document, seiten[]}`;
  `document` = Base64(JSON) `{"BibER_Belege":{"Belegart":"N/Arbeitsmittel","IdNr_StPfl":"…",
  "Veranlagungszeitraum":"2024","N":{"Arbeitsmittel":{"Art_der_Arbeitsmittel":"…","Betrag":281.08}}}}`.
  Belegart bestimmt die Formularstelle (gesehen: N/Arbeitsmittel, N/Weitere_Wk/Sonst, N/Fortb).
  `einfuellbareAngaben` = Werte, die „Verfügbare Belege übernehmen" (AUTOVAST) einfüllen kann.
- Seite: `{clientId, hOcr, textErkennungUebersprungen, angaben}`. Offen: wie PDF → Seitenbilder
  (vermutlich clientseitig) und wie clientId ↔ attachmentId verknüpft wird → einen echten Upload
  mitschneiden, dann `elster_beleg_upload` bauen.
- Belege sind für die ESt nicht Pflicht (Belegvorhaltepflicht seit VZ 2017).

## Beleg-Verknüpfung (27.09.2026) — verstanden und erprobt

- Jedes Formularfeld hat ein verstecktes Gegenstück `fieldsReceipt[<name>]` bzw. in
  Tabellenzeilen `mzbs[<Gruppe>].items[<n>].fieldsReceipt[<name>]`. Wert = **Beleg-ID** aus
  „Meine Belege" (z. B. `11190000`). Portal-Code: `e.hidden.value = String(e.receipt.id)`.
- Verknüpfen = diesen Wert per `elster_form_set` (voller Name) setzen; Lösen = leeren.
  Review zeigt danach Quelle „Beleg" (M-Symbol). Erprobt an einem Arbeitsmittel-Beleg, danach wieder gelöst.
- **Nur verknüpfte Belege gehen mit der Erklärung ans Finanzamt** (Belegreferenzierung
  seit 26.11.2024, ab VZ 2023). Hochladen allein übermittelt nichts.
- Hauptvordruck Abschnitt 10 hat nur „Belege werden nachgereicht" (E0100012).
- `elster_beleg_upload` / `elster_belege_list` gebaut, Format per Mitschnitt verifiziert
  (Body-Felder, `pdf`/`thumbnail` roh Base64), aber der MCP-Upload selbst ist noch **ungetestet**.

## E6 (behoben) — abgelaufene Sitzung nicht erkannt

Nach ~30 min Leerlauf leitet ELSTER auf `/eportal/javaScriptTest?parentPageUrl=…` um; die
Engine erkannte nur login|start und prüfte bei Fehlern gar nicht. Jetzt: Muster erweitert,
und schlägt ein Aufruf fehl, fragt sie `/eportal/meinelster` ab und loggt bei toter Sitzung
neu ein (einmal).

## E7 — aufgabeId ist nicht stabil

Der ESt-Entwurf bekam beim Speichern nach einer abgelaufenen Sitzung eine neue ID
(6433xxxxx → 6434xxxxx). IDs nie dauerhaft speichern; vor dem Öffnen `elster_drafts_list`.

## Absenden = clientseitige XML-Signatur (27.09.2026, aus Netzwerk-Log der echten ESt-Abgabe)

Nach „Absenden" läuft ein Signierprozess unter `/eportal/sign/<xmlDataId>`:
1. `POST /eportal/rpc` `GetSymmKeyForSavedPFXDataRpcHandler` — Schlüssel für das beim
   Login im Browser gespeicherte (verschlüsselte) Zertifikat.
2. `POST /eportal/sign/update` (xmlDataId), `POST /eportal/rpc` `newXmlDataRpchandler`
   (xmlDataId, clientTechnology=JavaScript) → zu signierende Daten.
3. Browser signiert lokal: xmlDigestMethod sha256, xmlSignatureMethod
   `xmldsig-more#sha256-rsa-MGF1` (RSA-PSS), schickt `newSendAuftragRpcHandler` mit
   Digest, Signatur, Zertifikat.
4. `GET /eportal/sign/finish/<xmlDataId>` → `/interpreter/sendenabgeschlossen/<slug>` →
   `/interpreter/alternativeversandbestaetigung/<slug>`.
Transport: `Content-Type: application/octet-stream`, `Accept: application/elster-payloadcontainer`,
Body-Format `N\nkey.<len>s<value>` je Zeile; CSRF über `GET /eportal/urlGetCsrfToken`.

**Bewusst nicht implementiert.** Absenden ist die elektronische Unterschrift des
Steuerpflichtigen unter die Versicherung „wahrheitsgemäß nach bestem Wissen". Die Engine
füllt, prüft und zeigt die Übersicht (`elster_form_review`); den Klick macht der Mensch.
Die Guards sperren SENDEN weiterhin; `/eportal/sign/` und `/eportal/rpc` werden von der
Engine nie angesprochen.

## Code-Review 27.09.2026 — alle 7 Befunde behoben

1. Sende-Sperre per JSON-Escape umgehbar (`\u0053ENDEN`) und auf /versenden/ durch ein
   zweites `"target":"EINGABE"` im selben Befehl → Befehle werden geparst, kanonisch
   serialisiert, genau ein Befehlsname; auf /versenden/ nur `SwitchModus` EINGABE/PRUEFEN.
2. `Betrag "12.99"` wurde 1299 → `parseAmount`: deutsch, englisch mit 1–2 Nachkommastellen,
   mehrdeutiges „1.234" wird abgelehnt.
3. `takeover=<Jahr>` nahm bei mehreren Abgaben die erste → Fehler mit Liste der aufgabeIds.
4. `press()`/`load()` vergaßen die gemerkte RID nicht → stale RID nach Formularwechsel.
5. `setFields` ohne RID speicherte per NextPage und las die falsche Seite → verweigert jetzt.
6. „Schon eingeloggt" kannte `/eportal/meinelster` nicht.
7. `elster_edaten_fetch` meldete fälschlich einen angelegten Entwurf.

Abgesichert durch `tools/engine-selftest.mjs` (offline, 23 Prüfungen).

## Conductor-Review Runde 1 (Gemini 3.8 Flash) — umgesetzt

Blocklist war nicht dicht: `press()` prüfte Knopfwerte nur bei `name="reqCmd"`; `/Senden/`
case-sensitiv (`senden`, `Send`, `SendAufgabe` durch); Löschen nur als
`DeleteEntwurfAufgabe` erkannt (nicht `loescheEntwurf_<id>`, `DeleteAufgabe`); `/versenden/`
nur mit Slash. → **Erlaubnisliste** für Befehlsnamen und SwitchModus-Ziele, Textsperre als
zweite Linie für ids/Namen/Beschriftungen/Werte und Form-Actions (`/sign`, `/rpc`).
Außerdem: `belegeList`/`belegUpload` laufen über den Neu-Login (`withSession`),
`JumpToPage` per `post` setzt die gemerkte RID, `press` mit buttonId+command wird
abgelehnt, `review()` verlässt die Absendeseite im `finally`, `CSS.escape` im Legacy-Filler.
Nicht übernommen: „Re-Login übersprungen, weil page.url() auf meinelster bleibt" —
`ensureLoggedIn` navigiert per `page.goto(start)` bevor es die URL prüft.
Selftest: 45 Prüfungen offline; Live-Smoke gegen ELSTER bestanden.

## Conductor-Review Runde 2 — umgesetzt

Senden/Löschen/Support laut Reviewer dicht. Gefunden und behoben:
- `elster_form_new({form:"../../abmelden"})` → GET auf /eportal/abmelden = Logout. Jetzt:
  Slug `^[a-z0-9_-]{2,40}$` (Node + Treiber), `load()` nur same-origin `/eportal/…`, nach
  URL-Auflösung (kein `../`) durch die Textsperre (logout|abmelden|sign|rpc|…).
- `saveDraft` postete an `data-source` aus dem Seiten-HTML mit beliebigem `data-req-cmd` →
  fest `/eportal/interpretermodal` + nur `SpeichernUndVerlassenModalCommand`.
- `parseEoprint` auf Live-Seiten: `<h1>` vor `.modal__title` (alter B1).
- GET-Formulare: Query per `URL.searchParams` zusammenführen.
Selftest läuft jetzt unter dem echten Origin (Request-Interception, kein Netz): 51 Prüfungen.

## Conductor-Review Runde 3 — umgesetzt, Reviews abgeschlossen

Sicherheits-Invariante (kein Senden/Löschen/Logout/Support) über alle Tools bestätigt,
keine neuen Sicherheitsbefunde. Drei funktionale Bugs behoben:
- `elster_form_set` sprang nach dem Speichern erneut auf die Seite und verwarf damit ELSTERs
  Validierungsfehler (meldete `errors: []` bei abgelehntem Wert). Live verifiziert.
- `elster_form_new` mit `importEdaten:false` blieb auf der eDaten-Seite stehen → nutzt einen
  „ohne Übernahme"-Knopf der Seite (Continue/Cancel) oder meldet klar, dass es keinen gibt.
- Jahresauswahl: Fallback auf Optionswert == Jahr.
Befundzahl je Runde: 10 → 4 → 3 (davon 0 Sicherheit). Weitere Runden lohnen kaum.
