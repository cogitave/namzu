import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const storeURL = new URL('../../packages/cli/dist/integrations/sessions/store.js', import.meta.url);
const agentURL = new URL('../../packages/cli/dist/tui/agent.js', import.meta.url);
if (process.argv[2] === '--seed') {
  const sdk = await import(sdkURL);
  const { openSessions, resolveConversation, replaceConversation } = await import(storeURL);
  const { createAgentSession, probeAgentSession } = await import(agentURL);
  const cwd = process.argv[3];
  const sessions = await openSessions(cwd);
  const sessionId = await resolveConversation(sessions, 'receipt-check');
  const tracking = `TRACK-${randomUUID()}`;
  const destination = `DEPOT-${randomUUID()}`;
  const rows = Array.from({ length: 400 }, (_, i) => i === 210
    ? `DELTA original receipt. Tracking: ${tracking}.`
    : i === 213 ? `Destination of the DELTA receipt: ${destination}.`
    : `Inspection row ${i}: ${'α🦉 packaging unchanged; '.repeat(30)}`);
  await writeFile(join(cwd, 'manifest.txt'), rows.join('\n'));
  const provider = new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'observe-original-once', name: 'read', args: { path: 'manifest.txt' } }] },
    { text: 'Manifest observed; original receipt retained.' },
  ] });
  const probe = await probeAgentSession();
  sdk.ProviderRegistry.create = () => ({ provider });
  const runId = sdk.generateRunId();
  const session = await createAgentSession(probe.preferences, probe.detected, {
    cwd, stateRoot: sessions.root, conversationSessions: sessions,
    scope: { sessionId, topicId: sessions.topicId, tenantId: sessions.tenantId, projectId: sessions.projectId },
    sandbox: { enabled: false }, web: { search: 'off' }, memory: { recall: false },
    limits: { maxIterations: 4, tokenBudget: 20000 },
  });
  try {
    for await (const _event of session.send([sdk.createUserMessage('Read the original manifest once.')], { runId, permissionMode: 'auto' })) { /* real CLI Session */ }
  } finally { await session.close(); }
  const runDir = join(sessions.root, 'sessions', sessionId, 'runs', runId);
  const events = (await readFile(join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const tool = events.find(e => e.type === 'tool_completed' && e.toolName === 'read');
  assert.ok(tool && !tool.isError && tool.outputTruncated && tool.outputSpillIntegrity);
  assert.ok(!tool.result.includes(tracking) && !tool.result.includes(destination));
  await replaceConversation(sessions, sessionId, [sdk.createUserMessage('Compacted summary: the DELTA manifest was observed. Its exact identifiers are retained in the earlier tool result. The workspace file was subsequently replaced.')]);
  await writeFile(join(cwd, 'manifest.txt'), 'Manually replaced. No original receipt remains here.\n');
  console.log(JSON.stringify({ sessionId, runId, runDir, tracking, destination, seq: tool.seq,
    originalNotInPreview: true, originalNotInProjection: true,
    seededWith: 'scripted provider through real CLI Session, read tool and kernel persistence' }));
} else {
  const live = process.argv.includes('--live');
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'namzu-conversation-evidence-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n');
  const env = { ...process.env, NAMZU_HOME: home };
  const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
  const report = { root, live, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low' };
  try {
    const seed = await exec(process.execPath, [fileURLToPath(import.meta.url), '--seed', cwd], { cwd, env, timeout: 30_000, maxBuffer: 1_000_000 });
    report.seed = JSON.parse(seed.stdout);
    // The deterministic command-boundary test uses a scripted provider. The
    // production CLI still owns scopes, discovery, tool calls and storage.
    const preload = join(root, 'scripted-provider.mjs');
    await writeFile(preload, `import {ProviderRegistry, MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
const parse = (content) => { const text=String(content); return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}')+1)); };
ProviderRegistry.create=()=>({provider:{id:'scripted',name:'scripted',async *chatStream(params){
 const result=params.messages.filter(m=>m.role==='tool').at(-1); let turn;
 if(!result) turn={toolCalls:[{id:'search',name:'search_conversation',args:{query:'DELTA',runId:${JSON.stringify(report.seed.runId)}}}]};
 else { const page=parse(result.content);
  if(result.toolCallId.startsWith('search')) {
   const match=page.matches?.[0];
   turn=match ? {toolCalls:[{id:'read',name:'read_conversation',args:{runId:match.runId,seq:match.seq,part:match.part,byteOffset:match.byteOffset}}]}
    : {toolCalls:[{id:'search-'+params.messages.length,name:'search_conversation',args:{query:'DELTA',runId:${JSON.stringify(report.seed.runId)},cursor:page.nextCursor}}]};
  } else if (!page.text && page.nextCursor) turn={toolCalls:[{id:'read-'+params.messages.length,name:'read_conversation',args:{runId:page.runId,seq:page.seq,part:page.part,cursor:page.nextCursor}}]};
  else turn={text:page.text};
 }
 yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
}}});`);
    const prompt = 'Recover the exact tracking code and destination from the original DELTA receipt in this conversation. The workspace file has changed. Search the recorded conversation, then read the retained original passage before reporting both exact identifiers. Do not read workspace files, edit anything, run commands, or contact external services.';
    const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', report.seed.sessionId,
      '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '10', '--token-budget', '50000', prompt];
    const { stdout } = await exec(process.execPath, [...(live ? [] : ['--import', preload]), cli, ...args], { cwd, env, timeout: 180_000, maxBuffer: 2_000_000 });
    report.command = args;
    report.result = JSON.parse(stdout);
    assert.ok(report.result.text.includes(report.seed.tracking));
    assert.ok(report.result.text.includes(report.seed.destination));
    const sessionDir = join(home, 'sessions', report.seed.sessionId, 'runs');
    const events = [];
    for (const run of await readdir(sessionDir, { withFileTypes: true })) {
      if (!run.isDirectory() || run.name === report.seed.runId) continue;
      const raw = await readFile(join(sessionDir, run.name, 'transcript.jsonl'), 'utf8');
      events.push(...raw.trim().split('\n').map(JSON.parse));
    }
    report.calls = events.filter(e => e.type === 'tool_executing').map(e => ({ name: e.toolName, input: e.input }));
    report.outputs = events.filter(e => e.type === 'tool_completed').map(e => ({ name: e.toolName, isError: e.isError, result: e.result }));
    assert.ok(report.calls.some(e => e.name === 'search_conversation'));
    assert.ok(report.calls.some(e => e.name === 'read_conversation'));
    assert.ok(report.calls.every(e => ['search_conversation', 'read_conversation', 'search_tools'].includes(e.name)));
    assert.ok(report.outputs.every(e => !e.isError));
    assert.match(await readFile(join(cwd, 'manifest.txt'), 'utf8'), /^Manually replaced/);
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  } finally {
    report.fingerprints = {};
    for (const path of ['packages/sdk/src/store/evidence/disk.ts','packages/sdk/src/store/evidence/index-page.ts','packages/sdk/src/store/evidence/format.ts','packages/cli/src/integrations/sessions/conversation-search.ts','packages/cli/src/tui/agent.ts','packages/cli/src/commands/run.ts','research/conversation-evidence/cli.mjs'])
      report.fingerprints[path] = createHash('sha256').update(await readFile(new URL('../../'+path, import.meta.url))).digest('hex');
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2)+'\n');
    console.log(JSON.stringify({ root, live, passed: report.passed, calls: report.calls, usage: report.result?.usage, error: report.error }));
  }
}
