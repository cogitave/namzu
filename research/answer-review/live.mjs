// Explicit, bounded live opt-in. Isolated state/workspace, borrowed provider login.
// Stores public answers and usage only; no credentials or native reasoning payloads.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert.ok(process.argv.includes('--live'), 'Pass --live for bounded model requests.');
const root = await mkdtemp(join(tmpdir(), 'namzu-answer-review-'));
const home = join(root, 'home'), cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd);
process.env.NAMZU_HOME = home;
const sdk = await import('../../packages/sdk/dist/index.js');
const storage = await import('../../packages/cli/dist/integrations/sessions/store.js');
const evidence = await import('../../packages/cli/dist/integrations/sessions/conversation-search.js');
const { discoverProviders } = await import('../../packages/cli/dist/integrations/providers/index.js');
const { createAgentSession } = await import('../../packages/cli/dist/tui/agent.js');
const model = 'gpt-5.6-luna';
const prefs = { version: 3, providers: [{ id: 'codex', model }], subagents: { active: [] } };
await writeFile(join(home, 'preferences.json'), JSON.stringify(prefs));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n');
const code = `RECEIPT-${randomUUID().slice(0, 8)}`;
const note = `Recorded receipt: ${code}\n`;
await writeFile(join(cwd, 'receipt.txt'), note);
const files = ['packages/sdk/dist/runtime/query/iteration/index.js', 'packages/sdk/dist/runtime/query/checkpoint.js', 'packages/cli/dist/tui/agent.js', 'packages/cli/dist/commands/run-stream.js', 'packages/providers/openai/dist/codex.js'];
async function hashes() {
  const result = {};
  for (const path of files) result[path] = createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex');
  return result;
}
const report = { root, model, effort: 'low', cases: [], limits: { seedIterations: 3, reviewModelCalls: 3, perRunTokens: 20000 } };
let session;
try {
  report.buildBefore = await hashes();
  // An actual CLI process creates the evidence. The following host-callback
  // checks use the CLI Session engine; they do not claim TUI rendering coverage.
  const args = ['--quiet', 'run-stream', '--trust', '--cwd', cwd, '--provider', 'codex', '--model', model, '--effort', 'low', '--max-iterations', '3', '--token-budget', '20000', '--session', 'review-source', 'Read only receipt.txt and report its recorded receipt. Do not change files or run commands.'];
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...args], { cwd, timeout: 90000, maxBuffer: 2000000 });
  const seed = stdout.trim().split('\n').map(JSON.parse);
  report.seed = { command: args, terminal: seed.filter(e => ['done', 'error', 'paused'].includes(e.kind)), usage: seed.filter(e => e.kind === 'usage'), tools: seed.filter(e => e.kind === 'tool-start').map(e => e.toolName) };
  assert.deepEqual(report.seed.tools, ['read']);
  assert.ok(seed.some(e => e.kind === 'done' && e.text.includes(code)));
  assert.ok(!seed.some(e => e.kind === 'error' || e.kind === 'paused'));
  const sessions = await storage.openSessions(cwd);
  const sessionId = await storage.resolveConversation(sessions, 'review-source');
  report.sessionId = sessionId;
  const search = await evidence.searchConversation(sessions, sessionId, { query: code });
  const address = search.matches.find(m => m.seq && m.runId);
  assert.ok(address, 'CLI must retain a tool observation.');
  const page = await evidence.readConversationEvidence(sessions, sessionId, address);
  assert.ok(page.complete && page.text.includes(code));
  const history = await storage.loadConversation(sessions, sessionId);
  const detected = (await discoverProviders({ skipProbes: true, skipKeychain: true, skipStored: true })).filter(p => p.entry.id === 'codex');
  assert.equal(detected.length, 1);
  const original = sdk.ProviderRegistry.create.bind(sdk.ProviderRegistry);
  let modelCalls = 0;
  sdk.ProviderRegistry.create = (...args) => {
    const result = original(...args);
    if (result.provider.id !== 'codex') return result;
    const chat = result.provider.chatStream.bind(result.provider);
    result.provider.chatStream = async function* (params) {
      if (++modelCalls > report.limits.reviewModelCalls) throw new Error('Experiment request ceiling');
      yield* chat(params);
    };
    return result;
  };
  for (const changedOwnership of [false, true]) {
    const record = { changedOwnership, reviews: 0, events: [] };
    report.cases.push(record);
    const before = modelCalls;
    session = await createAgentSession(prefs, detected, {
      cwd, scope: { sessionId, topicId: sessions.topicId, projectId: sessions.projectId, tenantId: sessions.tenantId },
      stateRoot: sessions.root, conversationSessions: sessions, sandbox: { enabled: false }, memory: { recall: false }, web: { search: 'off' },
      limits: { maxIterations: 4, tokenBudget: 20000 }, maxAnswerReviews: 1,
      async reviewAnswer(answer, context) {
        record.reviews++;
        if (changedOwnership) {
          const path = join(home, 'sessions', sessionId, 'runs', address.runId, 'run.json');
          const metadata = JSON.parse(await readFile(path, 'utf8'));
          metadata.metadata.scope.sessionId = randomUUID();
          await writeFile(path, JSON.stringify(metadata));
        }
        const source = await evidence.readConversationEvidence(sessions, sessionId, address, context.signal);
        if (!source.complete || source.retainedPreview) throw new Error('Incomplete evidence');
        const expected = /Recorded receipt: (RECEIPT-[\w-]+)/.exec(source.text)?.[1];
        if (!expected) throw new Error('No receipt in evidence');
        return answer.trim() === expected ? { accept: true } : { accept: false, feedback: `Return only the exact recorded receipt: ${expected}` };
      },
    });
    for await (const event of session.send([...history, sdk.createUserMessage('What was the recorded receipt? Return only its exact code from our conversation, without tools.')], { effort: 'low', signal: AbortSignal.timeout(60000), permissionMode: 'auto' })) {
      if (['done', 'error', 'paused', 'usage', 'tool-start'].includes(event.kind)) record.events.push(event);
    }
    record.modelCalls = modelCalls - before;
    await session.close(); session = undefined;
    assert.ok(!record.events.some(e => e.kind === 'tool-start'));
    if (changedOwnership) {
      assert.equal(record.modelCalls, 1);
      assert.ok(!record.events.some(e => e.kind === 'done' || e.kind === 'paused'));
      assert.ok(record.events.some(e => e.kind === 'error' && /Answer review failed:.*ownership/.test(e.message)));
    } else {
      assert.ok(record.events.some(e => e.kind === 'done' && e.text.trim() === code));
      assert.ok(!record.events.some(e => e.kind === 'error' || e.kind === 'paused'));
    }
  }
  assert.equal(await readFile(join(cwd, 'receipt.txt'), 'utf8'), note);
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  if (session) await session.close();
  report.buildAfter = await hashes();
  report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter);
  if (!report.buildStable) { report.passed = false; report.error = 'Build changed during measurement'; process.exitCode = 1; }
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, passed: report.passed, error: report.error }));
}
