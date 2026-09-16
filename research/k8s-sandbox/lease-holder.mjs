#!/usr/bin/env node
/**
 * Lease-proof holder, spawned by runner.mjs as a SEPARATE process.
 *
 * Acquires one sandbox with a short claimTtlSeconds, holds it while the
 * handle's own renewal loop (packages/sandbox/src/backends/kubernetes/lease.ts)
 * keeps PATCHing spec.lifecycle.shutdownTime forward, then exits WITHOUT
 * calling sandbox.destroy() — simulating a host that died mid-run. There is
 * no public API to stop the renewal loop without destroying the object, so
 * a real process exit is the only way to make renewal actually stop while
 * leaving the claim/sandbox behind for the controller to reap on its own.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { createSandboxProvider } from '@namzu/sandbox'

const NAMESPACE = process.env.NAMZU_E2E_NAMESPACE ?? 'namzu-e2e'
const TEMPLATE = process.env.NAMZU_E2E_TEMPLATE ?? 'namzu-task'
const POOL = process.env.NAMZU_E2E_POOL ?? 'namzu-task-pool'
const TTL_SECONDS = Number(process.env.NAMZU_E2E_LEASE_TTL_SECONDS ?? 60)
const HOLD_MS = Number(process.env.NAMZU_E2E_HOLD_MS ?? 150_000)
const statusFile = process.argv[2]

function writeStatus(patch) {
	let current = {}
	try {
		current = JSON.parse(readFileSync(statusFile, 'utf8'))
	} catch {
		/* first write */
	}
	const next = { ...current, ...patch }
	writeFileSync(statusFile, JSON.stringify(next, null, 2))
	return next
}

const provider = createSandboxProvider({
	backend: {
		tier: 'microvm',
		service: 'kubernetes',
		namespace: NAMESPACE,
		access: { inCluster: true },
		sandboxTemplateName: TEMPLATE,
		warmPoolName: POOL,
		claimTtlSeconds: TTL_SECONDS,
		onLeaseRenewalError: (err) => console.error('[holder] lease renewal error', err),
	},
})

const sandbox = await provider.create()
writeStatus({ sandboxId: sandbox.id, acquiredAt: new Date().toISOString(), checks: [] })
console.log(`acquired ${sandbox.id}, holding ${HOLD_MS}ms with TTL=${TTL_SECONDS}s (renewal interval ~${TTL_SECONDS / 2}s)`)

const startedAt = Date.now()
const intervalMs = 10_000
const checks = []
while (Date.now() - startedAt < HOLD_MS) {
	const waitMs = Math.min(intervalMs, HOLD_MS - (Date.now() - startedAt))
	if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
	try {
		const result = await sandbox.exec('/bin/sh', ['-c', 'echo alive'])
		checks.push({
			t: new Date().toISOString(),
			elapsedMs: Date.now() - startedAt,
			exists: true,
			status: sandbox.status,
			execOk: result.exitCode === 0,
		})
	} catch (err) {
		checks.push({
			t: new Date().toISOString(),
			elapsedMs: Date.now() - startedAt,
			exists: false,
			execOk: false,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	writeStatus({ checks })
	console.log(`check at +${Math.round((Date.now() - startedAt) / 1000)}s status=${sandbox.status}`)
}

writeStatus({ finishedHoldAt: new Date().toISOString(), checks })
console.log('hold complete — exiting WITHOUT destroy() to simulate a dead host')
process.exit(0)
