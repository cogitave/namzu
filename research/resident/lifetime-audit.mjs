import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export function projectLifecycle(raw, inspection) {
	return {
		version: 1,
		root: raw.root,
		producerCheckout: raw.checkout,
		startedAt: raw.startedAt,
		endedAt: raw.endedAt,
		intervalMs: raw.intervalMs,
		passed: raw.passed ?? false,
		failure: raw.failure ?? null,
		buildBefore: raw.buildBefore,
		buildAfter: raw.buildAfter,
		idle: raw.idleObservations,
		workers: raw.workerPids,
		abruptExit: raw.abruptExit,
		transitions: raw.commands
			.filter((c) => ['start', 'stop', 'release', 'reconcile', 'archive'].includes(c.args[0]))
			.map((c) => ({
				at: c.at,
				action: c.args[0],
				args: c.args.slice(1),
				exit: c.exit,
				owner: c.result?.runner?.owner
					? {
							pid: c.result.runner.owner.pid,
							instanceId: c.result.runner.owner.instanceId,
							phase: c.result.runner.owner.phase,
						}
					: null,
			})),
		policySnapshotVerified: raw.policySnapshotVerified,
		requests: raw.requests.map((r) => ({
			at: r.at,
			pid: r.pid,
			action: r.control.action,
			epoch: r.control.epoch,
			inputWaves: [
				...new Set(
					r.acceptedInputs.flatMap((t) =>
						[...t.matchAll(/wave-(?:\d+|final|cancel|crash)/g)].map((m) => m[0]),
					),
				),
			],
			objective: r.objectives[0],
		})),
		finishes: raw.finishes.map((f) => ({
			pursuitId: f.pursuitId,
			claimId: f.claimId,
			runId: f.runId,
			outcome: f.decision?.kind ?? null,
			error: !!f.error,
			cleanup: f.cleanup,
			usage: f.usage,
			budget: f.budget ?? null,
			verificationPolicy: f.verificationPolicy ?? null,
			verification: f.verification ?? null,
		})),
		runTokens: raw.runs.map((r) => ({ id: r.id, tokens: r.tokenUsage?.totalTokens ?? null })),
		archivedPursuitsRemaining: raw.archived.agenda.pursuits.length,
		inspection,
	}
}

