import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = process.env.NAMZU_CAPTURE_CANCEL_ROOT;
const mode = process.env.NAMZU_CAPTURE_CANCEL_MODE;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function verifyCase({ root, mode, observations }) {
  const rows = (await readFile(join(root, 'stdout.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const failed = rows.find(e => e.kind === 'tool-end' && e.toolUseId === 'cancel-search');
  const recovered = rows.find(e => e.kind === 'tool-end' && e.toolUseId === 'next-search');
  assert.equal(failed?.isError, true);
  assert.match(failed.output, /timed out/);
  assert.equal(recovered?.isError, false);
  const search = JSON.parse(recovered.output);
  const original = search.matches.find(m => m.toolName === 'read' && m.source === 'tool_completed');
  assert.ok(original?.text.includes('ORCHID receipt A17'));
  assert.equal(original.runId, recovered.runId);
  assert.equal(original.retained, 'full');
  assert.equal(search.unavailableRuns, 0);
  assert.equal(rows.at(-1)?.stopReason, 'end_turn');
  const events = observations.events;
  assert.equal(events.find(e => e.event === 'store_started')?.hasSignal, true);
  assert.equal(observations.readCount, 1, 'Original file must not be read again');
  assert.equal(observations.toolCount, 2);
  if (mode === 'cooperative') assert.ok(events.some(e => e.event === 'store_aborted'));
  else assert.ok(events.findIndex(e => e.event === 'search_settled' && e.n === 1) < events.findIndex(e => e.event === 'store_settled'), 'Caller should stop waiting before uncooperative storage settles');
  return { runId: recovered.runId, recoveredSeq: original.seq, firstSearchFailed: true, followingSearchSucceeded: true, originalReads: observations.readCount, stopReason: 'end_turn' };
}

if (mode) {
  // Installed only in the child before the real CLI entrypoint. Script model
  // choices and inject slow storage, retaining production tools and execution.
  const sdk = await import('../../packages/sdk/dist/index.js');
  const events = [];
  const mark = (event, data = {}) => events.push({ event, at: performance.now(), ...data });
  let captureCount = 0;
  let toolCount = 0;
  let readCount = 0;
  const capture = sdk.RunDiskStore.prototype.captureTextEvidence;
  sdk.RunDiskStore.prototype.captureTextEvidence = async function (scope, maxReadBytes, signal) {
    captureCount++;
    if (captureCount !== 1) return capture.call(this, scope, maxReadBytes, signal);
    mark('store_started', { hasSignal: !!signal });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 350);
        if (mode !== 'cooperative' || !signal) return;
        const abort = () => {
          clearTimeout(timer);
          mark('store_aborted');
          reject(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      return await capture.call(this, scope, maxReadBytes, signal);
    } finally { mark('store_settled'); }
  };
  const register = sdk.ToolRegistry.prototype.register;
  const wrap = tool => {
    if (tool?.name === 'read') {
      const execute = tool.execute;
      return { ...tool, execute: async (...args) => { readCount++; return execute(...args); } };
    }
    if (tool?.name !== 'search_conversation') return tool;
    const execute = tool.execute;
    return { ...tool, timeoutMs: 100, maxRetries: 0, execute: async (...args) => {
      const n = ++toolCount;
      mark('search_started', { n });
      try { return await execute(...args); }
      finally { mark('search_settled', { n }); }
    } };
  };
  sdk.ToolRegistry.prototype.register = function (first, second) {
    if (Array.isArray(first)) return register.call(this, first.map(wrap), second);
    if (typeof first === 'string') return register.call(this, first, wrap(second));
    return register.call(this, wrap(first), second);
  };
  sdk.ProviderRegistry.create = () => ({ provider: new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'observe', name: 'read', args: { path: 'receipt.txt' } }] },
    { toolCalls: [{ id: 'cancel-search', name: 'search_conversation', args: { query: 'ORCHID' } }] },
    { toolCalls: [{ id: 'next-search', name: 'search_conversation', args: { query: 'ORCHID' } }] },
    { text: 'The next search completed after the first read was cancelled.' },
  ] }) });
  // Synchronous flush at exit is intentional: the CLI owns process.exit.
  const { writeFileSync } = await import('node:fs');
  process.on('exit', () => writeFileSync(join(root, 'observations.json'), JSON.stringify({ events, readCount, captureCount, toolCount }, null, 2)));
} else {
  const report = { entrypoint: 'CLI run-stream --session', provider: 'scripted; no external model requests', cases: [] };
  const paths = [
    'packages/sdk/dist/runtime/query/index.js', 'packages/sdk/dist/runtime/query/executor.js',
    'packages/sdk/dist/runtime/query/events.js', 'packages/sdk/dist/store/run/disk.js',
    'packages/sdk/dist/utils/await-with-abort.js', 'packages/cli/dist/tui/agent.js',
    'packages/cli/dist/commands/run-stream.js', 'packages/cli/dist/integrations/sessions/conversation-search.js',
  ];
  const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(new URL('../../' + path, import.meta.url)))])));
  if (process.argv.includes('--verify')) {
    const path = process.argv[process.argv.indexOf('--verify') + 1];
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved.before, await fingerprints());
    for (const result of saved.cases) result.verification = await verifyCase(result);
    await writeFile(path, JSON.stringify(saved, null, 2) + '\n');
    console.log('Verified saved CLI evidence without executing another run.');
    process.exit(0);
  }
  report.before = await fingerprints();
  for (const mode of ['cooperative', 'uncooperative']) {
    const root = await mkdtemp(join(tmpdir(), 'namzu-capture-cancel-cli-'));
    const home = join(root, 'home'); const cwd = join(root, 'workspace');
    await mkdir(home); await mkdir(cwd);
    await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
    await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: false\n');
    await writeFile(join(cwd, 'receipt.txt'), 'ORCHID receipt A17: retained observation.\n');
    const result = { mode, root, passed: false };
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [
        '--import', fileURLToPath(import.meta.url),
        fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)),
        'run-stream', '--session', 'capture-cancellation-probe', '--trust',
        '--max-iterations', '5', '--token-budget', '10000', '--',
        'Read receipt.txt once, then search earlier evidence twice to exercise cancellation.',
      ], { cwd, env: { ...process.env, NAMZU_HOME: home, NAMZU_CAPTURE_CANCEL_ROOT: root, NAMZU_CAPTURE_CANCEL_MODE: mode }, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      await writeFile(join(root, 'stdout.jsonl'), stdout);
      await writeFile(join(root, 'stderr.log'), stderr);
      const observations = JSON.parse(await readFile(join(root, 'observations.json'), 'utf8'));
      result.observations = observations;
      result.verification = await verifyCase(result);
      result.passed = true;
    } catch (error) {
      result.error = String(error);
      if (error.stdout) await writeFile(join(root, 'stdout.jsonl'), error.stdout);
      if (error.stderr) await writeFile(join(root, 'stderr.log'), error.stderr);
    }
    report.cases.push(result);
  }
  report.after = await fingerprints();
  assert.deepEqual(report.after, report.before, 'Production modules changed during the probe');
  const path = join(tmpdir(), 'namzu-capture-cancel-cli-results.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path, cases: report.cases.map(({ mode, root, passed, error }) => ({ mode, root, passed, error })) }, null, 2));
  if (report.cases.some(c => !c.passed)) process.exitCode = 1;
}
