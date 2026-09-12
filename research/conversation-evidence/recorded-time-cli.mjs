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
const reverse = process.argv.includes('--reverse');
assert.ok(!(live && expectMissing));
const root = await mkdtemp(join(tmpdir(), 'namzu-recorded-time-cli-'));
const home = join(root, 'home');
const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { openSessions, startConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const { createUserMessage } = await import(sdkURL);
const sessions = await openSessions(cwd);
const sessionId = await startConversation(sessions);
await replaceConversation(sessions, sessionId, [createUserMessage('Earlier receipt observations are archived.')]);
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
const workspaceText = 'No historical receipt dates in this replacement.\n';
await writeFile(join(cwd, 'receipt.txt'), workspaceText);
const runs = join(home, 'sessions', sessionId, 'runs');
const ids = ['11111111-1111-4111-a111-111111111111', 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'];
const dates = [Date.UTC(2025, 1, 3, 4), Date.UTC(2026, 4, 6, 7)];
if (reverse) dates.reverse();
const records = [];
for (const [i, runId] of ids.entries()) {
  const runDir = join(runs, runId);
  await mkdir(runDir, { recursive: true });
  const code = `RECEIPT-${randomUUID()}`;
  const timestamp = dates[i];
  records.push({ runId, seq: 2, timestamp, code });
  const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId };
  // Deliberately conflicting run-start metadata: only the event dates this observation.
  await writeFile(join(runDir, 'run.json'), JSON.stringify({ id: runId, status: 'completed', startedAt: dates[1 - i], metadata: { scope } }));
  await writeFile(join(runDir, 'transcript.jsonl'), [
    { type: 'run_started', runId, seq: 1, timestamp: 1 },
    { type: 'tool_completed', runId, seq: 2, timestamp, toolUseId: 'receipt', toolName: 'read', isError: false, result: `DELTA receipt last recorded code ${code}.` },
  ].map(JSON.stringify).join('\n') + '\n');
}
const expected = [...records].sort((a, b) => b.timestamp - a.timestamp)[0];
const report = { root, live, expectMissing, reverse, records, expected, sessionId, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low' };
const files = ['packages/sdk/dist/run/evidence-recall.js', 'packages/sdk/dist/store/evidence/source-text.js', 'packages/sdk/dist/store/evidence/disk.js', 'packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/cli/dist/integrations/sessions/evidence-recall.js'];
async function hashes() {
  const result = {};
  for (const path of files) result[path] = createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex');
  return result;
}
try {
  report.buildBefore = await hashes();
  const preload = join(root, 'observe.mjs');
  await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const original=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const created=original(...args);const stream=created.provider.chatStream.bind(created.provider);
created.provider.chatStream=async function*(params){
 const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
 const context=contexts.map(m=>m.content).join('\\n');
 const passages=context.split('\\n').filter(s=>s.startsWith('{"runId":')).map(JSON.parse);
 await appendFile(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify({context,passages,ordinaryHasCodes:params.messages.filter(m=>!contexts.includes(m)).some(m=>String(m.content).includes('RECEIPT-'))})+'\\n');
 if(${JSON.stringify(live)}){yield* stream(params);return;}
 const ordered=passages.every(p=>typeof p.recordedAt==='number');
 const chosen=ordered?[...passages].sort((a,b)=>b.recordedAt-a.recordedAt)[0]:undefined;
 yield* new MockLLMProvider({turns:[{text:chosen?.excerpt??'UNORDERED: archive recording times are unavailable.'}]}).chatStream(params);
};return created;};`);
  const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '3', '--token-budget', '20000', 'What was the last recorded DELTA receipt code?'];
  report.command = args;
  const result = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2000000 });
  report.result = JSON.parse(result.stdout);
  report.requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const first = report.requests[0];
  assert.equal(first.ordinaryHasCodes, false);
  assert.equal(first.passages.length, 2);
  for (const record of records) {
    const passage = first.passages.find(p => p.runId === record.runId);
    assert.ok(passage.excerpt.includes(record.code));
    assert.equal(passage.recordedAt, expectMissing ? undefined : record.timestamp);
  }
  assert.equal(report.result.text.includes(expected.code), !expectMissing);
  const invoked = (await readdir(runs, { withFileTypes: true })).filter(e => e.isDirectory() && !ids.includes(e.name));
  assert.equal(invoked.length, 1);
  const events = (await readFile(join(runs, invoked[0].name, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  report.calls = events.filter(e => e.type === 'tool_executing').map(e => ({ name: e.toolName, input: e.input }));
  assert.equal(report.calls.length, 0);
  report.stopReason = events.findLast(e => e.type === 'run_completed')?.stopReason;
  assert.equal(report.stopReason, 'end_turn');
  assert.equal(await readFile(join(cwd, 'receipt.txt'), 'utf8'), workspaceText);
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  report.buildAfter = await hashes();
  report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter);
  if (!report.buildStable) { report.passed = false; report.error = 'Build changed during measurement'; process.exitCode = 1; }
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, live, reverse, passed: report.passed, calls: report.calls, usage: report.result?.usage, error: report.error }));
}
