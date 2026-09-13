// One explicitly enabled Luna/low managed worker. No scripted replies or automatic retries.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { digestProbeState, readProbeFile } from './lifetime-audit.mjs'

assert.ok(process.argv.includes('--live'), 'Requires --live: this makes real model requests.')
const checkout = process.argv[2]
assert.ok(checkout?.startsWith('/'), 'Pass a fixed built checkout.')
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'namzu-resident-managed-live-'))
const home = join(root, 'home'),
	cwd = join(root, 'workspace')
await mkdir(home, { mode: 0o700 })
await mkdir(cwd, { mode: 0o700 })
const cli = join(checkout, 'packages/cli/dist/bin.js')
const sdk = pathToFileURL(join(checkout, 'packages/sdk/dist/index.js')).href
const requestsPath = join(root, 'requests.jsonl')
const preload = join(root, 'observe.mjs')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const files = [
	'sdk/dist/manager/resident/host.js',
	'cli/dist/integrations/resident/session-step.js',
	'cli/dist/integrations/resident/runner-worker.js',
	'cli/dist/integrations/resident/runner-launch.js',
	'cli/dist/integrations/resident/verification.js',
	'cli/dist/integrations/resident/inspection.js',
]
const fingerprints = async () =>
	Object.fromEntries(
		await Promise.all(
			files.map(async (path) => [
				path,
				hash(await readProbeFile(join(checkout, 'packages', path), 1024 * 1024)),
			]),
		),
	)
