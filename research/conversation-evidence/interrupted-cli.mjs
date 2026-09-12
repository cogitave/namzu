import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const storeURL = new URL('../../packages/cli/dist/integrations/sessions/store.js', import.meta.url);
const agentURL = new URL('../../packages/cli/dist/tui/agent.js', import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (process.argv[2] === '--seed') {
  const sdk = await import(sdkURL);
  const { openSessions, startConversation, replaceConversation } = await import(storeURL);
  const { createAgentSession, probeAgentSession } = await import(agentURL);
  const cwd = process.argv[3];
  const sessions = await openSessions(cwd);
  const sessionId = await startConversation(sessions);
  const runId = sdk.generateRunId();
  const receipt = `ORCHID-${randomUUID()}`;
  await writeFile(join(cwd, 'manifest.txt'), Array.from({ length: 400 }, (_, i) => i === 210
    ? `Original receipt: ${receipt}` : `Row ${i}: ${'ordinary observation '.repeat(40)}`).join('\n'));
  // A bounded projection without the original code; no automatic-compaction claim.
  await replaceConversation(sessions, sessionId, [sdk.createUserMessage('An earlier manifest was inspected. Its receipt is retained in the recorded observation.')]);
  let requests = 0;
  const provider = { id: 'scripted', name: 'scripted', async *chatStream(params) {
    if (requests++ === 0) {
      yield* new sdk.MockLLMProvider({ turns: [{ toolCalls: [{ id: 'observe-once', name: 'read', args: { path: 'manifest.txt' } }] }] }).chatStream(params);
      return;
    }
    // The next provider request proves the first tool boundary was persisted.
    await writeFile(join(cwd, 'manifest.txt'), 'The workspace file was externally replaced.');
    process.send({ sessionId, runId, receipt, root: sessions.root });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } };
  const probe = await probeAgentSession();
  sdk.ProviderRegistry.create = () => ({ provider });
  const session = await createAgentSession(probe.preferences, probe.detected, {
    cwd, stateRoot: sessions.root, conversationSessions: sessions,
    scope: { sessionId, tenantId: sessions.tenantId, projectId: sessions.projectId, topicId: sessions.topicId },
    sandbox: { enabled: false }, web: { search: 'off' }, memory: { recall: false },
    limits: { maxIterations: 3, tokenBudget: 20000 },
  });
  for await (const _event of session.send([sdk.createUserMessage('Read manifest.txt once.')], { runId, permissionMode: 'auto' })) { /* killed by the parent before settlement */ }
} else {
  const live = process.argv.includes('--live');
  const torn = process.argv.includes('--torn');
  const root = await mkdtemp(join(tmpdir(), 'namzu-interrupted-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n');
  const env = { ...process.env, NAMZU_HOME: home };
  const report = { root, live, torn, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low' };
  const paths = ['packages/sdk/dist/store/evidence/disk.js', 'packages/sdk/dist/store/evidence/index-page.js', 'packages/sdk/dist/store/evidence/source-text.js', 'packages/sdk/dist/store/run/disk.js', 'packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/cli/dist/tui/agent.js', 'packages/cli/dist/commands/run.js'];
  const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(new URL('../../' + path, import.meta.url)))])));
  let child;
  try {
    report.before = await fingerprints();
    child = fork(fileURLToPath(import.meta.url), ['--seed', cwd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-100000); });
    child.stdout.resume();
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    report.seed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Seed timed out: ' + stderr)); }, 30000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Seed exited before readiness: ${code} ${signal} ${stderr}`)); });
    });
    child.kill('SIGKILL');
    report.seedExit = await exited;
    assert.equal(report.seedExit.signal, 'SIGKILL');
    const runDir = join(home, 'sessions', report.seed.sessionId, 'runs', report.seed.runId);
    const metadataPath = join(runDir, 'run.json'); const transcriptPath = join(runDir, 'transcript.jsonl');
    const metadata = await readFile(metadataPath);
    const raw = await readFile(transcriptPath, 'utf8');
    const events = raw.trim().split('\n').map(JSON.parse);
    const original = events.find(e => e.type === 'tool_completed' && e.toolName === 'read');
    assert.ok(original?.outputSpillIntegrity && !original.result.includes(report.seed.receipt));
    assert.equal(events.filter(e => e.type === 'tool_executing' && e.toolName === 'read').length, 1);
    report.originalSeq = original.seq;
    report.metadataStatus = JSON.parse(metadata).status;
    assert.ok(['idle', 'pending', 'running'].includes(report.metadataStatus));
    assert.ok(!events.some(e => ['run_completed', 'run_failed', 'run_cancelled'].includes(e.type)));
    // Model an interrupted final JSONL append separately from the confirmed process kill.
    if (torn) await writeFile(transcriptPath, raw + '{"type":"message_completed","content":"unfinished');
    const stored = await readFile(transcriptPath);
    report.oldRunBefore = { metadata: digest(metadata), transcript: digest(stored) };
    const preload = join(root, 'provider.mjs');
    await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
