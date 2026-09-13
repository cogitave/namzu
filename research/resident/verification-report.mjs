// Curate only synthetic fixtures, public candidate output and metered usage.
// No credentials, provider metadata, private reasoning or full request dumps.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { auditVerification } from './verification-audit.mjs'

const roots = process.argv.slice(2)
if (roots.length < 2)
	throw new Error('Usage: verification-report.mjs <baseline-root> <trial-root> ...')
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const baseline = await json(join(roots[0], 'result.json'))
const report = {
	version: 1,
	baseline: {
		root: roots[0],
		currentDocument: baseline.currentDocument,
		phase: baseline.accepted.phase,
		summary: baseline.accepted.summary,
		sourceHashes: baseline.sourceHashes,
	},
	trials: [],
}

async function records(home) {
	const terminals = [],
		starts = []
	async function walk(dir) {
		let entries
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch (error) {
			if (error.code === 'ENOENT') return
			throw error
		}
		for (const entry of entries) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) await walk(path)
			else if (entry.name === 'start.json') starts.push(await json(path))
			else if (entry.name === 'transcript.jsonl')
				for (const line of (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)) {
					const event = JSON.parse(line)
					if (['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)) {
						const { type, runId, result, stopReason, timestamp, budget } = event
						terminals.push({ type, runId, result, stopReason, timestamp, budget })
					}
				}
		}
	}
	await walk(join(home, 'sessions'))
	await walk(join(home, 'residents'))
	return { terminals, starts }
}
async function sources(cwd) {
	const result = {}
	for (const name of ['package.json', 'checks.json']) {
		try {
			result[name] = await readFile(join(cwd, name), 'utf8')
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
		}
	}
	return result
}

for (const root of roots.slice(1)) {
	const raw = await json(join(root, 'result.json'))
	const common = {
		root,
		buildBefore: raw.buildBefore,
		buildAfter: raw.buildAfter,
		failure: raw.failure ?? null,
		providerTokens: raw.providerTokens,
	}
	if (raw.cases) {
		const cases = []
		for (const row of raw.cases)
			cases.push({
				id: row.id,
				phase: row.phase,
				providerTokens: row.providerTokens,
				requests: row.requests,
				runs: row.runs,
				finishes: row.finishes,
				...(await records(join(root, row.id, 'home'))),
				sources: await sources(join(root, row.id, 'workspace')),
				tools: row.tools
					.filter((event) => event.type === 'tool_executing')
					.map((event) => ({
						runId: event.runId,
						toolName: event.toolName,
						toolCallId: event.toolCallId,
					})),
			})
		report.trials.push({
			...common,
			kind: 'cases',
			live: raw.live,
			model: raw.model,
			effort: raw.effort,
			cases,
		})
	} else
		report.trials.push({
			...common,
			kind: 'continuity',
			scripted: true,
			passed: raw.passed,
			elapsedMs: raw.endedAt - raw.startedAt,
			policySnapshotVerified: raw.policySnapshotVerified ?? false,
			workerPids: raw.workerPids,
			runs: raw.runs,
			finishes: raw.finishes,
			...(await records(join(root, 'home'))),
			sources: await sources(join(root, 'workspace')),
			commands: raw.commands
				.filter((c) => c.args[0] !== 'status')
				.map((c) => ({ at: c.at, args: c.args, exit: c.exit })),
			snapshots: raw.snapshots.map((s) => ({
				label: s.label,
				at: s.at,
				runner: s.status.runner,
				pursuits: s.status.agenda.pursuits.map((p) => ({ id: p.id, state: p.state })),
			})),
			requests: raw.requests.map((r) => ({
				at: r.at,
				pid: r.pid,
				epoch: r.control.epoch,
				action: r.control.action,
				waveMarkers: [
					...new Set(
						r.acceptedInputs.flatMap((text) => text.match(/wave-(?:[1-6]|cancel|final)/g) ?? []),
					),
				],
			})),
		})
}
report.providerTokens = report.trials.reduce((sum, trial) => sum + trial.providerTokens, 0)
report.audit = auditVerification(report)
await writeFile(
	new URL('./verification-results.json', import.meta.url),
	`${JSON.stringify(report, null, 2)}\n`,
)
console.log(JSON.stringify(report.audit))
