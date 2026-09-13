import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { auditTrial } from './interpretation-audit.mjs'

const report = JSON.parse(
	await readFile(new URL('./interpretation-results.json', import.meta.url), 'utf8'),
)
const baseline = report.trials.find((trial) => trial.label === 'baseline')

test('audits all recorded trials independently of semantic verdicts', () => {
	assert.equal(
		report.trials.reduce((sum, trial) => sum + auditTrial(trial).providerTokens, 0),
		103247,
	)
})

function mutateEvidence(trial, transform) {
	const request = trial.cases[0].requests[0]
	request.evidence[0] = request.evidence[0]
		.split('\n')
		.map((line) => {
			if (!line.startsWith('{')) return line
			const record = JSON.parse(line)
			transform(record)
			return JSON.stringify(record)
		})
		.join('\n')
}

for (const field of ['sessionId', 'runId', 'claimId', 'pursuitId', 'revision', 'excerpt']) {
	test(`rejects altered original evidence ${field}`, () => {
		const copy = structuredClone(baseline)
		mutateEvidence(copy, (record) => {
			if (record.sessionId) record[field] = field === 'revision' ? 100000 : 'unowned-or-invented'
		})
		assert.throws(() => auditTrial(copy))
	})
}

test('rejects a read allowance overrun even when the driver claimed integrity', () => {
	const copy = structuredClone(baseline)
	mutateEvidence(copy, (record) => {
		if (record.querySelection) record.scannedBytes = 8 * 1024 * 1024 + 1
	})
	assert.equal(copy.cases[0].integrity, true)
	assert.throws(() => auditTrial(copy))
})

test('rejects a reordered accepted correction batch', () => {
	const copy = structuredClone(baseline)
	const request = copy.cases.find((row) => row.id === 'corrected-reference').requests[0]
	request.continuation = request.continuation.map((text) =>
		text
			.split('\n')
			.map((line) => {
				if (!line.startsWith('{')) return line
				const snapshot = JSON.parse(line)
				snapshot.wakeEvidence.reverse()
				return JSON.stringify(snapshot)
			})
			.join('\n'),
	)
	assert.throws(() => auditTrial(copy))
})

test('rejects a leaked current value before a fresh observation', () => {
	const copy = structuredClone(baseline)
	copy.cases[0].requests[0].messages.push({
		role: 'user',
		content: 'The current answer is CD-3964.',
	})
	assert.throws(() => auditTrial(copy))
})

test('rejects omitted usage and a modified build', () => {
	const usage = structuredClone(baseline)
	usage.cases[0].providerTokens = 0
	assert.throws(() => auditTrial(usage))
	const build = structuredClone(baseline)
	build.buildAfter['packages/sdk/dist/prompt/resident-step.js'] = 'changed-during-run'
	assert.throws(() => auditTrial(build))
})
