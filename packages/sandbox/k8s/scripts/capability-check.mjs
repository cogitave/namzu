#!/usr/bin/env node
/**
 * Acceptance criterion 5: the guest process really is deprivileged, not
 * merely reported as such.
 *
 * `provider.create()` already runs an acquire-time privilege probe
 * internally (`../../src/backends/kubernetes/privilege-probe.ts`) and
 * REFUSES to hand back a `Sandbox` if it fails — so if this script's
 * `create()` call resolves at all, that probe already passed. This script
 * exists to make the same evidence independently visible (its own,
 * separate `cat /proc/self/status`, parsed with the exact same field
 * format the internal probe reads) and to go one step further than the
 * internal probe does: actually ATTEMPT an operation that needs a
 * capability (`mount`) and confirm the kernel itself refuses it, rather
 * than only reading the advertised masks.
 *
 * Runs against the BUILT package (`pnpm -r build` first — see ../README.md).
 *
 * Usage:
 *   node capability-check.mjs --namespace namzu-sandboxes --template namzu-task \
 *     [--pool namzu-task-pool] [--in-cluster | --server URL --token TOKEN]
 */

import { createSandboxProvider } from '@namzu/sandbox'
import { parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const sandboxTemplateName = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const warmPoolName = flags.pool ?? process.env.NAMZU_K8S_POOL

// Same four fields and the same "bare hex, no 0x" shape
// `../../src/backends/kubernetes/privilege-probe.ts`'s `parseProcStatus`
// reads — reimplemented locally rather than imported, since it is not part
// of `@namzu/sandbox`'s public surface (this script is outside the package
// proper; see ../README.md).
function readStatusField(text, field) {
	for (const line of text.split(/\r?\n/)) {
		const colon = line.indexOf(':')
		if (colon < 0) continue
		if (line.slice(0, colon).trim() !== field) continue
		return line.slice(colon + 1).trim()
	}
	throw new Error(`/proc/self/status has no ${field} line`)
}

function parseProcStatus(text) {
	const masks = {}
	for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd']) {
		const raw = readStatusField(text, field)
		if (!/^[0-9a-fA-F]+$/.test(raw)) throw new Error(`${field} is not a bare hex mask: ${raw}`)
		masks[field] = BigInt(`0x${raw}`)
	}
	const noNewPrivsRaw = readStatusField(text, 'NoNewPrivs')
	if (!/^\d+$/.test(noNewPrivsRaw)) throw new Error(`NoNewPrivs is not an integer: ${noNewPrivsRaw}`)
	return { ...masks, NoNewPrivs: Number(noNewPrivsRaw) }
}

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

let sandbox
try {
	sandbox = await provider.create()
} catch (err) {
	// The internal probe itself refused this sandbox — that IS a capability
	// check failing, just one layer earlier than the rest of this script.
	report(
		'create() succeeds (the internal acquire-time probe admits the guest)',
		false,
		err instanceof Error ? err.message : String(err),
	)
	process.exit(1)
}

let ok = true
try {
	report('create() succeeds (the internal acquire-time probe admits the guest)', true)

	const statusResult = await sandbox.exec('cat', ['/proc/self/status'])
	const privileges = parseProcStatus(statusResult.stdout)
	console.log(
		`  CapInh=${privileges.CapInh.toString(16)} CapPrm=${privileges.CapPrm.toString(16)} ` +
			`CapEff=${privileges.CapEff.toString(16)} CapBnd=${privileges.CapBnd.toString(16)} ` +
			`NoNewPrivs=${privileges.NoNewPrivs}`,
	)
	ok = report('CapInh is all-zero', privileges.CapInh === 0n) && ok
	ok = report('CapPrm is all-zero', privileges.CapPrm === 0n) && ok
	ok = report('CapEff is all-zero', privileges.CapEff === 0n) && ok
	ok = report('CapBnd is all-zero (can never be regained)', privileges.CapBnd === 0n) && ok
	ok = report('NoNewPrivs is 1', privileges.NoNewPrivs === 1) && ok

	const mountResult = await sandbox.exec('/bin/sh', [
		'-c',
		'mount -t tmpfs tmpfs /tmp 2>&1; echo "namzu-exit:$?"',
	])
	const mountRefused = /namzu-exit:(?!0)\d+/.test(mountResult.stdout)
	console.log(`  mount attempt output: ${mountResult.stdout.trim()}`)
	ok = report('mount (CAP_SYS_ADMIN) is refused by the kernel, not merely unconfigured', mountRefused) && ok
} finally {
	await sandbox.destroy().catch(() => {})
}

console.log(ok ? 'capability-check: all checks passed' : 'capability-check: at least one check FAILED')
process.exitCode = ok ? 0 : 1
