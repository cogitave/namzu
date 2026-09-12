import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const agentURL = new URL('../../packages/cli/dist/tui/agent.js', import.meta.url);
const sessionsURL = new URL('../../packages/cli/dist/integrations/sessions/store.js', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.env.NAMZU_EFFECT_PROBE_MODE;

// Only the probe children install these adapters. The parent and production
// modules are unchanged. The resume child enters through the real CLI binary.
if (mode === 'resume') {
  const sdk = await import(sdkURL);
  const create = sdk.ProviderRegistry.create;
  sdk.ProviderRegistry.create = function (...args) {
    const result = process.env.NAMZU_EFFECT_PROBE_LIVE === '1'
      ? create.apply(this, args)
      : { provider: new sdk.MockLLMProvider({ turns: [{ text: 'The effect is unknown; inspect its external state before any retry.' }] }) };
    const provider = result.provider;
    const stream = provider.chatStream.bind(provider);
    provider.chatStream = async function* (params) {
      // Explicitly bound effort for the live research run. This adapter does
      // not replace tools, recovery decisions, persistence or provider output.
      const bounded = { ...params, effort: 'low' };
      await writeFile(join(process.env.NAMZU_EFFECT_PROBE_ROOT, 'request.json'), JSON.stringify(bounded, null, 2));
      yield* stream(bounded);
    };
    return result;
  };
} else if (mode === 'seed') {
  const sdk = await import(sdkURL);
  const { openSessions, startConversation } = await import(sessionsURL);
  const { createAgentSession, probeAgentSession } = await import(agentURL);
  const cwd = process.cwd();
  const sessions = await openSessions(cwd);
  const sessionId = await startConversation(sessions);
  const runId = sdk.generateRunId();
  const scope = { sessionId, tenantId: sessions.tenantId, projectId: sessions.projectId, topicId: sessions.topicId };
  const execute = sdk.BashTool.execute.bind(sdk.BashTool);
  sdk.BashTool.execute = async (...args) => {
    const result = await execute(...args);
    assert.equal(result.success, true);
    assert.equal(await readFile(join(cwd, 'counter.txt'), 'utf8'), '1');
    // The real shell command has exited; there is no orphan shell to kill.
    // Hold exactly between the external effect and the recorded tool result.
    process.send({ ...scope, runId, root: sessions.root });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
  sdk.ProviderRegistry.create = () => ({ provider: new sdk.MockLLMProvider({ turns: [{ toolCalls: [
    { id: 'inspect', name: 'read', args: { path: 'record-once.cjs' } },
    { id: 'effect', name: 'bash', args: { command: 'node record-once.cjs' } },
  ] }] }) });
  const probe = await probeAgentSession();
  const session = await createAgentSession(probe.preferences, probe.detected, {
    cwd, stateRoot: sessions.root, conversationSessions: sessions, scope,
    sandbox: { enabled: false }, web: { search: 'off' }, memory: { recall: false },
    limits: { maxIterations: 6, tokenBudget: 35000 },
  });
  assert.equal(session.hasProvider, true, session.errorHint);
  for await (const _event of session.send([sdk.createUserMessage('Inspect record-once.cjs and run it exactly once. It increments counter.txt. Report the result.')], { runId, permissionMode: 'auto' })) { /* parent kills before tool completion */ }
} else {
  const live = process.argv.includes('--live');
  const root = await mkdtemp(join(tmpdir(), 'namzu-unknown-effect-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\nlimits:\n  maxIterations: 6\n  tokenBudget: 35000\n');
  await writeFile(join(cwd, 'counter.txt'), '0');
  await writeFile(join(cwd, 'record-once.cjs'), "const fs = require('node:fs');\nconst count = Number(fs.readFileSync('counter.txt', 'utf8')) + 1;\nfs.writeFileSync('counter.txt', String(count));\nconsole.log('Recorded count: ' + count);\n");
  const env = { ...process.env, NAMZU_HOME: home, NAMZU_EFFECT_PROBE_ROOT: root };
  const report = { root, live, model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low', entrypoint: 'CLI drain', limits: { maxIterations: 6, tokenBudget: 35000, timeoutMs: 150000 } };
  const paths = ['packages/sdk/dist/runtime/query/index.js', 'packages/sdk/dist/runtime/query/resume-pending.js', 'packages/sdk/dist/runtime/query/executor.js', 'packages/sdk/dist/store/run/tool-executions.js', 'packages/sdk/dist/store/run/disk.js', 'packages/sdk/dist/tools/builtins/bash.js', 'packages/cli/dist/tui/agent.js', 'packages/cli/dist/commands/drain.js'];
  const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(new URL('../../' + path, import.meta.url)))])));
  let child;
  try {
    report.before = await fingerprints();
    child = fork(fileURLToPath(import.meta.url), [], { cwd, env: { ...env, NAMZU_EFFECT_PROBE_MODE: 'seed' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-100000); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    report.seed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Seed timed out: ' + stderr)), 30000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Seed exited: ${code} ${signal} ${stderr}`)); });
    });
    child.kill('SIGKILL'); report.seedExit = await exited;
    assert.equal(report.seedExit.signal, 'SIGKILL');
    const runDir = join(home, 'sessions', report.seed.sessionId, 'runs', report.seed.runId);
    const transcriptPath = join(runDir, 'transcript.jsonl');
    const raw = await readFile(transcriptPath, 'utf8');
    await writeFile(join(root, 'original.jsonl'), raw);
    const original = raw.trim().split('\n').map(JSON.parse);
    assert.ok(original.some(e => e.type === 'tool_completed' && e.toolUseId === 'inspect'));
    assert.ok(original.some(e => e.type === 'tool_executing' && e.toolUseId === 'effect'));
    assert.ok(!original.some(e => e.type === 'tool_completed' && e.toolUseId === 'effect'));
    report.counterBefore = Number(await readFile(join(cwd, 'counter.txt'), 'utf8'));
    assert.equal(report.counterBefore, 1);
    const cliPath = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
    const args = ['--import', fileURLToPath(import.meta.url), cliPath, '--quiet', '--format', 'json', 'drain', '--trust', '--cwd', cwd, '--store', join(home, 'sessions', report.seed.sessionId, 'runs'), '--tenant', report.seed.tenantId, '--project', report.seed.projectId, '--session', report.seed.sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna'];
    const result = await promisify(execFile)(process.execPath, args, { cwd, env: { ...env, NAMZU_EFFECT_PROBE_MODE: 'resume', NAMZU_EFFECT_PROBE_LIVE: live ? '1' : '0' }, timeout: 150000, maxBuffer: 500000 });
    await writeFile(join(root, 'stdout.log'), result.stdout); await writeFile(join(root, 'stderr.log'), result.stderr);
    const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
    assert.ok(request.messages.some(m => m.role === 'tool' && m.toolCallId === 'effect' && m.isError && m.content.includes('outcome is unknown')));
    report.counterAfter = Number(await readFile(join(cwd, 'counter.txt'), 'utf8'));
    assert.equal(report.counterAfter, 1);
    const final = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(JSON.parse);
    report.toolStarts = final.filter(e => e.type === 'tool_executing').map(e => ({ toolUseId: e.toolUseId, toolName: e.toolName }));
    assert.equal(report.toolStarts.filter(e => e.toolName === 'bash').length, 1);
    const metadata = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    report.status = metadata.status; report.usage = metadata.tokenUsage; report.budget = metadata.budget;
    assert.equal(report.status, 'completed');
    report.after = await fingerprints(); assert.deepEqual(report.after, report.before);
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.message;
    if (error.stdout) await writeFile(join(root, 'stdout.log'), error.stdout);
    if (error.stderr) await writeFile(join(root, 'stderr.log'), error.stderr);
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL'); await exited;
    }
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ root, passed: report.passed, before: report.counterBefore, after: report.counterAfter, error: report.error }));
  }
}
