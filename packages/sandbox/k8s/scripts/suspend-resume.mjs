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
 *     [--workspace-id acceptance-smoke] [--in-cluster | --server URL --token TOKEN]
 */

import { randomUUID } from 'node:crypto'

import { createKubernetesWorkspace } from '@namzu/sandbox'
import { getResource, parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const sandboxTemplateName = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const workspaceId = flags['workspace-id'] ?? process.env.NAMZU_K8S_WORKSPACE_ID ?? 'acceptance-smoke'
const access = resolveAccess(flags)

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

	const podBeforeSuspend = await podExists(workspace.id)
	ok = report('pod exists before suspend', podBeforeSuspend) && ok

	await workspace.suspend()
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
} finally {
	await workspace.destroy({ deleteDisk: true }).catch(() => {})
}

console.log(ok ? 'suspend-resume: all checks passed' : 'suspend-resume: at least one check FAILED')
process.exitCode = ok ? 0 : 1
