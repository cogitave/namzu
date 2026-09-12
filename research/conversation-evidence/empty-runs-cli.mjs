// Bounded multi-run discovery measurement. --live opts into a small-model check.
// The original observation is produced by the existing real CLI Session fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const exec = promisify(execFile);
const baseline = process.argv.includes('--baseline');
const live = process.argv.includes('--live');
assert.ok(!(baseline && live), 'The baseline measures discovery without paid inference.');
const root = await mkdtemp(join(tmpdir(), 'namzu-empty-run-search-'));
const home = join(root, 'home'), cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd);
process.env.NAMZU_HOME = home;
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n');
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const sdk = await import(sdkURL);
const storage = await import('../../packages/cli/dist/integrations/sessions/store.js');
const evidence = await import('../../packages/cli/dist/integrations/sessions/conversation-search.js');
const cliURL = new URL('../../packages/cli/dist/bin.js', import.meta.url);
const files = ['packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/sdk/dist/store/evidence/disk.js', 'packages/cli/dist/tui/agent.js'];
async function hashes() {
  const result = {};
  for (const path of files) result[path] = createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex');
  return result;
}
const report = { root, baseline, live, noiseRuns: 32, passes: [] };
try {
  report.buildBefore = await hashes();
  const seed = await exec(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--seed', cwd], { cwd, timeout: 30000, maxBuffer: 1000000 });
  report.seed = JSON.parse(seed.stdout);
  const sessions = await storage.openSessions(cwd);
  const sessionId = sdk.asSessionId(report.seed.sessionId);
  const runs = join(home, 'sessions', sessionId, 'runs');
  for (let i = 0; i < report.noiseRuns; i++) {
    const runId = sdk.asRunId(`00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`);
    assert.ok(runId < report.seed.runId);
    const store = new sdk.RunDiskStore({ baseDir: runs });
    await store.initRun(runId);
    await store.appendEvent({ type: 'run_started', runId, seq: 1 });
    await store.appendEvent({ type: 'message_completed', runId, seq: 2, content: `Unrelated observation ${i}: packing unchanged.` });
    await store.appendEvent({ type: 'run_completed', runId, seq: 3 });
    await writeFile(join(runs, runId, 'run.json'), JSON.stringify({ id: runId, status: 'completed', metadata: { scope: { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId } } }));
  }
  // Cold index and warm index runs over the same isolated corpus. No model calls.
  for (const temperature of ['cold', 'warm']) {
    const pass = { temperature, pages: [], elapsedMs: 0 };
    const start = performance.now();
    let cursor;
    let found;
    for (let n = 0; n < 64; n++) {
      const page = await evidence.searchConversation(sessions, sessionId, cursor ? { cursor } : { query: 'DELTA' });
      pass.pages.push({ matches: page.matches.length, scannedRuns: page.scannedRuns, scannedBytes: page.scannedBytes, incomplete: page.incomplete, continues: !!page.nextCursor });
      assert.ok(page.scannedBytes <= 8 * 1024 * 1024);
      found = page.matches.find(m => m.runId === report.seed.runId && m.seq === report.seed.seq);
      cursor = page.nextCursor;
      if (found || !cursor) break;
    }
    pass.elapsedMs = performance.now() - start;
    report.passes.push(pass);
    assert.ok(found, 'The original retained tool observation must be found.');
    assert.equal(pass.pages.length, baseline ? report.noiseRuns + 1 : 1);
    const exact = await evidence.readConversationEvidence(sessions, sessionId, found);
    assert.ok(exact.text.includes(report.seed.tracking));
  }
  await evidence.releaseConversationEvidence(sessions, sessionId);
  if (!baseline) {
    // Reopen discovery in the actual CLI process. No run ID is supplied in the prompt.
    const preload = join(root, 'scripted.mjs');
    await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
ProviderRegistry.create=()=>({provider:{id:'scripted',name:'scripted',async *chatStream(params){
 const result=params.messages.filter(m=>m.role==='tool').at(-1); let turn;
 if(!result)turn={toolCalls:[{id:'find',name:'search_conversation',args:{query:'DELTA'}}]};
 else { const text=String(result.content), page=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
  if(result.toolCallId==='find'){const m=page.matches.find(m=>m.source==='tool_completed'); if(!m)throw new Error('No observation found');turn={toolCalls:[{id:'read',name:'read_conversation',args:{runId:m.runId,seq:m.seq,part:m.part,byteOffset:m.byteOffset}}]};}
  else turn={text:page.text};
 } yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
}}});`);
    const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '5', '--token-budget', '40000', 'What were the original DELTA tracking code and destination? The workspace file was replaced. Recover them from the recorded conversation and read the original passage. Do not read or change workspace files, run commands, or use external services.'];
    const result = await exec(process.execPath, [...(live ? [] : ['--import', preload]), fileURLToPath(cliURL), ...args], { cwd, timeout: 90000, maxBuffer: 2000000 });
    report.command = args;
    report.result = JSON.parse(result.stdout);
    report.calls = [];
    report.toolErrors = [];
    report.searchAddresses = [];
    for (const entry of await readdir(runs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === report.seed.runId || entry.name.startsWith('00000000-')) continue;
      const events = (await readFile(join(runs, entry.name, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      report.calls.push(...events.filter(e => e.type === 'tool_executing').map(e => ({ name: e.toolName, input: e.input })));
      report.toolErrors.push(...events.filter(e => e.type === 'tool_completed' && e.isError).map(e => ({ name: e.toolName, result: e.result })));
      for (const event of events.filter(e => e.type === 'tool_completed' && e.toolName === 'search_conversation' && !e.isError))
        report.searchAddresses.push(...JSON.parse(event.result).matches.map(m => ({ runId: m.runId, seq: m.seq, part: m.part, byteOffset: m.byteOffset })));
    }
    assert.ok(report.result.text.includes(report.seed.tracking) && report.result.text.includes(report.seed.destination));
    assert.equal(report.calls[0]?.name, 'search_conversation');
    assert.equal(report.calls.filter(c => c.name === 'search_conversation').length, 1);
    const reads = report.calls.slice(1);
    // The question asks for two fields. Reading each returned passage is valid;
    // the discovery optimization does not require one read to answer both.
    assert.ok(reads.length >= 1 && reads.length <= 2);
    assert.ok(reads.every(c => c.name === 'read_conversation' && report.searchAddresses.some(a =>
      ['runId', 'seq', 'part', 'byteOffset'].every(key => a[key] === c.input[key]))));
    assert.equal(report.toolErrors.length, 0);
  }
  assert.match(await readFile(join(cwd, 'manifest.txt'), 'utf8'), /^Manually replaced/);
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  report.buildAfter = await hashes();
  report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter);
  if (!report.buildStable) { report.passed = false; report.error = 'Build changed during measurement'; process.exitCode = 1; }
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, passed: report.passed, baseline, live, pages: report.passes.map(p => p.pages.length), tokens: report.result?.usage, error: report.error }));
}
