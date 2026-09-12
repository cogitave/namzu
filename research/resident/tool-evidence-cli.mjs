import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Seed with a scripted provider, through the real CLI resident callback and
// real read tool. No invented transcript/receipt. The later --live invocation
// is the actual small-model experiment; seeding is never reported as live AI.
if (process.argv[2] === '--seed') {
  const sdk = await import('../../packages/sdk/dist/index.js');
  const { lookupResident } = await import('../../packages/cli/dist/integrations/resident/storage.js');
  const { openSessions } = await import('../../packages/cli/dist/integrations/sessions/store.js');
  const { createResidentSessionStep } = await import('../../packages/cli/dist/integrations/resident/session-step.js');
  const { parseRunFlags } = await import('../../packages/cli/dist/commands/run-flags.js');
  const cwd = process.argv[3];
  const resident = await lookupResident(cwd, 'default');
  assert.ok(resident);
  const sessions = await openSessions(cwd);
  const pursuit = (await resident.agenda.read()).pursuits[0];
  const tracking = `TRACK-${randomUUID()}`;
  const destination = `DEPOT-${randomUUID()}`;
  const lines = Array.from({ length: 400 }, (_, i) => i === 210
    ? `DELTA original receipt. Tracking: ${tracking}. Destination: ${destination}.`
    : `Inspection row ${i}: ${'packaging unchanged; '.repeat(30)}`);
  await writeFile(join(cwd, 'manifest.txt'), lines.join('\n'));
  const provider = new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'observe-manifest-once', name: 'read', args: { path: 'manifest.txt' } }] },
    { text: '{"kind":"wait","summary":"Manifest observed and retained. Await recipient confirmation.","wakeAfterMs":null}' },
  ] });
  sdk.ProviderRegistry.create = () => ({ provider });
  const execution = resident.agenda.execution(pursuit.id);
  const claim = await execution.claim(pursuit.state, Date.now());
  const step = createResidentSessionStep({
    cwd, sessions, agenda: resident.agenda, artifactsRoot: resident.artifactsRoot,
    ctx: { config: { sandbox: { enabled: false }, web: { search: 'off' } }, formatter: { name: 'text', print() {}, info() {}, error() {} } },
    flags: parseRunFlags(['--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '4', '--token-budget', '20000']),
    toolLoading: 'deferred', contextProfile: 'resident',
  });
  const result = await step({ ...pursuit, state: claim }, new AbortController().signal, { agendaRevision: (await resident.agenda.read()).revision });
  await execution.settle(claim, result, Date.now());
  const start = JSON.parse(await readFile(join(resident.artifactsRoot, claim.claimId, 'start.json'), 'utf8'));
  const runDir = join(sessions.root, 'sessions', start.sessionId, 'runs', start.runId);
  const events = (await readFile(join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const observation = events.find(event => event.type === 'tool_completed' && event.toolName === 'read');
  assert.ok(observation && !observation.isError && observation.outputTruncated);
  assert.match(observation.outputSpillIntegrity, /^[a-f0-9]{64}$/);
  assert.ok(!observation.result.includes(tracking));
  assert.ok(!observation.result.includes(destination));
  await writeFile(join(cwd, 'manifest.txt'), 'Manually replaced. The original receipt is no longer in this workspace file.\n');
  console.log(JSON.stringify({ tracking, destination, revision: (await resident.agenda.read()).revision, claimId: claim.claimId, start, runDir, originalNotInPreview: true, seededWith: 'scripted provider, real CLI resident callback and read tool' }));
} else {
  const live = process.argv.includes('--live');
  const profile = process.argv.includes('--interactive') ? 'interactive' : 'resident';
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'namzu-tool-evidence-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n');
  const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
  const env = { ...process.env, NAMZU_HOME: home };
  const report = { root, live, profile, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', commands: [] };
  async function command(args) {
    const { stdout } = await exec(process.execPath, [cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd], { cwd, env, timeout: 180_000, maxBuffer: 3_000_000 });
    const result = JSON.parse(stdout); report.commands.push({ args, result }); return result;
  }
  try {
    const added = await command(['add', '--trust', 'Recover the exact tracking code and destination from the original DELTA receipt after the recipient confirms. The receipt was previously observed by a tool, but its workspace file can change. Use retained original tool text, reading the relevant original passage before reporting. Do not send anything, edit files, run commands, or reread the mutable workspace file. Complete only with both exact identifiers.']);
    const id = added.agenda.pursuits[0].id;
    const seeded = await exec(process.execPath, [fileURLToPath(import.meta.url), '--seed', cwd], { cwd, env, timeout: 30_000, maxBuffer: 1_000_000 });
    report.seed = JSON.parse(seeded.stdout);
    const status = await command(['status']);
    assert.ok(!JSON.stringify(status.agenda.pursuits[0].state).includes(report.seed.tracking));
    await command(['wake', id, 'The recipient confirms DELTA. Recover the original recorded tool receipt and report its exact tracking code and destination now.']);
    if (live) {
      const finished = await command(['run', '--trust', '--max-steps', '1', '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--context-profile', profile, '--tool-loading', 'deferred', '--max-iterations', '8', '--token-budget', '40000']);
      const state = finished.agenda.pursuits[0].state;
      report.observed = { phase: state.phase, summary: state.summary };
      assert.equal(state.phase, 'complete');
      assert.ok(state.summary.includes(report.seed.tracking));
      assert.ok(state.summary.includes(report.seed.destination));
      const starts = []; const finishes = []; const tools = [];
      async function collect(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collect(path);
          else if (entry.name === 'start.json') starts.push(JSON.parse(await readFile(path, 'utf8')));
          else if (entry.name === 'finish.json') finishes.push(JSON.parse(await readFile(path, 'utf8')));
          else if (entry.name === 'transcript.jsonl')
            for (const line of (await readFile(path, 'utf8')).trim().split('\n')) {
              const event = JSON.parse(line);
              if (['tool_executing', 'tool_completed'].includes(event.type)) tools.push(event);
            }
        }
      }
      await collect(join(home, 'sessions')); await collect(join(home, 'residents'));
      report.starts = starts; report.finishes = finishes; report.toolEvents = tools;
      assert.equal(starts.length, 2);
      assert.equal(new Set(starts.map(start => start.sessionId)).size, 2);
      assert.ok(finishes.every(finish => finish.cleanup === 'confirmed' && finish.stopReason === 'end_turn'));
      const liveTools = tools.filter(event => event.runId !== report.seed.start.runId);
      const calls = liveTools.filter(event => event.type === 'tool_executing').map(event => event.toolName);
      report.observed.tools = calls;
      assert.ok(calls.includes('search_resident_tools'));
      assert.ok(calls.includes('read_resident_tool'));
      assert.ok(calls.every(name => ['search_resident_tools', 'read_resident_tool', 'search_resident_history', 'read_resident_history'].includes(name)));
      assert.ok(liveTools.filter(event => event.type === 'tool_completed').every(event => !event.isError));
      assert.equal(tools.filter(event => event.type === 'tool_executing' && event.toolName === 'read').length, 1);
      assert.match(await readFile(join(cwd, 'manifest.txt'), 'utf8'), /^Manually replaced/);
      const idle = await command(['run', '--trust', '--max-steps', '1']);
      assert.equal(idle.agenda.pursuits[0].state.stepsAdmitted, 2);
      report.observed.terminalReopenAdmittedNoStep = true;
    }
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  } finally {
    report.fingerprints = {};
    for (const path of ['packages/sdk/src/store/evidence/disk.ts', 'packages/sdk/src/store/evidence/index-page.ts', 'packages/sdk/src/store/evidence/format.ts', 'packages/sdk/src/manager/resident/tool-evidence.ts', 'packages/sdk/src/runtime/query/index.ts', 'packages/cli/src/integrations/resident/tool-evidence.ts', 'packages/cli/src/integrations/resident/session-step.ts', 'research/resident/tool-evidence-cli.mjs'])
      report.fingerprints[path] = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex');
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ root, live, profile, passed: report.passed, observed: report.observed, error: report.error }));
  }
}
