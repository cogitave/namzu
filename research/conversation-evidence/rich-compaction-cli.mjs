import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const live = process.argv.includes('--live');
const expectMissing = process.argv.includes('--expect-missing');
assert.ok(!(live && expectMissing));
const root = await mkdtemp(join(tmpdir(), 'namzu-rich-compaction-cli-'));
const home = join(root, 'home'); const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { createUserMessage } = await import(sdkURL);
const { openSessions, startConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const { retainManualCompaction } = await import('../../packages/cli/dist/integrations/sessions/compaction-evidence.js');
const sessions = await openSessions(cwd);
const sessionId = await startConversation(sessions);
const code = 'RECEIPT-' + randomUUID();
const messages = [
  createUserMessage('Record the receipt.'),
  { role: 'assistant', content: null, timestamp: 1, toolCalls: [{ id: 'receipt', type: 'function', function: { name: 'observe_receipt', arguments: '{}' } }] },
  { role: 'tool', toolCallId: 'receipt', isError: false, timestamp: 2, content: [
    { type: 'text', text: 'Receipt observation follows.' },
    { type: 'image', mediaType: 'image/png', data: 'A'.repeat(4 * 1024 * 1024) },
    { type: 'text', text: 'ORCHID original receipt code ' + code + '\r\nVerified text: İ 😀\n' },
  ] },
  createUserMessage('Keep the observation in history.'),
];
// The same retention function /compact invokes, before replacing projected history.
// Synthetic image bytes exercise storage only; no image is sent to the provider.
await retainManualCompaction(sessions, sessionId, messages);
await replaceConversation(sessions, sessionId, [createUserMessage('Earlier receipt observations are archived.')]);
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
const runs = join(home, 'sessions', sessionId, 'runs');
const runId = (await readdir(runs, { withFileTypes: true })).find(e => e.isDirectory()).name;
const runDir = join(runs, runId);
const transcript = await readFile(join(runDir, 'transcript.jsonl'), 'utf8');
const paths = ['packages/sdk/dist/store/evidence/compaction-text.js', 'packages/sdk/dist/store/evidence/compaction-archive.js', 'packages/sdk/dist/store/evidence/index-page.js', 'packages/sdk/dist/store/evidence/source-text.js', 'packages/cli/dist/integrations/sessions/compaction-evidence.js', 'packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/cli/dist/integrations/sessions/evidence-recall.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => {
  try { return [path, createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex')]; }
  catch (error) { if (error.code === 'ENOENT') return [path, null]; throw error; }
})));
const report = { root, live, expectMissing, source: { runId, seq: 2, code, messageBytes: Buffer.byteLength(JSON.stringify(messages)) }, before: await fingerprints(), passed: false };
try {
  const preload = join(root, 'observe.mjs');
  await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const original=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const created=original(...args);const stream=created.provider.chatStream.bind(created.provider);
created.provider.chatStream=async function*(params){
 const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
 const context=contexts.map(m=>m.content).join('\\n');
 const passages=context.split('\\n').filter(s=>s.startsWith('{"runId":')).map(JSON.parse);
 await appendFile(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify({context,passages,ordinaryHasCode:params.messages.filter(m=>!contexts.includes(m)).some(m=>JSON.stringify(m).includes('RECEIPT-')),hasBinary:JSON.stringify(params.messages).includes('A'.repeat(1000))})+'\\n');
 if(${JSON.stringify(live)}){yield* stream(params);return;}
 yield* new MockLLMProvider({turns:[{text:passages.find(p=>p.toolName==='observe_receipt')?.excerpt??'No observation was selected.'}]}).chatStream(params);
};return created;};`);
  const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '4', '--token-budget', '25000', 'What was the original ORCHID receipt code?'];
  report.command = args;
  const result = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  report.result = JSON.parse(result.stdout);
  const invoked = (await readdir(runs, { withFileTypes: true })).filter(e => e.isDirectory() && e.name !== runId).map(e => e.name);
  assert.equal(invoked.length, 1);
  const events = (await readFile(join(runs, invoked[0], 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  report.toolCalls = events.filter(e => e.type === 'tool_executing').map(e => e.toolName);
  assert.deepEqual(report.toolCalls, []);
  report.requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(report.requests[0].ordinaryHasCode, false);
  assert.ok(report.requests.every(r => !r.hasBinary));
  report.originalSelected = report.requests[0].passages.some(p => p.runId === runId && p.seq === 2 && p.source === 'compaction_shed:tool' && p.toolName === 'observe_receipt' && p.excerpt.includes(code));
  assert.equal(report.originalSelected, !expectMissing);
  if (!expectMissing) assert.ok(report.result.text.includes(code));
  assert.equal(await readFile(join(runDir, 'transcript.jsonl'), 'utf8'), transcript);
  report.passed = true;
} catch (error) { report.error = String(error); if (error.stderr) report.stderr = error.stderr; process.exitCode = 1; }
finally {
  report.after = await fingerprints();
  assert.deepEqual(report.after, report.before);
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, passed: report.passed, originalSelected: report.originalSelected, error: report.error }));
}
