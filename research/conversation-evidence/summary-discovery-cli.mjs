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
const root = await mkdtemp(join(tmpdir(), 'namzu-summary-discovery-cli-'));
const home = join(root, 'home'); const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { createUserMessage, RunDiskStore } = await import(sdkURL);
const { openSessions, startConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const { buildCompactionMessage } = await import('../../packages/sdk/dist/compaction/summary.js');
const sessions = await openSessions(cwd);
const sessionId = await startConversation(sessions);
const code = 'RECEIPT-' + randomUUID();
const summaryCount = Number(process.argv.find(a=>a.startsWith('--summaries='))?.split('=')[1] ?? 20);
assert.ok(Number.isSafeInteger(summaryCount) && summaryCount >= 1 && summaryCount <= 200);
const summaries = Array.from({length:summaryCount}, (_,i)=>buildCompactionMessage(`ORCHID original receipt code: not recorded in summary ${i}.`));
const messages = [createUserMessage('Earlier observations were compacted. Their exact originals may be in the scoped archive.')];
await replaceConversation(sessions, sessionId, messages);
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
const runs = join(home, 'sessions', sessionId, 'runs');
await mkdir(runs, {recursive:true});
const original = 'ORCHID original receipt code '+code+'\n'+'Receipt archive accompanying notes. '.repeat(11);
const archiveIds = [randomUUID()];
const runId = archiveIds[0]; const targetSeq = 3;
const transcripts = {};
const store = new RunDiskStore({baseDir:runs});
const dir = await store.initRun(runId);
const scope = {tenantId:sessions.tenantId, projectId:sessions.projectId, sessionId, runId};
await writeFile(join(dir,'run.json'), JSON.stringify({id:runId,status:'completed',metadata:{scope}}));
await store.appendEvent({type:'run_started',runId,seq:1});
await store.appendEvent({type:'compaction_shed',runId,seq:2,iteration:2,reason:'threshold',messages:summaries});
await store.appendEvent({type:'tool_completed',runId,seq:3,toolName:'read',toolUseId:'original',isError:false,result:original});
transcripts[runId]=await readFile(join(dir,'transcript.jsonl'),'utf8');
const paths = ['packages/sdk/dist/run/evidence-recall.js', 'packages/sdk/dist/store/evidence/disk.js', 'packages/sdk/dist/store/evidence/linked.js', 'packages/sdk/dist/store/evidence/selection.js', 'packages/sdk/dist/compaction/summary.js', 'packages/sdk/dist/store/evidence/index-page.js', 'packages/sdk/dist/store/evidence/compaction-text.js', 'packages/cli/dist/integrations/sessions/evidence-recall.js', 'packages/cli/dist/integrations/sessions/conversation-search.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => {
  try { return [path, createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex')]; }
  catch (error) { if (error.code === 'ENOENT') return [path, null]; throw error; }
})));
const report = { root, live, expectMissing, summaryCount, source: { runId, seq: targetSeq, code, original, summaries, archiveIds }, before: await fingerprints(), passed: false };
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
 const metadata=JSON.parse(context.split('\\n').find(s=>s.startsWith('{"incomplete":'))||'{}');
 await appendFile(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify({context,passages,metadata,ordinaryHasCode:params.messages.filter(m=>!contexts.includes(m)).some(m=>JSON.stringify(m).includes('RECEIPT-')),hasBinary:JSON.stringify(params.messages).includes('A'.repeat(1000))})+'\\n');
 if(${JSON.stringify(live)}){yield* stream(params);return;}
 yield* new MockLLMProvider({turns:[{text:passages.find(p=>p.seq===${JSON.stringify(targetSeq)}&&p.runId===${JSON.stringify(runId)})?.excerpt??'No observation was selected.'}]}).chatStream(params);
};return created;};`);
  const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '4', '--token-budget', '25000', 'What was the original ORCHID receipt code?'];
  report.command = args;
  const result = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  report.result = JSON.parse(result.stdout);
  const invoked = (await readdir(runs, { withFileTypes: true })).filter(e => e.isDirectory() && !archiveIds.includes(e.name)).map(e => e.name);
  assert.equal(invoked.length, 1);
  const events = (await readFile(join(runs, invoked[0], 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  report.toolCalls = events.filter(e => e.type === 'tool_executing').map(e => e.toolName);
  assert.deepEqual(report.toolCalls, []);
  report.requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(report.requests[0].ordinaryHasCode, false);
  assert.ok(report.requests.every(r => !r.hasBinary));
  report.originalSelected = report.requests[0].passages.some(p => p.runId === runId && p.seq === targetSeq && p.source === 'tool_completed' && p.toolName === 'read' && p.excerpt.includes(code));
  assert.equal(report.originalSelected, !expectMissing);
  if (!expectMissing) assert.ok(report.result.text.includes(code));
  for (const id of archiveIds) assert.equal(await readFile(join(runs,id,'transcript.jsonl'),'utf8'),transcripts[id]);
  report.passed = true;
} catch (error) { report.error = String(error); if (error.stderr) report.stderr = error.stderr; process.exitCode = 1; }
finally {
  report.after = await fingerprints();
  assert.deepEqual(report.after, report.before);
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, passed: report.passed, originalSelected: report.originalSelected, error: report.error }));
}
