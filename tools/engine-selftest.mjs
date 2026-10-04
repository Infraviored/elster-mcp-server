// Offline safety checks for the form engine — no ELSTER login needed.
// Run after `npm run build`: node tools/engine-selftest.mjs
import puppeteer from 'puppeteer';
const { ElsterEngine } = await import('../dist/elster/engine.js');
const { parseAmount } = await import('../dist/elster/belege.js');
const { pickCandidate } = await import('../dist/elster/datenuebernahme.js');
const { installDriver } = await import('../dist/elster/engine-driver.js');
let fail = 0;
const t = (name, fn, expectThrow) => {
  try { const r = fn(); if (expectThrow) { fail++; console.log('FAIL (no throw)', name, r); } else console.log('ok  ', name, '→', r); }
  catch (e) { if (expectThrow) console.log('ok  ', name, '→ refused:', e.message.slice(0, 70)); else { fail++; console.log('FAIL', name, e.message); } }
};
// 1 Node guard
t('escaped SENDEN target', () => ElsterEngine.assertCommand('{"SwitchModus":{"target":"\\u0053ENDEN"}}'), true);
t('escaped Absenden key', () => ElsterEngine.assertCommand('{"\\u0041bsenden":{}}'), true);
t('two command names', () => ElsterEngine.assertCommand('{"NextPage":{},"X":{}}'), true);
t('not JSON', () => ElsterEngine.assertCommand('SENDEN please'), true);
t('object SENDEN', () => ElsterEngine.assertCommand({ SwitchModus: { target: 'SENDEN' } }), true);
t('allowed PRUEFEN', () => ElsterEngine.assertCommand('{"SwitchModus":{"target":"PRUEFEN"}}'), false);
t('lowercase senden', () => ElsterEngine.assertCommand('{"senden":{}}'), true);
t('Send', () => ElsterEngine.assertCommand('{"Send":{}}'), true);
t('SendAufgabe', () => ElsterEngine.assertCommand('{"SendAufgabe":{}}'), true);
t('DeleteAufgabe', () => ElsterEngine.assertCommand('{"DeleteAufgabe":{"aufgabeId":1}}'), true);
t('DeleteEntwurfAufgabeCommand', () => ElsterEngine.assertCommand('{"DeleteEntwurfAufgabeCommand":{"aufgabeId":1}}'), true);
t('unknown future command', () => ElsterEngine.assertCommand('{"BrandNewCommand":{}}'), true);
t('SwitchModus TRANSFERAUFGABE', () => ElsterEngine.assertCommand('{"SwitchModus":{"target":"TRANSFERAUFGABE"}}'), true);
t('SwitchModus lowercase senden', () => ElsterEngine.assertCommand('{"SwitchModus":{"target":"senden"}}'), true);
t('allowed JumpToPage', () => ElsterEngine.assertCommand({ JumpToPage: { target: { 'FormData-RID': { rid: 'FormData://x' } } } }), false);
t('allowed DeleteMzbItem (row)', () => ElsterEngine.assertCommand({ DeleteMzbItem: { target: {} } }), false);
t('allowed UploadMzbAnhang', () => ElsterEngine.assertCommand({ UploadMzbAnhang: { mzbName: 'anhang_mzb', multiUpload: true } }), false);
t('allowed CreateMzbAnhangItems', () => ElsterEngine.assertCommand({ CreateMzbAnhangItems: { target: {} } }), false);
t('SwitchToMeineBelege not allowed', () => ElsterEngine.assertCommand({ SwitchToMeineBelege: { modus: 'SELECT_RECEIPT' } }), true);
t('buttonId loescheEntwurf_1', () => ElsterEngine.assertAllowed('loescheEntwurf_1'), true);
t('buttonId sendenButton', () => ElsterEngine.assertAllowed('sendenButton'), true);
// 2 amounts
for (const [s, want] of [['12,99', 12.99], ['12.99', 12.99], ['1.234,56', 1234.56], ['428,01', 428.01], ['15', 15], ['1,5', 1.5]])
  t(`amount ${s}`, () => { const v = parseAmount(s); if (v !== want) throw new Error(`got ${v}`); return v; }, false);
t('amount 1.234 ambiguous', () => parseAmount('1.234'), true);
// 3 takeover
const c = (id, y) => ({ aufgabeId: id, year: y, description: `UStVA ${y} #${id}`, sentAtTs: 1 });
t('takeover year ambiguous', () => pickCandidate([c('1', 2024), c('2', 2024)], { mode: 'year', year: 2024 }), true);
t('takeover year unique', () => pickCandidate([c('1', 2024), c('2', 2023)], { mode: 'year', year: 2024 }).aufgabeId, false);
// 1+4+5 driver in a real browser
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
// Serve the test page under the real portal origin without touching the network,
// so origin checks behave as in the logged-in ELSTER tab.
const TEST_HTML = `<form id="form" action="/x" method="post"><input name="_csrf" value="t"><input type="text" name="fields[a]" value="">
  <button id="b1" name="action" value="SENDEN">Weiter</button>
  <button id="b2" name="cmd" value='{"SwitchModus":{"target":"SENDEN"}}'>Weiter</button>
  <button id="loescheEntwurf_1" name="reqCmd" value='{"OeffneAufgabeCommand":{"aufgabeId":1}}'>Öffnen</button>
  <button id="b3" name="reqCmd" value='{"DeleteEntwurfAufgabeCommand":{"aufgabeId":1}}'>Weiter</button>
  <button id="b4" name="reqCmd" value='{"Continue":{}}'>Entwurf löschen</button>
  <button id="ok" name="reqCmd" value='{"Continue":{"ignoreSkippableErrors":false}}'>Weiter</button>
  </form>`;