const parse=c=>{const s=String(c);return JSON.parse(s.slice(s.indexOf('{'),s.lastIndexOf('}')+1));};
ProviderRegistry.create=()=>({provider:{id:'scripted',name:'scripted',async *chatStream(params){
 const last=params.messages.filter(m=>m.role==='tool').at(-1);let turn;
 if(!last)turn={toolCalls:[{id:'search',name:'search_conversation',args:{query:'ORCHID',runId:${JSON.stringify(report.seed.runId)}}}]};
 else{const page=parse(last.content);if(last.toolCallId.startsWith('search')){const m=page.matches?.find(m=>m.source==='tool_completed'&&m.toolName==='read');
 turn=m?{toolCalls:[{id:'read',name:'read_conversation',args:{runId:m.runId,seq:m.seq,part:m.part,byteOffset:m.byteOffset}}]}:page.nextCursor?{toolCalls:[{id:'search-'+params.messages.length,name:'search_conversation',args:{cursor:page.nextCursor}}]}:{text:'The original receipt was not recovered.'};
 }else turn={text:page.text||'The original passage was not read.'};}yield*new MockLLMProvider({turns:[turn]}).chatStream(params);}}});`);
    const prompt = 'Recover the exact original ORCHID receipt from the earlier recorded observation. Read the original passage before answering. The workspace file has changed. Do not read workspace files, edit anything, run commands or use the network.';
    const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', report.seed.sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '6', '--token-budget', '35000', prompt];
    report.command = args;
    const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [...(live ? [] : ['--import', preload]), cli, ...args], { cwd, env, timeout: 150000, maxBuffer: 2000000 });
    report.result = JSON.parse(stdout);
    const recoveredEvents = [];
    const runs = join(home, 'sessions', report.seed.sessionId, 'runs');
    for (const entry of await readdir(runs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === report.seed.runId) continue;
      recoveredEvents.push(...(await readFile(join(runs, entry.name, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse));
    }
    report.calls = recoveredEvents.filter(e => e.type === 'tool_executing').map(e => ({ name: e.toolName, input: e.input }));
    report.outputs = recoveredEvents.filter(e => e.type === 'tool_completed').map(e => ({ name: e.toolName, isError: e.isError, result: e.result }));
    report.oldRunAfter = { metadata: digest(await readFile(metadataPath)), transcript: digest(await readFile(transcriptPath)) };
    assert.deepEqual(report.oldRunAfter, report.oldRunBefore);
    assert.ok(report.calls.every(e => ['search_conversation', 'read_conversation', 'search_tools'].includes(e.name)));
    assert.ok(report.outputs.every(e => !e.isError));
    report.exactOriginalRead = report.outputs.some(e => {
      if (e.name !== 'read_conversation') return false;
      const page = JSON.parse(e.result);
      return page.runId === report.seed.runId && page.seq === original.seq && page.source === 'tool_completed' && !page.retainedPreview && page.text.includes(report.seed.receipt);
    });
    assert.ok(report.exactOriginalRead);
    assert.ok(report.result.text.includes(report.seed.receipt));
    assert.equal(await readFile(join(cwd, 'manifest.txt'), 'utf8'), 'The workspace file was externally replaced.');
    report.after = await fingerprints(); assert.deepEqual(report.after, report.before);
    report.passed = true;
  } catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ root, live, torn, passed: report.passed, status: report.metadataStatus, calls: report.calls, usage: report.result?.usage, error: report.error }));
  }
}
