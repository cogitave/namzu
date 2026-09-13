// Controlled multi-pursuit lifecycle through actual managed CLI worker processes.
// Scripted models isolate host state transitions; this is not a live-model soak.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'namzu-claim-continuity-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
await mkdir(home)
await mkdir(cwd)
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const sdk = new URL('../../packages/sdk/dist/index.js', import.meta.url).href
const preload = join(root, 'provider.mjs')
const requestsPath = join(root, 'requests.jsonl')
const controlPath = join(root, 'control.json')
const files = [
	'sdk/dist/run/json-claim-verifier.js',
	'sdk/dist/manager/resident/host.js',
	'cli/dist/integrations/resident/session-step.js',
	'cli/dist/integrations/resident/verification.js',
	'cli/dist/integrations/resident/runner-worker.js',
	'cli/dist/integrations/resident/runner-launch.js',
]
const hashes = async () =>
	Object.fromEntries(
		await Promise.all(
			files.map(async (path) => [
				path,
				createHash('sha256')
					.update(await readFile(new URL(`../../packages/${path}`, import.meta.url)))
					.digest('hex'),
			]),
		),
	)
const report = {
	root,
	scripted: true,
	startedAt: Date.now(),
	buildBefore: await hashes(),
	commands: [],
	snapshots: [],
	finishes: [],
	runs: [],
}
const persist = () => writeFile(join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
const control = { action: 'wait', epoch: 0 }
await writeFile(
	join(home, 'preferences.json'),
	JSON.stringify({
		version: 3,
		providers: [{ id: 'codex', model: 'gpt-5.6-luna' }],
		subagents: { active: [] },
	}),
)
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
await writeFile(join(cwd, 'package.json'), '{"version":"0"}\n')
await writeFile(controlPath, JSON.stringify(control))
await writeFile(
	join(cwd, 'checks.json'),
	JSON.stringify({
		version: 1,
		claims: [{ id: 'version', source: 'package.json', pointer: '/version' }],
	}),
)
await writeFile(
	preload,
	`
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(sdk)};
ProviderRegistry.create = () => {
 const provider = new MockLLMProvider();
 provider.chatStream = async function* (params) {
  const control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
  const strings = v => typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):v&&typeof v==='object'?Object.entries(v).filter(([k])=>!['metadata','providerMetadata','reasoning'].includes(k)).flatMap(([,x])=>strings(x)):[];
  const text = strings(params.messages);
  appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({at:Date.now(),pid:process.pid,control,acceptedInputs:text.filter(t=>t.includes('wave-')),objectives:text.filter(t=>t.startsWith('Continue this authorized pursuit:'))})+'\\n');
  if (control.action==='complete') await sleep(500, undefined, {signal:params.signal});
  if (control.action==='hang') await sleep(60_000, undefined, {signal:params.signal});
  const answer = control.action==='complete' ? {kind:'complete',summary:'Current version observed: '+control.epoch,claims:{version:String(control.epoch)}} : {kind:'wait',summary:'Retained epoch '+control.epoch+'; waiting for new authorized input.',wakeAfterMs:null};
  yield* new MockLLMProvider({turns:[{text:JSON.stringify(answer)}]}).chatStream(params);
 };
 return {provider};
};
`,
)
const env = { ...process.env, NAMZU_HOME: home, NODE_OPTIONS: `--import ${preload}` }
const command = async (args, required = true) => {
	try {
		const result = await exec(
			process.execPath,
			[cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd],
			{ cwd, env, timeout: 25_000, maxBuffer: 2_000_000 },
		)
		const parsed = JSON.parse(result.stdout)
		report.commands.push({ at: Date.now(), args, exit: 0, result: parsed })
		return parsed
	} catch (error) {
		report.commands.push({
			at: Date.now(),
			args,
			exit: error.code ?? null,
			stdout: error.stdout ?? '',
			stderr: error.stderr ?? '',
			error: error.message,
		})
		if (required) throw error
		return null
	} finally {
		await persist()
	}
}
const until = async (label, predicate) => {
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		const status = await command(['status'])
		if (predicate(status)) {
			report.snapshots.push({ label, at: Date.now(), status })
			await persist()
			return status
		}
		await sleep(300)
	}
	throw new Error(`Timed out observing ${label}; not restarting the worker.`)
}
const start = () =>
	command([
		'start',
		'--trust',
		'--max-steps',
		'30',
		'--max-idle-ms',
		'120000',
		'--provider',
		'codex',
		'--model',
		'gpt-5.6-luna',
		'--effort',
		'low',
		'--max-iterations',
		'5',
		'--token-budget',
		'12000',
		'--verify',
		'checks.json',
	])