export function auditLifecycle(data, { minimumElapsedMs = 7_200_000 } = {}) {
	assert.equal(data.version, 1)
	assert.equal(data.passed, true, data.failure ?? 'Producer did not finish.')
	assert.equal(data.failure, null)
	assert.ok(data.endedAt - data.startedAt >= minimumElapsedMs, 'Insufficient real elapsed time.')
	assert.deepEqual(data.buildBefore, data.buildAfter, 'Measured producer build changed.')
	assert.equal(Object.keys(data.buildBefore).length, 6)
	assert.ok(Object.values(data.buildBefore).every((v) => /^[a-f0-9]{64}$/.test(v)))
	assert.equal(data.idle.length, 12)
	assert.ok(
		data.idle.every(
			(s, i) => s.wave === i + 1 && s.before === s.after && s.intervalMs === data.intervalMs,
		),
	)
	assert.ok(data.intervalMs * 12 >= minimumElapsedMs)
	for (let i = 0; i < data.idle.length; i++) {
		const sample = data.idle[i]
		const previous = i ? data.idle[i - 1].at : data.startedAt
		assert.ok(sample.at - previous >= data.intervalMs - 2, 'Idle timing was accelerated.')
		assert.ok(
			!data.requests.some((r) => r.at > sample.at - data.intervalMs && r.at < sample.at),
			'Model request occurred in an idle interval.',
		)
	}
	assert.ok(data.requests.every((r) => r.at >= data.startedAt && r.at <= data.endedAt))
	assert.equal(new Set(data.workers).size, 4)
	assert.ok(data.requests.every((r) => data.workers.includes(r.pid)))
	assert.ok(
		data.transitions.every((t) => t.exit === 0 && t.at >= data.startedAt && t.at <= data.endedAt),
	)
	const starts = data.transitions.filter((t) => t.action === 'start')
	assert.equal(starts.length, 4)
	assert.deepEqual(
		starts.map((t) => t.owner.pid),
		data.workers,
	)
	const releases = data.transitions.filter((t) => t.action === 'release')
	assert.equal(releases.length, 1)
	assert.equal(releases[0].args[0], starts[1].owner.instanceId)
	assert.ok(releases[0].at > data.abruptExit.at)
	assert.ok(releases[0].args.includes('--executor-stopped'))
	const reconciles = data.transitions.filter((t) => t.action === 'reconcile')
	assert.equal(reconciles.length, 2)
	assert.ok(
		reconciles.every(
			(t) =>
				t.args.includes('--executor-stopped') && t.args[t.args.indexOf('--outcome') + 1] === 'wait',
		),
	)
	assert.equal(
		reconciles[0].args[reconciles[0].args.indexOf('--claim') + 1],
		data.abruptExit.claimId,
	)
	assert.equal(data.transitions.filter((t) => t.action === 'archive').length, 2)
	assert.equal(data.requests.length, 30)
	assert.equal(data.requests.filter((r) => r.action === 'hang').length, 2)
	for (let wave = 1; wave <= 12; wave++) {
		const requests = data.requests.filter((r) => r.action === 'wait' && r.epoch === wave)
		assert.equal(requests.length, 2)
		assert.equal(new Set(requests.map((r) => r.objective)).size, 2)
		assert.ok(requests.every((r) => r.inputWaves.includes(`wave-${wave}`)))
	}
	assert.equal(data.finishes.length, 29)
	assert.equal(new Set(data.finishes.map((f) => f.claimId)).size, 29)
	assert.equal(new Set(data.finishes.map((f) => f.runId)).size, 29)
	assert.ok(
		!data.finishes.some((f) => f.claimId === data.abruptExit.claimId),
		'Abrupt death invented a finish receipt.',
	)
	const cancelled = data.finishes.filter((f) => f.error)
	assert.equal(cancelled.length, 1)
	assert.equal(cancelled[0].outcome, null)
	assert.equal(cancelled[0].usage, null)
	assert.equal(cancelled[0].cleanup, 'confirmed')
	const completed = data.finishes.filter((f) => f.outcome === 'complete')
	assert.equal(completed.length, 2)
	assert.equal(data.policySnapshotVerified, true)
	for (const finish of completed) {
		assert.equal(finish.verificationPolicy.version, 1)
		assert.deepEqual(finish.verification.receipt.claims, { version: '8' })
		assert.equal(finish.verification.receipt.runId, finish.runId)
		assert.equal(JSON.parse(finish.verification.receipt.scope).claimId, finish.claimId)
		assert.ok(
			finish.verification.receipt.observations.every((o) => /^[a-f0-9]{64}$/.test(o.sha256)),
		)
	}
	const successful = data.finishes.filter((f) => !f.error)
	assert.equal(successful.length, 28)
	assert.ok(
		successful.every(
			(f) =>
				f.usage.totalTokens === 120 && f.budget.ownTokens === 120 && f.budget.treeTokens === 120,
		),
	)
	assert.equal(data.runTokens.length, 30)
	assert.equal(
		data.runTokens.reduce((n, r) => n + (r.tokens ?? 0), 0),
		3360,
	)
	assert.equal(data.archivedPursuitsRemaining, 0)
	const { inspection } = data
	assert.equal(inspection.historyComplete, true)
	assert.equal(inspection.attempts.length, 30)
	assert.equal(new Set(inspection.attempts.map((a) => a.claimId)).size, 30)
	assert.equal(inspection.archivedPursuits.length, 2)
	assert.equal(inspection.recorded.ownTokens, 3360)
	assert.equal(inspection.recorded.treeTokens, 3360)
	assert.equal(inspection.recorded.ownCostUsd, 0)
	assert.equal(inspection.recorded.unpricedOwnTokens, 3360)
	assert.deepEqual(inspection.unknown, {
		ownUsageAttempts: 2,
		treeUsageAttempts: 2,
		ownPriceAttempts: 30,
	})
	assert.equal(inspection.usageComplete, false)
	assert.equal(inspection.attempts.filter((a) => a.receipt?.verification === 'recorded').length, 2)
	const crash = inspection.attempts.find((a) => a.claimId === data.abruptExit.claimId)
	assert.ok(crash)
	assert.equal(crash.receipt?.usageFinal, false)
	assert.equal(crash.settlement.outcome, 'wait')
	for (const finish of data.finishes)
		assert.ok(
			inspection.attempts.some(
				(a) => a.claimId === finish.claimId && a.receipt?.runId === finish.runId,
			),
		)
	return {
		elapsedMs: data.endedAt - data.startedAt,
		admissions: 30,
		verifiedCompletions: 2,
		knownTokens: 3360,
		incompleteUsage: 2,
		idleModelRequests: 0,
	}
}

