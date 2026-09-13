import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { auditLifecycle } from './lifetime-audit.mjs'

const control = JSON.parse(
	await readFile(new URL('./lifetime-control.json', import.meta.url), 'utf8'),
)
const check = (value) => auditLifecycle(value, { minimumElapsedMs: 0 })
const sustained = JSON.parse(
	await readFile(new URL('./lifetime-results.json', import.meta.url), 'utf8'),
)

test('the retained sustained run passes the two-hour audit with explicit unresolved usage', () => {
	expectSustained(sustained)
})

function expectSustained(data) {
	assert.deepEqual(auditLifecycle(data), {
		elapsedMs: 7_232_851,
		admissions: 30,
		verifiedCompletions: 2,
		knownTokens: 3360,
		incompleteUsage: 2,
		idleModelRequests: 0,
	})
}

test('missing recovery, a foreign request PID or a failed command cannot pass as continuity', () => {
	for (const mutate of [
		(d) => {
			d.transitions = d.transitions.filter((t) => t.action !== 'reconcile')
		},
		(d) => {
			d.requests[0].pid = -1
		},
		(d) => {
			d.transitions[0].exit = 1
		},
	]) {
		const data = structuredClone(sustained)
		mutate(data)
		assert.throws(() => auditLifecycle(data))
	}
})

test('the retained control passes its own audit but cannot satisfy the sustained minimum', () => {
	assert.equal(check(control).knownTokens, 3360)
	assert.throws(() => auditLifecycle(control), /Insufficient real elapsed/)
})
test('turning missing consumption into final zero fails the audit', () => {
	const data = structuredClone(control)
	data.inspection.unknown.ownUsageAttempts = 0
	data.inspection.usageComplete = true
	assert.throws(() => check(data))
})
test('counting root and tree together or erasing archived consumption fails', () => {
	for (const tokens of [6720, 0]) {
		const data = structuredClone(control)
		data.inspection.recorded.ownTokens = tokens
		assert.throws(() => check(data))
	}
})
test('an extra idle request fails even when the idle counter claims no work', () => {
	const data = structuredClone(control)
	data.requests[0].at = data.idle[0].at - 500
	assert.throws(() => check(data), /idle interval/)
})
test('altering end time and declared intervals cannot turn the short control into a two-hour soak', () => {
	const data = structuredClone(control)
	data.endedAt = data.startedAt + 7_200_000
	data.intervalMs = 600_000
	for (const sample of data.idle) sample.intervalMs = 600_000
	assert.throws(() => auditLifecycle(data), /accelerated/)
})
test('copied claims, missing verification and changed production fingerprints fail', () => {
	for (const mutate of [
		(d) => {
			d.finishes[0].claimId = d.finishes[1].claimId
		},
		(d) => {
			d.finishes.find((f) => f.outcome === 'complete').verification.receipt.claims.version = 'wrong'
		},
		(d) => {
			d.buildAfter[Object.keys(d.buildAfter)[0]] = '0'.repeat(64)
		},
	]) {
		const data = structuredClone(control)
		mutate(data)
		assert.throws(() => check(data))
	}
})