const setControl = async (action, epoch) => {
	control.action = action
	control.epoch = epoch
	await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: String(epoch) }))
	await writeFile(controlPath, JSON.stringify(control))
}
console.log(JSON.stringify({ root }))
try {
	await command([
		'add',
		'--trust',
		'Alpha: track the package version. Only read. Retain new inputs and wait until completion is explicitly requested.',
	])
	await command([
		'add',
		'--trust',
		'Beta: independently track the package version. Only read. Retain new inputs and wait until completion is explicitly requested.',
	])
	let state = await command(['status'])
	const ids = state.agenda.pursuits.map((p) => p.id)
	await start()
	state = await until('initial waits', (s) =>
		s.agenda.pursuits.every((p) => p.state.phase === 'waiting' && p.state.stepsAdmitted === 1),
	)
	await writeFile(join(cwd, 'checks.json'), '{"version":999}')
	for (let wave = 1; wave <= 6; wave++) {
		// Remain genuinely idle between accepted inputs; never let a wake mint a new invocation budget.
		await sleep(12_000)
		await setControl('wait', wave)
		const previous = state.agenda.pursuits.map((p) => p.state.stepsAdmitted)
		for (const id of ids)
			await command(['wake', id, `wave-${wave}: accepted observation epoch ${wave}; keep waiting.`])
		state = await until(`wave-${wave} settled`, (s) =>
			s.agenda.pursuits.every(
				(p, i) => p.state.phase === 'waiting' && p.state.stepsAdmitted > previous[i],
			),
		)
		assert.ok(state.agenda.pursuits.every((p) => !p.state.wakeEvidence?.length))
		if (wave === 3) {
			await command(['stop'])
			await until('first process drained', (s) => s.runner.owner.phase === 'stopped')
			await command(['resume'])
			await writeFile(
				join(cwd, 'checks.json'),
				JSON.stringify({
					version: 1,
					claims: [{ id: 'version', source: 'package.json', pointer: '/version' }],
				}),
			)
			await start()
		}
		console.log(
			JSON.stringify({ wave, admissions: state.agenda.pursuits.map((p) => p.state.stepsAdmitted) }),
		)
	}
	await setControl('hang', 7)
	await command(['wake', ids[1], 'wave-cancel: inspect epoch 7.'])
	state = await until(
		'admitted before cancellation',
		(s) => s.agenda.pursuits[1].state.phase === 'running',
	)
	// Wait for the fixture provider to actually enter its cancellable call.
	const deadline = Date.now() + 10_000
	while (!(await readFile(requestsPath, 'utf8')).includes('"action":"hang"')) {
		assert.ok(Date.now() < deadline)
		await sleep(100)
	}
	await command(['stop'])
	state = await until('cancelled process drained', (s) => s.runner.owner.phase === 'stopped')
	const interrupted = state.agenda.pursuits[1].state
	assert.equal(interrupted.phase, 'running')
	assert.ok(interrupted.claimId)
	// Inspect the exact retained claim's finish record before recovery. No action is replayed.
	const collect = async (dir, name) => {
		const values = []
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) values.push(...(await collect(path, name)))
			else if (entry.name === name) values.push(JSON.parse(await readFile(path, 'utf8')))
		}
		return values
	}
	const finishes = await collect(join(home, 'residents'), 'finish.json')
	const cancelled = finishes.find((f) => f.claimId === interrupted.claimId)
	assert.equal(cancelled?.cleanup, 'confirmed')
	assert.equal(cancelled?.decision, null)
	assert.ok(cancelled?.error)
	await command([
		'reconcile',
		ids[1],
		'Inspected cancelled scripted read-only request and its finish receipt. No file mutations; retain pending input and wait.',
		'--claim',
		interrupted.claimId,
		'--revision',
		String(interrupted.revision),
		'--outcome',
		'wait',
		'--executor-stopped',
	])
	await setControl('complete', 8)
	await command(['resume'])
	for (const id of ids)
		await command([
			'wake',
			id,
			'wave-final: current version is ready; complete the authorized review.',
		])
	await start()
	await writeFile(join(cwd, 'checks.json'), '{"version":999}')
	state = await until('both verified completions after restart', (s) =>
		s.agenda.pursuits.every((p) => p.state.phase === 'complete'),
	)
	await command(['stop'])
	await until('final process drained', (s) => s.runner.owner.phase === 'stopped')
	report.finishes = await collect(join(home, 'residents'), 'finish.json')
	report.runs = (await collect(join(home, 'sessions'), 'run.json')).map((r) => ({
		id: r.id,
		status: r.status,
		tokenUsage: r.tokenUsage,
		cost: r.cost,
	}))
	report.requests = (await readFile(requestsPath, 'utf8')).trim().split('\n').map(JSON.parse)
	report.workerPids = [...new Set(report.requests.map((request) => request.pid))]
	assert.equal(report.workerPids.length, 3)
	assert.equal(report.finishes.length, 17)
	assert.equal(new Set(report.finishes.map((f) => f.claimId)).size, 17)
	const completions = report.finishes.filter((f) => f.decision?.kind === 'complete')
	assert.equal(completions.length, 2)
	assert.ok(
		completions.every(
			(f) => f.verification.receipt.claims.version === '8' && f.verificationPolicy.version === 1,
		),
	)
	assert.equal(JSON.parse(await readFile(join(cwd, 'checks.json'), 'utf8')).version, 999)
	report.policySnapshotVerified = true
	for (let wave = 1; wave <= 6; wave++)
		assert.ok(
			report.requests
				.filter((r) => r.control.epoch === wave)
				.every((r) => r.acceptedInputs.some((input) => input.includes(`wave-${wave}`))),
		)
	report.providerTokens = report.runs.reduce(
		(sum, run) => sum + (run.tokenUsage?.totalTokens ?? 0),
		0,
	)
	assert.equal(report.providerTokens, 0)
	report.passed = true
} catch (error) {
	report.failure = error.stack
	process.exitCode = 1
} finally {
	await command(['stop'], false)
	report.endedAt = Date.now()
	report.buildAfter = await hashes()
	report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter)
	await persist()
	console.log(
		JSON.stringify({
			root,
			passed: report.passed ?? false,
			elapsedMs: report.endedAt - report.startedAt,
			failure: report.failure ?? null,
		}),
	)
}
