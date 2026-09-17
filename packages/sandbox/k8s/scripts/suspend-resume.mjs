#!/usr/bin/env node
/**
 * Acceptance criterion 3: a persistent workspace's disk survives a
 * suspend/resume cycle, and the pod really goes away while it is
 * suspended.
 *
 * Writes a marker file and a small "dependency cache" file, suspends,
 * confirms the workspace's own pod object is gone from the API server and
 * that a call while suspended is refused, resumes, and confirms both files
 * are byte-identical to what was written before the suspend. Finishes with
 * `destroy({ deleteDisk: true })` so the run leaves nothing behind.
 *
 * It also measures the part #484 exists for, which the small files above
 * cannot: bytes written IMMEDIATELY before the suspend, with no `sync` of
 * this script's own anywhere. Two shapes, because they are durable by
 * different mechanisms:
 *
 *   - a `writeFile` of `--write-mib` MiB (default 5), which the guest
 *     fsyncs and renames before it answers `ok`;
 *   - a COMMAND that writes `--exec-mib` MiB through the page cache
 *     (default 100) and prints its sha256, which nothing fsyncs — it is
 *     durable only because `suspend()` asks the guest to `syncfs` the
 *     workspace mount before it patches.
 *
 * Both are read back after the resume and compared. The suspend's own
 * DURATION is printed beside them, because the grace period that flush
 * budget lives in is most of what a suspend costs on a VM runtime, and the
 * acceptance table wants the number as well as the verdict.
 *
 * Deliberately does NOT read the underlying PVC's `metadata.uid` — that
 * would need `persistentvolumeclaims: get`, which `rbac.yaml` does not
 * grant (this backend never reads a PVC object directly; see that file's
 * header comment for exactly which verbs it does grant and why). This
 * script proves disk survival the way a caller actually experiences it —
 * through the guest filesystem — rather than through a Kubernetes object
 * this Role cannot read.
 *
 * Runs against the BUILT package (`pnpm -r build` first — see ../README.md).
 *
 * Usage:
 *   node suspend-resume.mjs --namespace namzu-sandboxes --template namzu-workspace \
 *     [--workspace-id acceptance-smoke] [--write-mib 5] [--exec-mib 100] \
 *     [--in-cluster | --server URL --token TOKEN]
 */

import { randomUUID } from 'node:crypto'

import { createKubernetesWorkspace } from '@namzu/sandbox'
import { getResource, parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const sandboxTemplateName = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const workspaceId = flags['workspace-id'] ?? process.env.NAMZU_K8S_WORKSPACE_ID ?? 'acceptance-smoke'
const writeMib = Number(flags['write-mib'] ?? 5)
const execMib = Number(flags['exec-mib'] ?? 100)
const access = resolveAccess(flags)

/** `size` bytes of deterministic pseudo-random content (xorshift32). */
function deterministicBytes(size) {
	const out = Buffer.allocUnsafe(size)
	let x = 0x9e3779b9
	for (let i = 0; i < size; i += 1) {
		x ^= x << 13
		x >>>= 0
		x ^= x >> 17
		x ^= x << 5
		x >>>= 0
		out[i] = x & 0xff
	}
	return out
}

async function podExists(name) {
	try {
		await getResource(access, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`)
		return true
	} catch (err) {
		if (err instanceof Error && / -> 404$/.test(err.message)) return false
		throw err
	}
}

const config = {
	tier: 'microvm',
	service: 'kubernetes',
	namespace,
	access,
	sandboxTemplateName,
}

const workspace = await createKubernetesWorkspace(config, {
	workspaceId,
	workingDirectory: '/workspace',
})

let ok = true
try {
	const markerContent = `namzu suspend-resume acceptance marker ${randomUUID()}`
	const cacheContent = Buffer.from(randomUUID().repeat(64), 'utf8')
	await workspace.writeFile('/workspace/marker.txt', markerContent)
	await workspace.writeFile('/workspace/cache/dependency-cache.bin', cacheContent)

	// The two bodies this criterion is actually about, written LAST so that
	// nothing runs between them and the suspend.
	const payload = deterministicBytes(writeMib * 1024 * 1024)
	await workspace.writeFile('/workspace/payload.bin', payload)

	const written = await workspace.exec('/bin/sh', [
		'-c',
		`head -c ${execMib * 1024 * 1024} /dev/urandom > /workspace/bulk.bin && sha256sum /workspace/bulk.bin | cut -d' ' -f1`,
	])
	ok = report(`a command wrote ${execMib} MiB`, written.exitCode === 0) && ok
	const bulkDigestBefore = String(written.stdout ?? '').trim()

	const podBeforeSuspend = await podExists(workspace.id)
	ok = report('pod exists before suspend', podBeforeSuspend) && ok

	// No sync, no pause: straight into the suspend. Before #484 this was the
	// sequence with no durability guarantee at all.
	const suspendStartedAt = Date.now()
	await workspace.suspend()
	const suspendMs = Date.now() - suspendStartedAt
	console.log(`[INFO] suspend() took ${suspendMs}ms (row 3's "Measured" column)`)
	ok = report('workspace reports suspended: true after suspend()', workspace.suspended === true) && ok

	const podAfterSuspend = await podExists(workspace.id)
	ok = report('pod is gone while suspended', podAfterSuspend === false) && ok

	let rejectedWhileSuspended = false
	try {
		await workspace.exec('/bin/echo', ['should not run'])
	} catch {
		rejectedWhileSuspended = true
	}
	ok = report('a call while suspended is refused rather than hanging', rejectedWhileSuspended) && ok

	await workspace.resume()
	ok = report('workspace reports suspended: false after resume()', workspace.suspended === false) && ok

	const markerAfter = (await workspace.readFile('/workspace/marker.txt')).toString('utf8')
	ok = report('marker file survived suspend/resume byte-for-byte', markerAfter === markerContent) && ok

	const cacheAfter = await workspace.readFile('/workspace/cache/dependency-cache.bin')
	ok = report('dependency cache survived suspend/resume byte-for-byte', cacheAfter.equals(cacheContent)) && ok

	const payloadAfter = await workspace.readFile('/workspace/payload.bin')
	ok =
		report(
			`the ${writeMib} MiB writeFile issued immediately before the suspend survived byte-for-byte`,
			payloadAfter.equals(payload),
		) && ok
	// Read back through the guest rather than over the wire: transferring
	// 100 MiB proves nothing this digest does not, and the claim is about
	// the bytes on the device.
	const digestAfter = await workspace.exec('/bin/sh', [
		'-c',
		"sha256sum /workspace/bulk.bin | cut -d' ' -f1",
	])
	const bulkDigestAfter = String(digestAfter.stdout ?? '').trim()
	ok =
		report(
			`the ${execMib} MiB a command wrote immediately before the suspend has the same sha256`,
			digestAfter.exitCode === 0 &&
				bulkDigestAfter === bulkDigestBefore &&
				bulkDigestBefore.length === 64,
		) && ok
	console.log(`[INFO] sha256 before/after: ${bulkDigestBefore} / ${bulkDigestAfter}`)
} finally {
	await workspace.destroy({ deleteDisk: true }).catch(() => {})
}

console.log(ok ? 'suspend-resume: all checks passed' : 'suspend-resume: at least one check FAILED')
process.exitCode = ok ? 0 : 1
