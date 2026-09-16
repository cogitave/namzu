#!/usr/bin/env node
/**
 * Acceptance criterion 2: acquire N sandboxes serially against a warmed
 * pool and report the p50 (target < 1 s) and p99 wall time from
 * `provider.create()` to a resolved `Sandbox`.
 *
 * Waits for the `SandboxWarmPool`'s own `status.readyReplicas` to reach
 * its `replicas` first — timing a claim against a pool that is still
 * cold-starting its own replicas would measure this cluster's node/image-
 * pull speed, not the adopt-from-warm path this criterion is actually
 * about.
 *
 * Runs against the BUILT package (`pnpm -r build` first — see ../README.md).
 *
 * Usage:
 *   node acquire-p50.mjs --namespace namzu-sandboxes --template namzu-task \
 *     --pool namzu-task-pool [--count 50] [--pool-wait-timeout-ms 60000] \
 *     [--in-cluster | --server URL --token TOKEN]
 */

import { createSandboxProvider } from '@namzu/sandbox'
import {
	getResource,
	parseArgs,
	report,
	requireOption,
	resolveAccess,
} from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const sandboxTemplateName = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const warmPoolName = requireOption(flags, 'pool', 'NAMZU_K8S_POOL')
const count = Number(flags.count ?? 50)
const poolWaitTimeoutMs = Number(flags['pool-wait-timeout-ms'] ?? 60_000)
const access = resolveAccess(flags)

function percentile(sortedMs, p) {
	const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)
	return sortedMs[Math.max(0, index)]
}

async function waitForWarmPool() {
	const path = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(
		namespace,
	)}/sandboxwarmpools/${encodeURIComponent(warmPoolName)}`
	const deadline = Date.now() + poolWaitTimeoutMs
	for (;;) {
		const pool = await getResource(access, path)
		const wanted = pool?.spec?.replicas ?? 1
		const ready = pool?.status?.readyReplicas ?? 0
		if (ready >= wanted) return { ready, wanted }
		if (Date.now() > deadline) {
			throw new Error(
				`SandboxWarmPool ${warmPoolName} never reached ${wanted} readyReplicas within ${poolWaitTimeoutMs}ms (last observed ${ready})`,
			)
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
}

const { ready, wanted } = await waitForWarmPool()
console.log(`warm pool ready: ${ready}/${wanted} replicas`)

const provider = createSandboxProvider({
	backend: {
		tier: 'microvm',
		service: 'kubernetes',
		namespace,
		access,
		sandboxTemplateName,
		warmPoolName,
	},
})

const durationsMs = []
for (let i = 0; i < count; i++) {
	const startedAt = process.hrtime.bigint()
	const sandbox = await provider.create()
	const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
	durationsMs.push(elapsedMs)
	// Torn down immediately so the pool has the rest of this loop to
	// replenish behind it — teardown time is deliberately NOT part of the
	// measured duration above.
	await sandbox.destroy().catch(() => {})
	console.log(`  acquire ${i + 1}/${count}: ${elapsedMs.toFixed(1)}ms`)
}

const sorted = [...durationsMs].sort((a, b) => a - b)
const p50 = percentile(sorted, 50)
const p99 = percentile(sorted, 99)

console.log(`acquire-p50: p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms over ${count} acquires`)
report('acquire p50 < 1000ms', p50 < 1000, `measured ${p50.toFixed(1)}ms`)
