// Fault-inject copies of the short controlled lifecycle's records, then use the real CLI reader.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { digestProbeState, inspectionBuild, readProbeFile } from './lifetime-audit.mjs'

const exec = promisify(execFile)
const source = process.argv[2]
assert.ok(source?.startsWith('/tmp/namzu-lifetime-soak-'))
const sourceBytes = await readProbeFile(join(source, 'result.json'), 8 * 1024 * 1024)
const original = JSON.parse(sourceBytes)
assert.equal(original.root, source)
assert.equal(original.passed, true)
assert.ok(original.endedAt)
const root = await mkdtemp(join(tmpdir(), 'namzu-inspect-cli-'))
console.log(JSON.stringify({ root }))
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const guard = join(root, 'no-network.mjs')
const networkLog = join(root, 'network-attempts.jsonl')
await writeFile(
	guard,
	`import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
import {appendFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const blocked = () => {appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({at:Date.now()})+'\\n'); throw new Error('Inspection attempted network I/O.');};
globalThis.fetch=blocked; net.connect=blocked; net.createConnection=blocked;
http.get=blocked; http.request=blocked; https.get=blocked; https.request=blocked; syncBuiltinESMExports();
`,
)
const beforeBuild = await inspectionBuild()
const report = {
	root,
	source,
	sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
	startedAt: Date.now(),
	buildBefore: beforeBuild,
	cases: [],
}
const persist = () => writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
let baseline
try {
	for (const fault of [
		'baseline',
		'missing-start',
		'missing-finish',
		'foreign-finish',
		'oversize-finish',
		'missing-history',
		'partial-boundary',
	]) {
		const home = join(root, fault, 'home')
		await mkdir(join(root, fault), { recursive: true, mode: 0o700 })
		await cp(join(source, 'home'), home, { recursive: true })
		const [project] = await readdir(join(home, 'residents'))
		const resident = join(home, 'residents', project, 'default')
		const binding = JSON.parse(await readProbeFile(join(resident, 'binding.json'), 4096))
		const terminal = original.finishes.find((f) => f.decision?.kind === 'complete')
		const attempt = join(resident, 'attempts', terminal.claimId)
		const outside = join(root, fault, 'withheld.json')
		const args = []
		if (fault === 'missing-start') await rename(join(attempt, 'start.json'), outside)
		if (fault === 'missing-finish') await rename(join(attempt, 'finish.json'), outside)
		if (fault === 'foreign-finish') {
			const other = original.finishes.find(
				(f) => f.decision?.kind === 'complete' && f.claimId !== terminal.claimId,
			)
			await writeFile(join(attempt, 'finish.json'), JSON.stringify(other))
		}
		if (fault === 'oversize-finish')
			await writeFile(join(attempt, 'finish.json'), Buffer.alloc(65_537, 32))
		if (fault === 'missing-history') {
			const path = join(
				home,
				'residents',
				project,
				binding.tenantId,
				binding.agentKey,
				'agenda',
				'revisions',
				'3.json',
			)
			await rename(path, outside)
		}
		if (fault === 'partial-boundary')
			args.push('--cursor', '3', '--through-revision', '6', '--max-revisions', '2')
		const before = await digestProbeState(home)
		const { stdout } = await exec(
			process.execPath,
			[
				'--import',
				guard,
				cli,
				'--quiet',
				'--format',
				'json',
				'resident',
				'inspect',
				'--cwd',
				join(source, 'workspace'),
				...args,
			],
			{ env: { ...process.env, NAMZU_HOME: home }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
		)
		const { inspection } = JSON.parse(stdout)
		assert.deepEqual(
			await digestProbeState(home),
			before,
			'Inspection modified the copied records.',
		)
		if (fault === 'baseline') {
			baseline = inspection
			assert.equal(inspection.recorded.ownTokens, 3360)
			assert.equal(inspection.unknown.ownUsageAttempts, 2)
		} else if (fault === 'partial-boundary') {
			assert.equal(inspection.historyComplete, false)
			assert.equal(inspection.usageComplete, false)
			assert.equal(inspection.scope.throughRevision, 6)
			assert.equal(inspection.fromRevision, 3)
			assert.equal(inspection.throughRevision, 4)
			assert.equal(inspection.nextCursor, 5)
		} else if (fault === 'missing-history') {
			assert.equal(inspection.historyComplete, false)
			assert.equal(inspection.usageComplete, false)
			assert.ok(inspection.unavailableRevisions.includes(3))
		} else {
			const changed = inspection.attempts.find((a) => a.claimId === terminal.claimId)
			assert.ok(changed)
			assert.equal(inspection.unknown.ownUsageAttempts, baseline.unknown.ownUsageAttempts + 1)
			assert.equal(inspection.usageComplete, false)
			if (fault === 'missing-finish') {
				assert.equal(changed.receipt.usageFinal, false)
				assert.equal(changed.receipt.ownTokens, 120)
				assert.equal(changed.receipt.ownCostUsd, null)
				assert.equal(inspection.recorded.ownTokens, baseline.recorded.ownTokens)
			} else {
				assert.equal(changed.receipt, null)
				assert.equal(changed.receiptStatus, fault === 'missing-start' ? 'missing' : 'invalid')
				assert.equal(inspection.recorded.ownTokens, baseline.recorded.ownTokens - 120)
			}
		}
		report.cases.push({
			fault,
			inspection,
			unchangedStateFiles: Object.keys(before).length,
			passed: true,
		})
		await persist()
		console.log(JSON.stringify({ fault, passed: true }))
	}
	let networkAttempts = ''
	try {
		networkAttempts = await readFile(networkLog, 'utf8')
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
	assert.equal(networkAttempts, '')
	report.networkApiAttempts = 0
	report.passed = true
} catch (error) {
	report.failure = error.stack
	process.exitCode = 1
} finally {
	report.buildAfter = await inspectionBuild()
	report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter)
	if (!report.buildStable) {
		report.passed = false
		process.exitCode = 1
	}
	report.endedAt = Date.now()
	await persist()
	console.log(
		JSON.stringify({ root, passed: report.passed ?? false, failure: report.failure ?? null }),
	)
}
