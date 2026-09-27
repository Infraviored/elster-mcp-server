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
await p.setContent('<form id="form" action="/x" method="post"><input name="_csrf" value="t"><input type="text" name="fields[a]" value=""></form>');
await p.evaluate(installDriver);
const drv = async (name, js, expectThrow, mustSay) => {
  const r = await p.evaluate(async (code) => { try { return { v: await (new Function('EO', `return (async()=>{${code}})()`))(window.EO) }; } catch (e) { return { e: e.message }; } }, js);
  const threw = !!r.e;
  if (threw && mustSay && !r.e.includes(mustSay)) { fail++; console.log('FAIL', name, 'wrong reason:', r.e); return; }
  if (threw === expectThrow) console.log('ok  ', name, '→', threw ? 'refused: ' + r.e.slice(0, 70) : JSON.stringify(r.v));
  else { fail++; console.log('FAIL', name, JSON.stringify(r)); }
};
await drv('driver escaped SENDEN', `return EO.post('{"SwitchModus":{"target":"\\\\u0053ENDEN"}}')`, true);
await drv('driver escaped Absenden', `return EO.post('{"\\\\u0041bsenden":{}}')`, true);
await drv('versenden: EINGABE smuggled beside other cmd', `EO.url='https://www.elster.de/eportal/interpreter/versenden/est-2025'; return EO.post('{"Foo":{"target":"EINGABE"},"x":{"target":"EINGABE"}}')`, true);
await drv('versenden: non-SwitchModus with EINGABE', `EO.url='https://www.elster.de/eportal/interpreter/versenden/est-2025'; return EO.post('{"Foo":{"target":"EINGABE"}}')`, true);
await drv('versenden: press refused', `EO.url='https://www.elster.de/eportal/interpreter/versenden/est-2025'; return EO.press('x')`, true);
await drv('setFields without rid refused', `EO.url='https://www.elster.de/eportal/interpreter/eingabe/est-2025/Startseite'; EO.lastRid=null; return EO.setFields({a:1})`, true, 'RID unknown');
await drv('load clears lastRid', `EO.lastRid='FormData://old'; try { await EO.load('about:blank'); } catch(e) {} return EO.lastRid`, false);
await b.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
