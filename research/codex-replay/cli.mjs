// Explicit live opt-in. Uses an isolated CLI home and workspace; never logs credentials,
// reasoning text or encrypted reasoning payloads. Only public answers and item digests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert.ok(process.argv.includes('--live'), 'Pass --live to authorize bounded model requests.');
const baseline = process.argv.includes('--baseline');
const root = await mkdtemp(join(tmpdir(), 'namzu-codex-replay-'));
const home = join(root, 'home');
const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd);
process.env.NAMZU_HOME = home;
const { openSessions, resolveConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const { createUserMessage } = await import('../../packages/sdk/dist/index.js');
const sessions = await openSessions(cwd);
const sessionKey = 'codex-replay-check';
const sessionId = await resolveConversation(sessions, sessionKey);
await replaceConversation(sessions, sessionId, [createUserMessage('This is an isolated read-only continuity check.')]);
const code = `NOTE-${randomUUID().slice(0, 8)}`;
const note = `The retained observation code is ${code}.\n`;
await writeFile(join(cwd, 'note.txt'), note);
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n');
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const preload = join(root, 'observe.mjs');
await writeFile(preload, `import {ProviderRegistry} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const shape=x=>({type:x.type,id:x.id,digest:digest(x),...(x.type==='reasoning'?{encrypted:typeof x.encrypted_content==='string'&&x.encrypted_content.length>0}:{})});
const save=x=>appendFile(${JSON.stringify(join(root, 'observations.jsonl'))},JSON.stringify({pid:process.pid,...x})+'\n');
const original=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const created=original(...args);
 if(created.provider.id!=='codex')return created;
 const client=created.provider.client;
 const create=client.responses.create.bind(client.responses);
 let request=0;
 client.responses.create=async(...args)=>{const n=++request;
  await save({kind:'request',n,input:args[0].input.map(shape)});
  const stream=await create(...args);
  return(async function*(){const done=[];let completed;let deltaText='';
   for await(const event of stream){
    if(event.type==='response.output_item.done')done.push({index:event.output_index,...shape(event.item)});
    if(event.type==='response.output_text.delta')deltaText+=event.delta;
    if(event.type==='response.completed')completed=(event.response.output??[]).map(shape);
    yield event;
   }
   await save({kind:'wire',n,done,completed,deltaText});
  })();
 };
 const chat=created.provider.chatStream.bind(created.provider);
 created.provider.chatStream=async function*(params){let text='';
  for await(const chunk of chat(params)){
   text+=chunk.delta.content??'';
   if(chunk.replayState){const s=chunk.replayState;await save({kind:'replay',n:request,finishReason:chunk.finishReason,contentMatches:(s.content??'')===text,items:s.items.map(shape),toolCalls:s.toolCalls.length});}
   yield chunk;
  }
 };
 return created;
};`.replaceAll("+'\n'", "+'\\n'"));

const files = ['packages/providers/openai/dist/codex.js', 'packages/sdk/dist/runtime/query/iteration/stream-turn.js', 'packages/cli/dist/commands/run.js', 'packages/cli/dist/integrations/sessions/store.js'];
async function hashes() {
  const result = {};
  for (const path of files) result[path] = createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex');
  return result;
}
const report = { root, baseline, sessionId, model: 'gpt-5.6-luna', effort: 'low', turns: [] };
try {
  report.buildBefore = await hashes();
  const prompts = [
    'Read note.txt and report its observation code. Only read that file; do not change files or run commands.',
    'What observation code did you just read? Answer from our conversation; do not use tools.',
  ];
  for (const prompt of prompts) {
    const args = ['--quiet', 'run-stream', '--trust', '--cwd', cwd, '--provider', 'codex', '--model', report.model, '--effort', 'low', '--max-iterations', '3', '--token-budget', '30000', '--session', sessionKey, prompt];
    const result = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2000000 });
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    const done = events.findLast(e => e.kind === 'done');
    report.turns.push({ command: args, result: { text: done?.text, usage: events.findLast(e => e.kind === 'usage'), stopReason: done?.stopReason }, notices: events.filter(e => e.kind === 'notice' || e.kind === 'error') });
    assert.ok(done, 'CLI must publish a terminal event.');
    assert.ok(!events.some(e => e.kind === 'error' || (e.kind === 'notice' && e.message.includes('not saved'))));
  }
  report.observations = (await readFile(join(root, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const runs = join(home, 'sessions', report.sessionId, 'runs');
  report.persisted = [];
  report.toolCalls = [];
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const events = (await readFile(join(runs, runId, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    report.toolCalls.push(...events.filter(e => e.type === 'tool_executing').map(e => ({ runId, name: e.toolName })));
    const { messages } = JSON.parse(await readFile(join(runs, runId, 'messages.json'), 'utf8'));
    for (const m of messages) {
      const s = m.source?.replayState;
      if (s?.kind === 'namzu.codex.responses') report.persisted.push({ runId, contentMatches: s.content === m.content, itemCount: s.items.length });
    }
  }
  const wires = report.observations.filter(o => o.kind === 'wire');
  const requests = report.observations.filter(o => o.kind === 'request');
  const replay = report.observations.filter(o => o.kind === 'replay');
  const resumedPid = requests.at(-1).pid;
  const resumed = requests.find(o => o.pid === resumedPid);
  const firstWires = wires.filter(o => o.pid !== resumedPid);
  const firstDone = firstWires.flatMap(o => o.done);
  report.nextRequestReplay = firstDone.map(item => ({ type: item.type, encrypted: item.encrypted, sameTurn: requests.some(r => r.pid === firstWires[0].pid && r.n > 1 && r.input.some(i => i.digest === item.digest)), afterRestart: resumed.input.some(i => i.digest === item.digest) }));
  assert.equal(new Set(requests.map(r => r.pid)).size, 2);
  assert.ok(report.toolCalls.length > 0);
  assert.ok(report.toolCalls.every(c => c.name === 'read'));
  assert.ok(report.turns.every(t => t.result.text.includes(code)));
  assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), note);
  assert.ok(wires.every(w => w.done.length > 0));
  assert.ok(firstDone.some(i => i.type === 'function_call'));
  assert.ok(firstDone.some(i => i.type === 'reasoning' && i.encrypted));
  report.allNativeReplayedAfterRestart = report.nextRequestReplay.every(i => i.afterRestart);
  report.allReplayContentMatches = replay.every(r => r.contentMatches);
  assert.equal(report.allNativeReplayedAfterRestart, !baseline);
  assert.equal(report.allReplayContentMatches, !baseline);
  if (!baseline) {
    assert.ok(report.persisted.length > 0 && report.persisted.every(s => s.contentMatches && s.itemCount > 0));
    assert.ok(report.nextRequestReplay.some(i => i.type === 'reasoning' && i.sameTurn));
    assert.ok(report.nextRequestReplay.some(i => i.type === 'function_call' && i.sameTurn));
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  report.buildAfter = await hashes();
  report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter);
  if (!report.buildStable) { report.passed = false; report.error = 'Build changed during measurement'; process.exitCode = 1; }
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, passed: report.passed, baseline, turns: report.turns.length, allNativeReplayedAfterRestart: report.allNativeReplayedAfterRestart, error: report.error }));
}
