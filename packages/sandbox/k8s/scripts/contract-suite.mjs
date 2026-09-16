#!/usr/bin/env node
/**
 * Acceptance criterion 1, in its literal form: "the Sandbox contract tests
 * pass against the new backend."
 *
 * Runs `defineSandboxConformance` (`../../src/testing/sandbox-conformance.ts`)
 * against a REAL sandbox acquired from a live cluster — the same suite
 * `../../src/backends/kubernetes/__tests__/conformance.test.ts` already runs
 * over a loopback agent, this time end to end: real API server, real
 * `SandboxClaim`/`SandboxWarmPool` bind, real guest agent over the pod
 * network.
 *
 * Runs against the BUILT package (`pnpm -r build` first — see ../README.md).
 *
 * Usage:
 *   node contract-suite.mjs --namespace namzu-sandboxes --template namzu-task \
 *     [--pool namzu-task-pool] [--in-cluster | --server URL --token TOKEN]
 */

import { createSandboxProvider } from '@namzu/sandbox'
import { parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

// Not published from `@namzu/sandbox`'s own entry point (see the suite's
// own module comment). This script runs plain `node`, not vitest, so it
// imports the BUILT output under `dist/` rather than `src/` — `pnpm -r
// build` first, same as importing `@namzu/sandbox` itself above.
import { defineSandboxConformance } from '../../dist/testing/sandbox-conformance.js'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const sandboxTemplateName = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const warmPoolName = flags.pool ?? process.env.NAMZU_K8S_POOL

const provider = createSandboxProvider({
	backend: {
		tier: 'microvm',
		service: 'kubernetes',
		namespace,
		access: resolveAccess(flags),
		sandboxTemplateName,
		...(warmPoolName ? { warmPoolName } : {}),
	},
})

// --- a minimal describe/it/expect runner ------------------------------
//
// `defineSandboxConformance` only REGISTERS cases through the describe/it
// it is handed (see that file's own doc comment) — it does not run them.
// `describe`'s body runs synchronously and may nest, so this collects every
// `it` into a flat, dot-joined-name queue while the describes run, then
// drains the queue afterwards, sequentially and in registration order.

/** @type {{ name: string; body: () => Promise<void> }[]} */
const tests = []
/** @type {string[]} */
const path = []

function describe(name, body) {
	path.push(name)
	body()
	path.pop()
}

function it(name, body) {
	tests.push({ name: [...path, name].join(' > '), body })
}

function stringify(value) {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function expect(actual) {
	return {
		toBe(expected) {
			if (!Object.is(actual, expected)) {
				throw new Error(`expected ${stringify(actual)} to be ${stringify(expected)}`)
			}
		},
		toEqual(expected) {
			const a = stringify(actual)
			const b = stringify(expected)
			if (a !== b) throw new Error(`expected ${a} to equal ${b}`)
		},
		toBeGreaterThan(expected) {
			if (!(actual > expected)) {
				throw new Error(`expected ${stringify(actual)} to be greater than ${stringify(expected)}`)
			}
		},
		toMatch(expected) {
			if (typeof actual !== 'string' || !expected.test(actual)) {
				throw new Error(`expected ${stringify(actual)} to match ${expected}`)
			}
		},
	}
}

defineSandboxConformance({
	describe,
	it,
	expect,
	label: 'kubernetes (live cluster)',
	makeSandbox: async () => ({ sandbox: await provider.create() }),
	// The image this runs against is built from this repository's
	// `k8s/Dockerfile`, which copies `agent/agent.cjs` in, so the cluster's
	// guest has ranged and streamed reads. Set this false when pointing the
	// suite at an image built from an older release; the two cases then
	// skip by name instead of failing.
	supportsRangedAndStreamedReads: true,
})

let passed = 0
let failed = 0
for (const test of tests) {
	try {
		await test.body()
		report(test.name, true)
		passed++
	} catch (err) {
		report(test.name, false, err instanceof Error ? err.message : String(err))
		failed++
	}
}

console.log(`contract-suite: ${passed}/${tests.length} passed`)
process.exitCode = failed > 0 ? 1 : 0
