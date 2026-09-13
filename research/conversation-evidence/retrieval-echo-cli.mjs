import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const live = process.argv.includes('--live');
const expectMissing = process.argv.includes('--expect-missing');
const compactedEchoes = process.argv.includes('--compacted-echoes');
assert.ok(!(live && expectMissing));
const root = await mkdtemp(join(tmpdir(), 'namzu-retrieval-echo-cli-'));
const home = join(root, 'home'); const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { createUserMessage } = await import(sdkURL);
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
const oldCode = 'RECEIPT-' + randomUUID(); const correctedCode = 'RECEIPT-' + randomUUID();
const start = Date.UTC(2026, 8, 1);
const events = [{ type: 'run_started', runId, seq: 1, timestamp: start }];
const append = (toolName, result) => {
  const seq = events.length + 1;
  events.push({ type: 'tool_completed', runId, seq, timestamp: start + seq * 1000, toolUseId: 'call-' + seq, toolName, isError: false, result });
  return seq;
};
const oldSeq = append('read', 'ORCHID receipt code ' + oldCode);
const echo = () => {
  const text = JSON.stringify({
  matches: [{ runId, seq: oldSeq, recordedAt: start + oldSeq * 1000, source: 'tool_completed', toolName: 'read', retained: 'full', text: 'ORCHID receipt code ' + oldCode }],
  guidance: 'Recorded conversation search: this quotes an earlier observation.',
  });
  if (!compactedEchoes) return append('search_conversation', text);
  const seq = events.length + 1;
  const toolCallId = 'archived-search-' + seq;
  events.push({ type: 'compaction_shed', runId, seq, timestamp: start + seq * 1000, iteration: seq, reason: 'threshold', messages: [
    { role: 'assistant', content: null, toolCalls: [{ id: toolCallId, type: 'function', function: { name: 'search_conversation', arguments: '{"query":"ORCHID"}' } }] },
    { role: 'tool', toolCallId, isError: false, content: text },
  ] });
  return seq;
};
for (let n = 0; n < 32; n++) echo();
const correctedSeq = append('read', 'ORCHID receipt code ' + correctedCode);
for (let n = 0; n < 32; n++) echo();
const transcript = events.map(JSON.stringify).join('\n') + '\n';
await writeFile(join(runDir, 'transcript.jsonl'), transcript);
const paths = ['packages/sdk/dist/run/evidence-recall.js', 'packages/sdk/dist/store/evidence/linked.js', 'packages/sdk/dist/store/evidence/disk.js', 'packages/sdk/dist/store/evidence/selection.js', 'packages/sdk/dist/store/evidence/index-page.js', 'packages/sdk/dist/store/evidence/compaction-provenance.js', 'packages/sdk/dist/store/evidence/compaction-archive.js', 'packages/sdk/dist/store/evidence/source-text.js', 'packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/cli/dist/integrations/sessions/evidence-recall.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => {
  try { return [path, createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex')]; }
  catch (error) { if (error.code === 'ENOENT') return [path, null]; throw error; }
})));
const report = { root, live, expectMissing, compactedEchoes, source: { runId, oldSeq, correctedSeq, oldCode, correctedCode, echoCount: 64 }, before: await fingerprints(), passed: false };
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
  const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '4', '--token-budget', '25000', 'What was the last observed ORCHID receipt code?'];
  report.command = args;
  const result = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  report.result = JSON.parse(result.stdout);
  report.requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const first = report.requests[0];
  assert.equal(first.ordinaryHasCode, false);
  report.correctedObservationSelected = first.passages.some(p => p.runId === runId && p.seq === correctedSeq && p.toolName === 'read' && p.excerpt.includes(correctedCode));
  report.derivedPassagesSelected = first.passages.filter(p => p.toolName === 'search_conversation' || p.source === 'compaction_shed:tool').length;
  assert.equal(report.correctedObservationSelected, !expectMissing);
  if (!expectMissing) assert.ok(report.result.text.includes(correctedCode));
  assert.equal(await readFile(join(runDir, 'transcript.jsonl'), 'utf8'), transcript);
  report.passed = true;
} catch (error) { report.error = String(error); if (error.stderr) report.stderr = error.stderr; process.exitCode = 1; }
finally {
  report.after = await fingerprints();
  assert.deepEqual(report.after, report.before);
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, passed: report.passed, correctedObservationSelected: report.correctedObservationSelected, derivedPassagesSelected: report.derivedPassagesSelected, error: report.error }));
}
