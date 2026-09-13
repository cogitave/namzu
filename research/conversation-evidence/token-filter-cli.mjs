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
const root = await mkdtemp(join(tmpdir(), 'namzu-token-filter-cli-'));
const home = join(root, 'home'); const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { createUserMessage } = await import(sdkURL);
const { applyToolOutputBudget } = await import('../../packages/sdk/dist/runtime/query/tool-output-budget.js');
const { openSessions, startConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const sessions = await openSessions(cwd);
const sessionId = await startConversation(sessions);
await replaceConversation(sessions, sessionId, [createUserMessage('Earlier observations and conversation searches are archived.')]);
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
await writeFile(join(cwd, 'receipt.txt'), 'Current replacement: no historical receipt remains here.\n');
const runId = randomUUID(); const runDir = join(home, 'sessions', sessionId, 'runs', runId);
await mkdir(runDir, { recursive: true });
const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId };
await writeFile(join(runDir, 'run.json'), JSON.stringify({ id: runId, status: 'completed', metadata: { scope } }));
const code = 'RECEIPT-' + randomUUID();
const noise = 'unrelated padding '.repeat(Math.ceil(6 * 1024 * 1024 / 18)).slice(0, 6 * 1024 * 1024);
const original = noise + '\nORCHID original receipt code ' + code + '\n' + 'unrelated padding '.repeat(60000);
const retained = applyToolOutputBudget({ toolName: 'read', toolUseId: 'original', output: original, maxChars: 1000, spillDir: join(runDir, 'tool-output') });
assert.ok(retained.spillIntegrity && !retained.output.includes(code));
const events = [
 { type: 'run_started', runId, seq: 1 },
 { type: 'tool_completed', runId, seq: 2, toolName: 'read', toolUseId: 'original', isError: false, result: retained.output, outputTruncated: true, outputSpillIntegrity: retained.spillIntegrity },
];
const transcript = events.map(JSON.stringify).join('\n') + '\n';
await writeFile(join(runDir, 'transcript.jsonl'), transcript);
const paths = ['packages/sdk/dist/run/evidence-recall.js', 'packages/sdk/dist/store/evidence/linked.js', 'packages/sdk/dist/store/evidence/format.js', 'packages/sdk/dist/utils/evidence-tokens.js', 'packages/sdk/dist/store/evidence/disk.js', 'packages/sdk/dist/store/evidence/selection.js', 'packages/sdk/dist/store/evidence/index-page.js', 'packages/sdk/dist/store/evidence/compaction-provenance.js', 'packages/sdk/dist/store/evidence/compaction-archive.js', 'packages/sdk/dist/store/evidence/source-text.js', 'packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/cli/dist/integrations/sessions/evidence-recall.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => {
  try { return [path, createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex')]; }
  catch (error) { if (error.code === 'ENOENT') return [path, null]; throw error; }
})));
const report = { root, live, expectMissing, runtime: { node: process.version, v8: process.versions.v8, unicode: process.versions.unicode }, source: { runId, seq: 2, code, bytes: Buffer.byteLength(original), targetByteOffset: Buffer.byteLength(noise)+1, manifestBytes: (await readFile(join(runDir, 'tool-output', createHash('sha256').update('original').digest('hex')+'.txt.manifest.json'))).length }, before: await fingerprints(), passed: false };
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
 await appendFile(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify({context,passages,ordinaryHasCode:params.messages.filter(m=>!contexts.includes(m)).some(m=>String(m.content).includes('RECEIPT-'))})+'\\n');
 if(${JSON.stringify(live)}){yield* stream(params);return;}
 const selected=passages.filter(p=>p.toolName==='read').sort((a,b)=>b.seq-a.seq)[0];
 yield* new MockLLMProvider({turns:[{text:selected?.excerpt??'No direct observation was selected.'}]}).chatStream(params);
};return created;};`);
  const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '4', '--token-budget', '25000', 'What was the original ORCHID receipt code?'];
  report.command = args;
  const result = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  report.result = JSON.parse(result.stdout);
  const runs = join(home, 'sessions', sessionId, 'runs');
  const invoked = (await readdir(runs, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name !== runId).map(entry => entry.name);
  assert.equal(invoked.length, 1);
  const recorded = (await readFile(join(runs, invoked[0], 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  report.toolCalls = recorded.filter(e => e.type === 'tool_executing').map(e => e.toolName);
  assert.deepEqual(report.toolCalls, []);
  assert.equal(await readFile(join(cwd, 'receipt.txt'), 'utf8'), 'Current replacement: no historical receipt remains here.\n');
  report.requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const first = report.requests[0];
  assert.equal(first.ordinaryHasCode, false);
  report.originalSelected = first.passages.some(p => p.runId === runId && p.seq === 2 && p.toolName === 'read' && p.excerpt.includes(code));
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
