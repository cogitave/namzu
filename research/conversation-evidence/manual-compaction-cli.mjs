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
const exec = promisify(execFile);
const automatic = process.argv.includes('--automatic');
const large = automatic || process.argv.includes('--large');
const dense = process.argv.includes('--dense');

if (process.argv[2] === '--seed') {
  const sdk = await import(sdkURL);
  const { openSessions, resolveConversation, replaceConversation } = await import(storeURL);
  const { createAgentSession, probeAgentSession } = await import(agentURL);
  const cwd = process.argv[3];
  const sessions = await openSessions(cwd);
  const sessionId = await resolveConversation(sessions, 'manual-compaction');
  const code = `ORCHID-${randomUUID()}`;
  const original = `Background ${'ordinary context '.repeat(150)} ORCHID receipt code: ${code}`;
  const messages = [sdk.createUserMessage(original, large ? [{ data: 'A'.repeat(5 * 1024 * 1024), mediaType: 'image/png' }] : undefined), sdk.createAssistantMessage('Acknowledged.')];
  if (dense) messages.unshift(...Array.from({ length: 127 }, () => sdk.createUserMessage('ordinary '.repeat(900))));
  for (let i = 0; i < (automatic ? 18 : 4); i++) messages.push(sdk.createUserMessage(`Later question ${i}`), sdk.createAssistantMessage(`Later answer ${i} ${automatic ? 'Background explanation. '.repeat(200) : ''}`));
  const provider = new sdk.MockLLMProvider({ turns: [{ text: 'Ready.' }] });
  const probe = await probeAgentSession();
  sdk.ProviderRegistry.create = () => ({ provider });
  const session = await createAgentSession(probe.preferences, probe.detected, {
    cwd, stateRoot: sessions.root, conversationSessions: sessions,
    scope: { sessionId, topicId: sessions.topicId, projectId: sessions.projectId, tenantId: sessions.tenantId },
    sandbox: { enabled: false }, web: { search: 'off' }, memory: { recall: false },
    limits: { maxIterations: 4, tokenBudget: 20000 },
    ...(automatic ? { compaction: { strategy: 'structured', contextWindowTokens: 20000 } } : {}),
  });
  let compacted;
  const sourceRunId = sdk.generateRunId();
  let projected; let sawAutomatic = false;
  try {
    await replaceConversation(sessions, sessionId, messages);
    for await (const event of session.send(messages, { runId: sourceRunId, permissionMode: 'auto', onConversationMessages: (value) => { projected = value; } })) {
      if (event.kind === 'context' && event.shed) sawAutomatic = true;
    }
    if (automatic) {
      assert.ok(sawAutomatic && projected);
      assert.ok(!projected.some(message => message.attachments?.length));
      compacted = { messages: projected, shed: messages.length - projected.length, usage: { totalTokens: 0 } };
    } else compacted = await session.compact(messages); // exact /compact entry point, no manufactured summary
    assert.ok(compacted && !JSON.stringify(compacted.messages).includes(code));
    await replaceConversation(sessions, sessionId, compacted.messages);
  } finally { await session.close(); }
  const runs = join(sessions.root, 'sessions', sessionId, 'runs');
  let archive;
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const run = entry.name;
    const meta = JSON.parse(await readFile(join(runs, run, 'run.json'), 'utf8'));
    if (automatic ? run !== sourceRunId : meta.metadata.agentId !== 'manual-compaction') continue;
    const events = await sdk.readRunEventsIn(join(runs, run), { integrity: 'strict' });
    assert.ok(events.some(e => e.type === 'compaction_shed' && e.reason === (automatic ? 'threshold' : 'manual') && e.messages.some(m => m.role === 'user' && m.content === original)));
    if (large) assert.ok(events.some(e => e.type === 'compaction_shed' && e.messages.some(m => m.content === original && m.attachments?.[0]?.data === 'A'.repeat(5 * 1024 * 1024))));
    assert.equal(meta.tokenUsage.totalTokens, 0);
    assert.ok(!events.some(e => e.type === 'tool_executing' || (!automatic && e.type === 'message_completed')));
    if (large) assert.ok((await readFile(join(runs, run, 'transcript.jsonl'), 'utf8')).includes('"type":"compaction_archive"'));
    archive = run;
  }
  assert.ok(archive);
  assert.equal(provider.requests.length, 1);
  console.log(JSON.stringify({ sessionId, code, archive, automatic, large, sawAutomatic, shed: compacted.shed, verifierTokens: compacted.usage.totalTokens, exactOriginalArchived: true, originalAbsentFromProjection: true }));
} else {
  const live = process.argv.includes('--live');
  const root = await mkdtemp(join(tmpdir(), 'namzu-manual-compaction-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n');
  const env = { ...process.env, NAMZU_HOME: home };
  const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
  const report = { root, live, automatic, large, dense, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low' };
  const fingerprintPaths = ['packages/sdk/dist/compaction/manual.js', 'packages/sdk/dist/store/evidence/compaction-archive.js', 'packages/sdk/dist/store/evidence/index-page.js', 'packages/sdk/dist/store/evidence/source-text.js', 'packages/sdk/dist/store/run/disk.js', 'packages/cli/dist/integrations/sessions/compaction-evidence.js', 'packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/cli/dist/tui/agent.js'];
  const fingerprints = async () => Object.fromEntries(await Promise.all(fingerprintPaths.map(async path => [path, createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex')])));
  fingerprintPaths.push('packages/sdk/dist/store/evidence/disk.js', 'packages/sdk/dist/store/evidence/linked.js');
  report.before = await fingerprints();
  try {
    const seed = await exec(process.execPath, [fileURLToPath(import.meta.url), '--seed', cwd, ...(automatic ? ['--automatic'] : large ? ['--large'] : []), ...(dense ? ['--dense'] : [])], { cwd, env, timeout: 30000, maxBuffer: 1000000 });
    report.seed = JSON.parse(seed.stdout);
    const preload = join(root, 'scripted-provider.mjs');
    await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
const parse=(content)=>{const t=String(content);return JSON.parse(t.slice(t.indexOf('{'),t.lastIndexOf('}')+1));};
let address;let recovered='';
ProviderRegistry.create=()=>({provider:{id:'scripted',name:'scripted',async *chatStream(params){
const last=params.messages.filter(m=>m.role==='tool').at(-1);let turn;
if(!last)turn={toolCalls:[{id:'search',name:'search_conversation',args:{query:'ORCHID'}}]};
else{const page=parse(last.content);if(last.toolCallId.startsWith('search')){const m=page.matches?.find(m=>m.source==='compaction_shed:user');
if(m)address={runId:m.runId,seq:m.seq,part:m.part,byteOffset:m.byteOffset};
turn=m?{toolCalls:[{id:'read',name:'read_conversation',args:address}]}:{toolCalls:[{id:'search-'+params.messages.length,name:'search_conversation',args:{cursor:page.nextCursor}}]};
}else{recovered+=page.text;turn=page.nextCursor?{toolCalls:[{id:'read-'+params.messages.length,name:'read_conversation',args:{...address,cursor:page.nextCursor}}]}:{text:recovered};}}yield*new MockLLMProvider({turns:[turn]}).chatStream(params);}}});`);
    const prompt = 'What was the exact ORCHID receipt code I supplied earlier? Recover the original conversation passage before answering. Do not use workspace files, commands, or the network.';
    const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', report.seed.sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '6', '--token-budget', dense ? '45000' : '35000', prompt];
    report.command = args;
    const { stdout } = await exec(process.execPath, [...(live ? [] : ['--import', preload]), cli, ...args], { cwd, env, timeout: 150000, maxBuffer: 2000000 });
    report.result = JSON.parse(stdout);
    const events = [];
    const runs = join(home, 'sessions', report.seed.sessionId, 'runs');
    for (const entry of await readdir(runs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      events.push(...(await readFile(join(runs, entry.name, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse));
    }
    report.calls = events.filter(e => e.type === 'tool_executing').map(e => ({ name: e.toolName, input: e.input }));
    report.outputs = events.filter(e => e.type === 'tool_completed').map(e => ({ name: e.toolName, isError: e.isError, result: e.result }));
    assert.ok(report.result.text.includes(report.seed.code));
    assert.ok(report.calls.some(e => e.name === 'search_conversation'));
    assert.ok(report.calls.some(e => e.name === 'read_conversation'));
    report.exactReadObserved = report.outputs.some(e => {
      if (e.name !== 'read_conversation' || e.isError) return false;
      const page = JSON.parse(e.result);
      return page.retainedPreview === false && typeof page.text === 'string' && page.text.includes(report.seed.code);
    });
    assert.ok(report.exactReadObserved, 'The original receipt must appear in an exact read result, not only a search excerpt.');
    assert.ok(report.calls.every(e => ['search_conversation', 'read_conversation', 'search_tools'].includes(e.name)));
    assert.ok(report.outputs.every(e => !e.isError));
    report.after = await fingerprints();
    assert.deepEqual(report.after, report.before);
    report.passed = true;
  } catch(error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
  finally {
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ root, live, passed: report.passed, calls: report.calls, usage: report.result?.usage, error: report.error }));
  }
}
