// Calls tools of the built MCP server over stdio, exactly like an MCP client.
// Aufruf: node tools/mcp-call.mjs '[["tool",{args}], ...]'
// Env (ELSTER_*) must be set by the caller, e.g. via ~/.elster/run-mcp.sh exports.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const calls = JSON.parse(process.argv[2]);
const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: process.env,
  stderr: 'ignore',
});
const client = new Client({ name: 'mcp-call', version: '0' }, { capabilities: {} });
await client.connect(transport);
for (const [name, args] of calls) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 600000 });
  const text = r.content?.[0]?.text ?? '';
  console.log(`\n=== ${name} ${JSON.stringify(args || {}).slice(0, 120)} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}`);
  console.log(process.env.MCP_CALL_FULL || text.length <= 4000 ? text : text.slice(0, 4000) + `\n… [${text.length} chars]`);
}
// MCP_CALL_HOLD=<seconds> keeps the server alive, e.g. so a handoff window stays open.
if (process.env.MCP_CALL_HOLD) await new Promise(r => setTimeout(r, Number(process.env.MCP_CALL_HOLD) * 1000));
await client.close();
