#!/usr/bin/env node
/**
 * Reduced W10 driver: re-runs ONLY `poolWarm` and `conformance` — not the
 * other three phases `runner.mjs` also runs (`acquireLatency`,
 * `operations`, `leaseProof`, `poolLessCreate`) — against a live
 * agent-sandbox controller (kind cluster), in-cluster.
 *
 * Purpose-built for issue #469's ABORT workstream, final round: does the
 * `AbortSignal` conformance case still pass, AND does a cancelled command
 * that forked a background job now confirm quickly instead of running out
 * the full `RemoteExecutionController` cancel-confirm window, now that the
 * guest image's `entrypoint.sh` execs into `tini` (a real subreaper) as the
 * container's PID 1 instead of running `agent.cjs` there directly? Defect 1
 * (the `CANCEL_GRACE_MS` race) was already re-verified in-cluster in an
 * earlier round of this same investigation (`kind-e2e-results.md`,
 * `## 2026-09-16`, "AbortSignal root cause, fix and re-verification"); this
 * script exists to check in THAT re-verification's method as a reproducible
 * script plus data, the same way `tcp-case-recheck.mjs` did for the TCP
 * case, and to add a fresh run against the `tini`-bearing image for Defect
 * 2's mitigation.
 *
 * Same shape as `runner.mjs`'s `poolWarm` and `conformance` phases
 * (verbatim where they overlap, and identical to `tcp-case-runner.mjs`'s
 * own copy of them) so all three stay comparable side by side.
 */

import { createSandboxProvider } from '@namzu/sandbox'

import { getResource } from './cluster-access.mjs'
// Relative filesystem import, deliberately bypassing @namzu/sandbox's own
// `exports` map — see runner.mjs's own comment on the same import.
import { defineSandboxConformance } from './node_modules/@namzu/sandbox/dist/testing/sandbox-conformance.js'

const NAMESPACE = process.env.NAMZU_E2E_NAMESPACE ?? 'namzu-e2e'
const TEMPLATE = process.env.NAMZU_E2E_TEMPLATE ?? 'namzu-task'
const POOL = process.env.NAMZU_E2E_POOL ?? 'namzu-task-pool'
const access = { inCluster: true }

const results = {
	startedAt: new Date().toISOString(),
	purpose:
		're-run of the full conformance suite (AbortSignal case included) against the tini-bearing guest image, issue #469 abort-case final round',
	namespace: NAMESPACE,
	template: TEMPLATE,
	pool: POOL,
	phases: {},
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringify(value) {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function baseConfig(overrides = {}) {
	return {
		tier: 'microvm',
		service: 'kubernetes',
		namespace: NAMESPACE,
		access,
		sandboxTemplateName: TEMPLATE,
		warmPoolName: POOL,
		...overrides,
	}
}

async function waitForWarmPool(timeoutMs = 120_000) {
	const path = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(
		NAMESPACE,
	)}/sandboxwarmpools/${encodeURIComponent(POOL)}`
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const pool = await getResource(access, path)
		const wanted = pool?.spec?.replicas ?? 1
		const ready = pool?.status?.readyReplicas ?? 0
		if (ready >= wanted) return { ready, wanted }
		if (Date.now() > deadline) {
			throw new Error(`SandboxWarmPool ${POOL} never reached ${wanted} readyReplicas (last observed ${ready})`)
		}
		await sleep(1000)
	}
}

async function phase(name, fn) {
	console.log(`\n=== phase: ${name} ===`)
	const startedAt = Date.now()
	try {
		const value = await fn()
		results.phases[name] = { ok: true, durationMs: Date.now() - startedAt, ...(value ?? {}) }
	} catch (err) {
		results.phases[name] = {
			ok: false,
			durationMs: Date.now() - startedAt,
			error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		}
		console.error(`[phase:${name}] FAILED:`, err)
	}
	console.log(`=== phase: ${name} done in ${results.phases[name].durationMs}ms ok=${results.phases[name].ok} ===`)
}

// ---------------------------------------------------------------------------
// phase: wait for the warm pool (verbatim from runner.mjs)
// ---------------------------------------------------------------------------
await phase('poolWarm', async () => {
	const { ready, wanted } = await waitForWarmPool()
	console.log(`warm pool ready: ${ready}/${wanted}`)
	return { ready, wanted }
})

// ---------------------------------------------------------------------------
// phase: the sandbox conformance suite, against one acquired sandbox at a
// time — verbatim from runner.mjs's own `conformance` phase. Timed per case
// so the AbortSignal case's own confirm latency is on record: a cancelled
// command that forked a background job used to run this out to the full
// ~8s RemoteExecutionController cancel-confirm window (Defect 2); with the
// tini-bearing image it should confirm in well under a second, same as
// every other case.
// ---------------------------------------------------------------------------
await phase('conformance', async () => {
	const provider = createSandboxProvider({ backend: baseConfig() })

	const tests = []
	const path = []
	const describe = (name, body) => {
		path.push(name)
		body()
		path.pop()
	}
	const it = (name, body) => tests.push({ name: [...path, name].join(' > '), body })
	const expect = (actual) => ({
		toBe(expected) {
			if (!Object.is(actual, expected)) throw new Error(`expected ${stringify(actual)} to be ${stringify(expected)}`)
		},
		toEqual(expected) {
			if (stringify(actual) !== stringify(expected)) {
				throw new Error(`expected ${stringify(actual)} to equal ${stringify(expected)}`)
			}
		},
		toBeGreaterThan(expected) {
			if (!(actual > expected)) throw new Error(`expected ${stringify(actual)} to be greater than ${stringify(expected)}`)
		},
		toMatch(expected) {
			if (typeof actual !== 'string' || !expected.test(actual)) {
				throw new Error(`expected ${stringify(actual)} to match ${expected}`)
			}
		},
	})

	defineSandboxConformance({
		describe,
		it,
		expect,
		label: 'kubernetes (kind e2e, abort-case recheck)',
		makeSandbox: async () => ({ sandbox: await provider.create() }),
	})

	let passed = 0
	let failed = 0
	const cases = []
	for (const test of tests) {
		const startedAt = Date.now()
		try {
			await test.body()
			const elapsedMs = Date.now() - startedAt
			cases.push({ name: test.name, passed: true, elapsedMs })
			passed++
			console.log(`  [PASS] (${elapsedMs}ms) ${test.name}`)
		} catch (err) {
			const elapsedMs = Date.now() - startedAt
			const detail = err instanceof Error ? err.message : String(err)
			cases.push({ name: test.name, passed: false, elapsedMs, detail })
			failed++
			console.log(`  [FAIL] (${elapsedMs}ms) ${test.name} — ${detail}`)
		}
	}
	return { total: tests.length, passed, failed, cases }
})

results.finishedAt = new Date().toISOString()
results.ok = Object.values(results.phases).every((p) => p.ok)

console.log('\n=== RESULTS_JSON_START ===')
console.log(JSON.stringify(results, null, 2))
console.log('=== RESULTS_JSON_END ===')

process.exitCode = results.ok ? 0 : 1