await writeFile(join(cwd, 'package.json'), '{"name":"managed-fixture","version":"7.0.0"}\n')
const sourceHash = hash(await readFile(join(cwd, 'package.json')))
await writeFile(
	join(cwd, 'checks.json'),
	JSON.stringify({
		version: 1,
		claims: [{ id: 'version', source: 'package.json', pointer: '/version', expected: '7.0.0' }],
	}),
)
await writeFile(
	join(home, 'preferences.json'),
	JSON.stringify({
		version: 3,
		providers: [{ id: 'codex', model: 'gpt-5.6-luna' }],
		subagents: { active: [] },
	}),
)
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
await writeFile(
	preload,
	`import {appendFileSync} from 'node:fs';
import {ProviderRegistry} from ${JSON.stringify(sdk)};
const create=ProviderRegistry.create;
ProviderRegistry.create=function(...args){const result=create.apply(this,args); const stream=result.provider.chatStream;
result.provider.chatStream=async function*(params){appendFileSync(${JSON.stringify(requestsPath)},JSON.stringify({at:Date.now(),pid:process.pid})+'\\n');yield* stream.call(this,params)};return result;};
`,
)
const env = { ...process.env, NAMZU_HOME: home, NODE_OPTIONS: `--import ${preload}` }
const report = {
	root,
	checkout,
	startedAt: Date.now(),
	model: 'codex/gpt-5.6-luna',
	effort: 'low',
	limits: { steps: 1, iterations: 8, tokens: 24000, wallMs: 120000 },
	buildBefore: await fingerprints(),
	commands: [],
}
const persist = () => writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ root }))
const command = async (args) => {
	try {
		const { stdout } = await exec(
			process.execPath,
			[cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd],
			{ cwd, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
		)
		const result = JSON.parse(stdout)
		report.commands.push({ at: Date.now(), args, exit: 0, result })
		return result
	} catch (error) {
		report.commands.push({
			at: Date.now(),
			args,
			exit: error.code ?? null,
			stderr: error.stderr ?? '',
			stdout: error.stdout ?? '',
		})
		throw new Error(`Managed CLI command ${args[0]} did not succeed.`)
	} finally {
		await persist()
	}
}
let terminal = false
try {
	await command([
		'add',
		'--trust',
		'Read only package.json and report its version, then complete this review. Do not modify files, run commands or start agents.',
	])
	const start = await command([
		'start',
		'--trust',
		'--max-steps',
		'1',
		'--provider',
		'codex',
		'--model',
		'gpt-5.6-luna',
		'--effort',
		'low',
		'--tool-loading',
		'deferred',
		'--max-iterations',
		'8',
		'--token-budget',
		'24000',
		'--verify',
		'checks.json',
	])
	const owner = start.runner.owner
	assert.equal(owner.mode, 'background')
	report.worker = { pid: owner.pid, instanceId: owner.instanceId }
	const deadline = Date.now() + 120000
	let status
	while (Date.now() < deadline) {
		status = await command(['status'])
		if (status.runner.owner?.phase === 'stopped') {
			terminal = true
			break
		}
		await sleep(1000)
	}
	assert.ok(terminal, 'Managed worker exceeded its real elapsed observation bound.')
	assert.equal(status.agenda.pursuits[0].state.phase, 'complete')
	assert.equal(status.agenda.pursuits[0].state.stepsAdmitted, 1)
	const before = await digestProbeState(home)
	const result = await command(['inspect'])
	assert.deepEqual(await digestProbeState(home), before, 'Inspection changed the worker records.')
	report.inspection = result.inspection
	const attempt = result.inspection.attempts[0]
	assert.equal(result.inspection.attempts.length, 1)
	assert.equal(attempt.receipt.verification, 'recorded')
	assert.equal(attempt.receipt.usageFinal, true)
	assert.equal(attempt.settlement.outcome, 'complete')
	assert.equal(result.inspection.usageComplete, true)
	assert.equal(hash(await readFile(join(cwd, 'package.json'))), sourceHash)
	const [projectId] = await readdir(join(home, 'residents'))
	const startReceipt = JSON.parse(
		await readProbeFile(
			join(home, 'residents', projectId, 'default', 'attempts', attempt.claimId, 'start.json'),
			65536,
		),
	)
	const transcript = (
		await readProbeFile(
			join(
				home,
				'sessions',
				startReceipt.sessionId,
				'runs',
				startReceipt.runId,
				'transcript.jsonl',
			),
			2 * 1024 * 1024,
		)
	)
		.toString('utf8')
		.trim()
		.split('\n')
		.map(JSON.parse)
	report.toolEvents = transcript
		.filter((event) => ['tool_executing', 'tool_completed'].includes(event.type))
		.map((event) => ({
			type: event.type,
			toolName: event.toolName,
			input: event.input,
			isError: event.isError ?? null,
		}))
	assert.ok(
		report.toolEvents.some(
			(event) => event.type === 'tool_completed' && event.toolName === 'read' && !event.isError,
		),
	)
	assert.ok(report.toolEvents.every((event) => event.toolName === 'read'))
	report.requests = (await readProbeFile(requestsPath, 65536))
		.toString('utf8')
		.trim()
		.split('\n')
		.map(JSON.parse)
	assert.ok(report.requests.length > 0 && report.requests.length <= 8)
	assert.ok(report.requests.every((request) => request.pid === owner.pid))
	const idleBefore = report.requests.length
	await sleep(10000)
	const idleAfter = (await readProbeFile(requestsPath, 65536))
		.toString('utf8')
		.trim()
		.split('\n').length
	assert.equal(idleAfter, idleBefore)
	report.afterStopObservationMs = 10000
	report.afterStopRequests = idleAfter - idleBefore
	report.sourceUnchanged = true
	report.passed = true
} catch (error) {
	report.failure = error.stack
	process.exitCode = 1
} finally {
	if (!terminal) {
		try {
			await command(['stop'])
			report.stopRequested = true
		} catch {
			report.stopRequested = false
		}
	}
	report.buildAfter = await fingerprints()
	report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter)
	if (!report.buildStable) {
		report.passed = false
		process.exitCode = 1
	}
	report.endedAt = Date.now()
	await persist()
	console.log(
		JSON.stringify({
			root,
			passed: report.passed ?? false,
			tokens: report.inspection?.recorded.ownTokens ?? null,
			requests: report.requests?.length ?? null,
			failure: report.failure ?? null,
		}),
	)
}