await p.setRequestInterception(true);
p.on('request', r => r.url().startsWith('https://www.elster.de/')
  ? r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: TEST_HTML })
  : r.abort());
await p.goto('https://www.elster.de/eportal/selftest');
await p.evaluate(() => {
  // No network in the self-test: every POST answers with a minimal form page.
  window.fetch = async () => new Response('<html><body><h1>stub</h1><form id="form" action="/x"></form></body></html>');
});
await p.evaluate(installDriver);
const drv = async (name, js, expectThrow, mustSay, mustEqual) => {
  const r = await p.evaluate(async (code) => { try { return { v: await (new Function('EO', `return (async()=>{${code}})()`))(window.EO) }; } catch (e) { return { e: e.message }; } }, js);
  const threw = !!r.e;
  if (threw && mustSay && !r.e.includes(mustSay)) { fail++; console.log('FAIL', name, 'wrong reason:', r.e); return; }
  if (!threw && mustEqual !== undefined && r.v !== mustEqual) { fail++; console.log('FAIL', name, 'got', JSON.stringify(r.v)); return; }
  if (threw === expectThrow) console.log('ok  ', name, '→', threw ? 'refused: ' + r.e.slice(0, 70) : JSON.stringify(r.v));
  else { fail++; console.log('FAIL', name, JSON.stringify(r)); }
};
await drv('driver escaped SENDEN', `return EO.post('{"SwitchModus":{"target":"\\\\u0053ENDEN"}}')`, true);
await drv('driver escaped Absenden', `return EO.post('{"\\\\u0041bsenden":{}}')`, true);
await drv('versenden: EINGABE smuggled beside other cmd', `EO.url='https://www.elster.de/eportal/interpreter/versenden/est-2025'; return EO.post('{"Foo":{"target":"EINGABE"},"x":{"target":"EINGABE"}}')`, true);
await drv('versenden: non-SwitchModus with EINGABE', `EO.url='https://www.elster.de/eportal/interpreter/versenden/est-2025'; return EO.post('{"Foo":{"target":"EINGABE"}}')`, true);
await drv('versenden: press refused', `EO.url='https://www.elster.de/eportal/interpreter/versenden/est-2025'; return EO.press('x')`, true);
await drv('setFields without rid refused', `EO.url='https://www.elster.de/eportal/interpreter/eingabe/est-2025/Startseite'; EO.lastRid=null; return EO.setFields({a:1})`, true, 'RID unknown');
await drv('press: non-reqCmd button valued SENDEN', `EO.url='https://www.elster.de/eportal/interpreter/eingabe/est-2025/X'; EO.doc=document; return EO.press('b1')`, true, 'SENDEN');
await drv('press: JSON command outside reqCmd', `EO.doc=document; return EO.press('b2')`, true, 'SENDEN');
await drv('press: button id loescheEntwurf_', `EO.doc=document; return EO.press('loescheEntwurf_1')`, true);
await drv('press: reqCmd DeleteEntwurfAufgabeCommand', `EO.doc=document; return EO.press('b3')`, true, 'allowlist');
await drv('press: label "Entwurf löschen"', `EO.doc=document; return EO.press('b4')`, true, 'löschen');
await drv('press: allowed Continue', `EO.doc=document; EO.url='https://www.elster.de/eportal/x'; return (await EO.press('ok')).title`, false);
await drv('versenden;jsessionid lock', `EO.url='https://www.elster.de/eportal/interpreter/versenden;jsessionid=AB/est-2025'; EO.doc=document; return EO.press('ok')`, true);
await drv('versenden without slash', `EO.url='https://www.elster.de/eportal/interpreter/versenden'; return EO.post({Continue:{}})`, true);
await drv('post lowercase senden', `EO.url='https://www.elster.de/eportal/x'; return EO.post('{"senden":{}}')`, true);
await drv('post DeleteAufgabe', `return EO.post('{"DeleteAufgabe":{}}')`, true);
await drv('post JumpToPage sets lastRid', `EO.doc=new DOMParser().parseFromString('<form id="form" action="/x"></form>','text/html'); EO.url='https://www.elster.de/eportal/x'; EO.lastRid='FormData://old'; await EO.post({JumpToPage:{target:{'FormData-RID':{rid:'FormData://new'}}}}); return EO.lastRid`, false, null, 'FormData://new');
await drv('load path traversal to abmelden', `return EO.load('/eportal/formulare-leistungen/alleformulare/../../abmelden')`, true, 'abmelden');
await drv('load logout', `return EO.load('/eportal/logout')`, true, 'logout');
await drv('load other origin', `return EO.load('https://example.com/eportal/x')`, true, 'outside');
await drv('newForm bad slug', `return EO.newForm('../../abmelden', 2025, null, null, true)`, true, 'invalid form slug');
await drv('saveDraft foreign modal URL', `EO.doc=new DOMParser().parseFromString('<a id="verlassenModal" data-source="/eportal/rpc" data-req-cmd=\\'{"SpeichernUndVerlassenModalCommand":{}}\\'></a>','text/html'); return EO.saveDraft()`, true, 'unexpected URL');
await drv('saveDraft foreign modal command', `EO.doc=new DOMParser().parseFromString('<a id="verlassenModal" data-source="/eportal/interpretermodal" data-req-cmd=\\'{"SendAufgabe":{}}\\'></a>','text/html'); return EO.saveDraft()`, true, 'unexpected save-modal');
await drv('load clears lastRid', `EO.lastRid='FormData://old'; await EO.load('/eportal/meinelster'); return EO.lastRid`, false);
await b.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
