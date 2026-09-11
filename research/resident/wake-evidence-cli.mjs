import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Each CLI command is a new process. Default mode validates durable control
// operations only; --live explicitly enables one bounded, low-effort model step.
const live = process.argv.includes('--live');
const profile = process.argv.includes('--interactive') ? 'interactive' : 'resident';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'namzu-wake-evidence-cli-'));
const home = join(root, 'home');
const cwd = join(root, 'workspace');
await mkdir(home);
await mkdir(cwd);
await writeFile(join(home, 'preferences.json'), JSON.stringify({
  version: 3,
  providers: [{ id: 'zen', model: 'muse-spark-1.3-contributor-free' }],
  subagents: { active: [] },
}));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n');
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
const commands = [];
async function command(args) {
  const { stdout } = await exec(process.execPath, [cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd], {
    cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 120_000, maxBuffer: 2_000_000,
  });
  const result = JSON.parse(stdout);
  commands.push({ args, result });
  return result;
}
const report = { root, live, profile, commands, observed: {} };
try {
  const added = await command(['add', '--trust', 'Assess release readiness from the supplied wake evidence. The release requires both a passing build and a passing security review. If either failed, report blocked; otherwise complete. Your summary must name both exact receipts and both outcomes. Do not use tools or change files.']);
  const pursuit = added.agenda.pursuits[0];
  await command(['wake', pursuit.id, 'Build review failed; receipt BUILD-ALPHA. The release must not proceed until the build is repaired.']);
  await command(['wake', pursuit.id, 'Security review passed; receipt SECURITY-BETA. This review says nothing about the build.']);
  const status = await command(['status']);
  const pending = status.agenda.pursuits[0].state;
  assert.match(status.text, /Pending evidence: 2 input\(s\)/);
  assert.equal(pending.wakeEvidence.length, 2);
  assert.match(pending.wakeEvidence[0].reason, /BUILD-ALPHA/);
  assert.match(pending.wakeEvidence[1].reason, /SECURITY-BETA/);
  report.observed.pendingAfterSeparateProcesses = pending.wakeEvidence.length;
  if (live) {
    const finished = await command(['run', '--trust', '--max-steps', '1', '--provider', 'zen', '--model', 'muse-spark-1.3-contributor-free', '--effort', 'low', '--context-profile', profile, '--tool-loading', 'deferred', '--max-iterations', '3', '--token-budget', '30000']);
    const state = finished.agenda.pursuits[0].state;
    report.observed.phase = state.phase;
    report.observed.summary = state.summary;
    assert.equal(state.phase, 'blocked');
    assert.match(state.summary, /BUILD-ALPHA/);
    assert.match(state.summary, /SECURITY-BETA/);
    assert.equal(state.wakeEvidence, undefined);
    // Locate synthetic receipts only in this new, isolated home.
    const receipts = [];
    const starts = [];
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (entry.name === 'finish.json') receipts.push(JSON.parse(await readFile(path, 'utf8')));
        else if (entry.name === 'start.json') starts.push(JSON.parse(await readFile(path, 'utf8')));
      }
    }
    await collect(join(home, 'residents'));
    report.receipts = receipts;
    report.starts = starts;
    assert.equal(receipts.length, 1);
    assert.equal(starts.length, 1);
    assert.match(starts[0].model, /muse-spark-1.3-contributor-free/);
    assert.equal(receipts[0].cleanup, 'confirmed');
    assert.equal(receipts[0].stopReason, 'end_turn');
    const idle = await command(['run', '--trust', '--max-steps', '1']);
    assert.equal(idle.agenda.pursuits[0].state.stepsAdmitted, 1);
    report.observed.terminalReopenAdmittedNoStep = true;
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.fingerprints = {};
  for (const path of [
    'packages/sdk/src/manager/resident/store.ts',
    'packages/sdk/dist/manager/resident/store.js',
    'packages/sdk/src/prompt/resident-step.ts',
    'packages/cli/src/integrations/resident/session-step.ts',
    'packages/cli/dist/integrations/resident/session-step.js',
    'research/resident/wake-evidence-cli.mjs',
  ]) report.fingerprints[path] = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex');
  await writeFile(join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ root, profile, passed: report.passed, ...report.observed, error: report.error }, null, 2));
}
