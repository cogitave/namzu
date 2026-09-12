import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The first two settled steps are explicitly scripted host fixtures. They
// establish evidence missing from the latest summary; they are not model runs.
// Every control/seed/run operation below opens state in a separate process.
if (process.argv[2] === '--seed') {
  const { lookupResident } = await import('../../packages/cli/dist/integrations/resident/storage.js');
  const resident = await lookupResident(process.argv[3], 'default');
  assert.ok(resident);
  const { agenda } = resident;
  const id = (await agenda.read()).pursuits[0].id;
  const current = async () => (await agenda.read()).pursuits.find(p => p.id === id).state;
  const tracking = `TRACK-${randomUUID()}`;
  const destination = `DEPOT-${randomUUID()}`;
  const priorNotes = Array.from({ length: 18 }, (_, i) => `Manifest check ${i + 1}: packaging intact; no destination update.`).join('\n');
  async function step(reason, summary) {
    await agenda.wake(id, await current(), reason, Date.now());
    const execution = agenda.execution(id);
    const claim = await execution.claim(await current(), Date.now());
    await execution.settle(claim, { kind: 'wait', summary, wakeAt: null }, Date.now());
    return (await agenda.read()).revision;
  }
  const original = await step(`DELTA original delivery input.\n${priorNotes}\nTracking code: ${tracking}. Destination: OLD-DEPOT.`, 'Initial manifest review finished; await recipient confirmation.');
  const corrected = await step(`DELTA corrected delivery input.\n${priorNotes}\nReplace OLD-DEPOT with ${destination}. The tracking code is unchanged.`, 'Correction recorded; await recipient confirmation.');
  const source = agenda.history(await current(), corrected);
  const page = await source.search({ query: 'DELTA' });
  assert.deepEqual(page.matches.map(m => m.revision), [corrected, original]);
  assert.ok(!JSON.stringify(page).includes(tracking));
  assert.ok(!JSON.stringify(page).includes(destination));
  assert.ok((await source.read({ revision: original, part: 1 })).entry.text.includes(tracking));
  assert.ok((await source.read({ revision: corrected, part: 1 })).entry.text.includes(destination));
  assert.equal((await current()).wakeEvidence, undefined);
  console.log(JSON.stringify({ tracking, destination, original, corrected, latestSummary: (await current()).summary }));
} else {
  const live = process.argv.includes('--live');
  const profile = process.argv.includes('--interactive') ? 'interactive' : 'resident';
  const provider = process.argv.includes('--codex') ? 'codex' : 'zen';
  const model = provider === 'codex' ? 'gpt-5.6-luna' : 'muse-spark-1.3-contributor-free';
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'namzu-history-recall-cli-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({
    version: 3,
    providers: [{ id: provider, model }],
    subagents: { active: [] },
  }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n');
  const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
  const env = { ...process.env, NAMZU_HOME: home };
  const commands = [];
  async function command(args) {
    const { stdout } = await exec(process.execPath, [cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd], {
      cwd, env, timeout: 180_000, maxBuffer: 2_000_000,
    });
    const result = JSON.parse(stdout);
    commands.push({ args, result });
    return result;
  }
  const report = { root, live, profile, provider, model, commands, observed: {} };
  try {
    const added = await command(['add', '--trust', 'Resolve the DELTA delivery once the recipient confirms. Recover the exact tracking code and current destination from recorded inputs, applying any later correction. Read the original and correction in full before reporting. Complete with a concise summary naming the tracking code and the corrected destination. Do not ship anything, send a message, read workspace files or run commands.']);
    const id = added.agenda.pursuits[0].id;
    const { stdout } = await exec(process.execPath, [fileURLToPath(import.meta.url), '--seed', cwd], { cwd, env, timeout: 30_000 });
    report.seed = JSON.parse(stdout);
    const status = await command(['status']);
    const state = status.agenda.pursuits[0].state;
    assert.equal(state.summary, report.seed.latestSummary);
    assert.ok(!JSON.stringify(state).includes(report.seed.tracking));
    assert.ok(!JSON.stringify(state).includes(report.seed.destination));
    await command(['wake', id, 'The recipient confirms DELTA. Recover the prior delivery details and report the corrected result now.']);
    report.observed.exactEvidenceAbsentFromLatestState = true;
    if (live) {
      const finished = await command(['run', '--trust', '--max-steps', '1', '--provider', provider, '--model', model, '--effort', 'low', '--context-profile', profile, '--tool-loading', 'deferred', '--max-iterations', '6', '--token-budget', '40000']);
      const result = finished.agenda.pursuits[0].state;
      report.observed.phase = result.phase;
      report.observed.summary = result.summary;
      assert.equal(result.phase, 'complete');
      assert.ok(result.summary.includes(report.seed.tracking));
      assert.ok(result.summary.includes(report.seed.destination));
      const receipts = [];
      const starts = [];
      const toolEvents = [];
      async function collect(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collect(path);
          else if (entry.name === 'finish.json') receipts.push(JSON.parse(await readFile(path, 'utf8')));
          else if (entry.name === 'start.json') starts.push(JSON.parse(await readFile(path, 'utf8')));
          else if (entry.name === 'transcript.jsonl') {
            for (const line of (await readFile(path, 'utf8')).split('\n').filter(Boolean)) {
              const event = JSON.parse(line);
              if (event.type === 'tool_executing' || event.type === 'tool_completed') toolEvents.push(event);
            }
          }
        }
      }
      await collect(join(home, 'residents'));
      await collect(join(home, 'sessions'));
      report.receipts = receipts;
      report.starts = starts;
      report.toolEvents = toolEvents;
      assert.equal(receipts.length, 1);
      assert.equal(starts.length, 1);
      assert.equal(receipts[0].cleanup, 'confirmed');
      assert.equal(receipts[0].stopReason, 'end_turn');
      assert.equal(starts[0].model, model);
      const calls = toolEvents.filter(e => e.type === 'tool_executing').map(e => e.toolName);
      const completed = toolEvents.filter(e => e.type === 'tool_completed');
      report.observed.tools = calls;
      assert.ok(calls.includes('search_resident_history'));
      assert.ok(calls.includes('read_resident_history'));
      assert.ok(calls.every(name => ['search_resident_history', 'read_resident_history'].includes(name)));
      assert.ok(completed.every(e => !e.isError));
      const idle = await command(['run', '--trust', '--max-steps', '1']);
      assert.equal(idle.agenda.pursuits[0].state.stepsAdmitted, 3);
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
      'packages/sdk/src/manager/resident/history.ts',
      'packages/sdk/src/manager/resident/history-disk.ts',
      'packages/sdk/dist/manager/resident/history.js',
      'packages/cli/src/integrations/resident/session-step.ts',
      'packages/cli/dist/integrations/resident/session-step.js',
      'research/resident/history-recall-cli.mjs',
    ]) report.fingerprints[path] = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex');
    await writeFile(join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ root, live, profile, provider, model, passed: report.passed, ...report.observed, error: report.error }, null, 2));
  }
}
