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
const expectUnquoted = process.argv.includes('--expect-unquoted');
const recordsAt = process.argv.indexOf('--records');
const priorRecords = recordsAt < 0 ? undefined : JSON.parse(await readFile(process.argv[recordsAt + 1], 'utf8')).records;
assert.ok(!(live && expectMissing));
const root = await mkdtemp(join(tmpdir(), 'namzu-visible-evidence-cli-'));
const home = join(root, 'home');
const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { openSessions, startConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const { createUserMessage, createAssistantMessage } = await import(sdkURL);
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
  const code = priorRecords?.[i]?.code ?? `RECEIPT-${randomUUID()}`;
  assert.match(code, /^RECEIPT-[0-9a-f-]{36}$/);
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
await replaceConversation(sessions, sessionId, [
  createUserMessage('Earlier receipt observations follow. Their recording dates were omitted from this summary.'),
  createAssistantMessage(records.map(r => `DELTA receipt last recorded code ${r.code}.`).reverse().join('\n')),
]);
const expected = [...records].sort((a, b) => b.timestamp - a.timestamp)[0];
const report = { root, live, expectMissing, expectUnquoted, reverse, records, expected, sessionId, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low' };
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
ProviderRegistry.create=(...args)=>{const created=original(...args);const stream=created.provider.chatStream.bind(created.provider);let step=0;
if(${JSON.stringify(live)}){
 const responseCreate=created.provider.client.responses.create.bind(created.provider.client.responses);
 created.provider.client.responses.create=async(...args)=>{
  const events=await responseCreate(...args);
  return (async function*(){let deltaText='';const done=[];
   for await(const event of events){
    if(event.type==='response.output_text.delta') deltaText+=event.delta;
    if(event.type==='response.output_text.done') done.push({output:event.output_index,part:event.content_index,text:event.text});
    yield event;
   }
   await appendFile(${JSON.stringify(join(root,'answer-stream.jsonl'))},JSON.stringify({deltaText,done})+'\\n');
  })();
 };
}
created.provider.chatStream=async function*(params){
 const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
 const context=contexts.map(m=>m.content).join('\\n');
 const passages=context.split('\\n').filter(s=>s.startsWith('{"runId":')).map(JSON.parse);
 const metadata=JSON.parse(context.split('\\n').find(s=>s.startsWith('{"incomplete":'))||'{}');
 await appendFile(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify({context,passages,metadata,ordinaryHasCodes:params.messages.filter(m=>!contexts.includes(m)).some(m=>String(m.content).includes('RECEIPT-'))})+'\\n');
 if(${JSON.stringify(live)}){yield* stream(params);return;}
 let turn;
 if(${JSON.stringify(expectMissing)}) turn={text:'UNORDERED: archive sources for visible text are unavailable.'};
 else if(step++===0){
  const ref=[...(metadata.visibleEvidence||[])].sort((a,b)=>b.recordedAt-a.recordedAt)[0];
  if(!ref) throw new Error('No visible evidence reference supplied');
  turn={toolCalls:[{id:'read-visible',name:'read_conversation',args:ref.address}]};
 }else turn={text:params.messages.filter(m=>m.role==='tool'&&m.toolCallId==='read-visible').map(m=>m.content).join('\\n')};
 yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
};return created;};`);
  const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '3', '--token-budget', '25000', 'What was the last recorded DELTA receipt code?'];
  report.command = args;
  const result = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2000000 });
  report.result = JSON.parse(result.stdout);
  report.requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const first = report.requests[0];
  assert.equal(first.ordinaryHasCodes, true);
  assert.equal(first.passages.length, 0);
  assert.equal(first.metadata.visibleEvidence?.length, expectMissing ? undefined : 2);
  for (const record of records) {
    assert.equal(first.context.includes(record.code), !expectMissing && !expectUnquoted);
    if(!expectMissing){
      const ref=first.metadata.visibleEvidence.find(p => p.address.runId === record.runId);
      assert.equal(ref.recordedAt, record.timestamp);
      if(!expectUnquoted) assert.ok(ref.textQuote.includes(record.code));
    }
  }
  const invoked = (await readdir(runs, { withFileTypes: true })).filter(e => e.isDirectory() && !ids.includes(e.name));
  assert.equal(invoked.length, 1);
  const events = (await readFile(join(runs, invoked[0].name, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  report.calls = events.filter(e => e.type === 'tool_executing').map(e => ({ name: e.toolName, input: e.input }));
  if(expectMissing) assert.equal(report.calls.length, 0);
  else { if(!live) assert.ok(report.calls.length>0); assert.ok(report.calls.every(c=>c.name==='read_conversation')); }
  report.stopReason = events.findLast(e => e.type === 'run_completed')?.stopReason;
  if(live){
    report.answerStream=(await readFile(join(root,'answer-stream.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const last=report.answerStream.at(-1);
    report.streamMatchesResult=last.deltaText===report.result.text;
    report.doneMatchesDeltas=last.done.sort((a,b)=>a.output-b.output||a.part-b.part).map(d=>d.text).join('')===last.deltaText;
    assert.equal(report.streamMatchesResult,true);assert.equal(report.doneMatchesDeltas,true);
  }
  assert.equal(report.stopReason, 'end_turn');
  assert.equal(report.result.text.includes(expected.code), !expectMissing);
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