export async function readProbeFile(path, maximumBytes) {
	assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes >= 0)
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const before = await file.stat()
		assert.ok(before.isFile() && before.size <= maximumBytes, 'Probe file exceeds audit bounds.')
		const data = Buffer.alloc(before.size)
		let offset = 0
		while (offset < data.length) {
			const read = await file.read(data, offset, data.length - offset, offset)
			assert.ok(read.bytesRead, 'Probe file shortened during audit.')
			offset += read.bytesRead
		}
		const after = await file.stat()
		assert.ok(
			before.size === after.size &&
				before.mtimeMs === after.mtimeMs &&
				before.ctimeMs === after.ctimeMs,
			'Probe file changed during audit.',
		)
		return data
	} finally {
		await file.close()
	}
}

export async function digestProbeState(root) {
	const result = {}
	let bytes = 0
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new Error('Unexpected probe state symlink.')
			const path = join(dir, entry.name)
			if (entry.isDirectory()) await walk(path)
			else {
				assert.ok(
					entry.isFile() && Object.keys(result).length < 10_000,
					'Unexpected probe file or excessive count.',
				)
				const data = await readProbeFile(path, 128 * 1024 * 1024 - bytes)
				bytes += data.length
				result[path.slice(root.length + 1)] = createHash('sha256').update(data).digest('hex')
			}
		}
	}
	await walk(join(root, 'residents'))
	await walk(join(root, 'sessions'))
	return result
}

export async function inspectionBuild() {
	const result = {}
	for (const path of [
		'sdk/dist/manager/resident/activity.js',
		'sdk/dist/manager/resident/consumption.js',
		'cli/dist/integrations/resident/inspection.js',
		'cli/dist/commands/resident.js',
	]) {
		const data = await readProbeFile(
			fileURLToPath(new URL(`../../packages/${path}`, import.meta.url)),
			1024 * 1024,
		)
		result[path] = createHash('sha256').update(data).digest('hex')
	}
	return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [root, output] = process.argv.slice(2)
	assert.ok(root?.startsWith('/tmp/namzu-lifetime-soak-') && output)
	const rawBytes = await readProbeFile(join(root, 'result.json'), 8 * 1024 * 1024)
	const raw = JSON.parse(rawBytes)
	assert.equal(raw.root, root)
	assert.ok(raw.endedAt, 'Producer is still running; audit is not final.')
	const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
	const buildBefore = await inspectionBuild()
	const before = await digestProbeState(join(root, 'home'))
	const { stdout } = await exec(
		process.execPath,
		[cli, '--quiet', '--format', 'json', 'resident', 'inspect', '--cwd', join(root, 'workspace')],
		{
			env: { ...process.env, NAMZU_HOME: join(root, 'home') },
			timeout: 30_000,
			maxBuffer: 2 * 1024 * 1024,
		},
	)
	const after = await digestProbeState(join(root, 'home'))
	assert.deepEqual(after, before, 'Inspection changed authoritative state.')
	assert.deepEqual(await inspectionBuild(), buildBefore, 'Inspector changed during audit.')
	const data = projectLifecycle(raw, JSON.parse(stdout).inspection)
	data.sourceSha256 = createHash('sha256').update(rawBytes).digest('hex')
	data.inspectionBuild = buildBefore
	data.inspectedStateFiles = Object.keys(before).length
	data.inspectionReadOnly = true
	data.audit = auditLifecycle(data, {
		minimumElapsedMs: process.argv.includes('--control') ? 0 : 7_200_000,
	})
	await writeFile(output, JSON.stringify(data, null, 2) + '\n')
	console.log(JSON.stringify(data.audit))
}
