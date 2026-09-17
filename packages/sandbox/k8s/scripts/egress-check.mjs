#!/usr/bin/env node
/**
 * Does this cluster actually bound what a sandbox can REACH — and does this
 * backend agree.
 *
 * The egress sibling of ./ingress-check.mjs, in the same two parts and for
 * the same reason: only the second needs a cluster that ENFORCES anything.
 *
 *  1. **The shipped check admits this cluster.** Creating a sandbox with
 *     `config.egress` set runs both halves of
 *     `src/backends/kubernetes/egress-policy.ts`: the named object is
 *     compared to the translation exactly, and every policy in the namespace
 *     that selects the pod is read and refused if it lets out more than the
 *     translation does. A refusal prints the whole finding — every policy
 *     examined, with a verdict each, and the labels they were matched
 *     against — and this script stops there.
 *  2. **The boundary really holds from inside the sandbox.** The probes run
 *     in the guest and dial addresses the configured kind must and must not
 *     reach.
 *
 * ## The positive control, and what it is for
 *
 * A probe that reports "closed" because it is broken looks exactly like a
 * probe that reports "closed" because the policy works — and under
 * `no-network` EVERY outbound probe is supposed to come back closed, so
 * without a control this script would pass on a guest with no working
 * runtime at all. Two controls run first, and both must pass before any
 * result below them is read as evidence:
 *
 *  - a TCP dial of the pod's OWN agent port on `127.0.0.1`, which no
 *    NetworkPolicy governs, must come back `open`;
 *  - a resolution of `localhost`, which no resolver is needed for, must
 *    succeed.
 *
 * ## What a green run does NOT prove
 *
 * A cluster whose CNI does not implement `NetworkPolicy` — the stock local
 * `kind` cluster is one — accepts every policy object and enforces none of
 * them. There, every "must be closed" probe CONNECTS and this script reports
 * FAIL, which is the point: a non-enforcing environment has to fail loudly
 * rather than pass for the wrong reason. Never read a pass here off anything
 * but a cluster whose CNI enforces policy.
 *
 * A hostname allowlist (`static`/`resolver` under `engine: 'cilium'`) is NOT
 * probed by this script at all, `config.egress.ciliumNarrowing`'s port,
 * DNS-name and TLS-server-name options included. That translation — narrowed
 * or not — is enforced at L7 by one CNI's own agent; nothing in this repo has
 * ever measured it, and a probe written against an unmeasured mechanism would
 * report the mechanism's absence as a policy success.
 *
 * Runs against the BUILT package (`pnpm -r build` first — see ../README.md).
 *
 * Usage:
 *   node egress-check.mjs --namespace namzu-sandboxes --template namzu-task \
 *     --policy no-network|public-internet|deny-all \
 *     [--pool namzu-task-pool] [--agent-port 1024] [--engine cilium] \
 *     [--profile none] [--profile-label-key sandbox.users.io/egress-profile] \
 *     [--public-address 1.1.1.1:443] [--private-address 10.0.0.1:443] \
 *     [--api-server-ip 10.96.0.1] [--in-cluster | --server URL --token TOKEN]
 *
 * `--profile` is what makes this script runnable ONCE PER PROFILE against one
 * warm pool: it sets `egress.profile`, so the sandbox is claimed with that
 * label, the named object checked is `<template>-<profile>-egress` and the
 * union check runs against the profile's own selector. Without it the run
 * exercises the unprofiled policy, whatever profiles the deployment uses.
 */

import { createSandboxProvider } from '@namzu/sandbox'
import { parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const template = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const warmPoolName = flags.pool ?? process.env.NAMZU_K8S_POOL
const agentPort = Number(flags['agent-port'] ?? process.env.NAMZU_K8S_AGENT_PORT ?? 1024)
const engine = flags.engine ?? process.env.NAMZU_K8S_EGRESS_ENGINE
const profile = flags.profile ?? process.env.NAMZU_K8S_EGRESS_PROFILE
const profileLabelKey = flags['profile-label-key'] ?? process.env.NAMZU_K8S_EGRESS_PROFILE_LABEL_KEY
const policyKind = String(flags.policy ?? process.env.NAMZU_K8S_EGRESS_POLICY ?? 'no-network')
const access = resolveAccess(flags)

const PUBLIC_ADDRESS = String(flags['public-address'] ?? '1.1.1.1:443')
const PRIVATE_ADDRESS = String(flags['private-address'] ?? '10.0.0.1:443')
const METADATA_ADDRESS = '169.254.169.254:80'
const PLATFORM_ADDRESS = '168.63.129.16:80'
const apiServerIp = flags['api-server-ip'] ?? process.env.NAMZU_K8S_API_SERVER_IP

if (!['no-network', 'public-internet', 'deny-all'].includes(policyKind)) {
	console.log(`[FAIL] --policy must be one of no-network, public-internet, deny-all (got ${policyKind})`)
	process.exit(1)
}

/**
 * The TCP probe, as a program the guest runs. Written out here rather than
 * shipped as a file because the image carries no copy of it, and `exec` is
 * the only way into the pod this backend has.
 *
 * Exactly three outcomes, never a throw: `open` (a completed handshake),
 * `closed:<reason>` (refused, unreachable, or nothing inside the deadline),
 * and nothing else. A policy DROPS a packet rather than answering it, so a
 * blocked dial normally shows up as the timeout.
 */
function tcpProbe(address, timeoutMs = 5_000) {
	const [host, port] = splitAddress(address)
	return `
const net = require('node:net')
const socket = net.connect({ host: ${JSON.stringify(host)}, port: ${port} })
let settled = false
const done = (result) => {
  if (settled) return
  settled = true
  process.stdout.write('namzu-probe:' + result + '\\n')
  socket.destroy()
  process.exit(0)
}
socket.setTimeout(${timeoutMs})
socket.once('connect', () => done('open'))
socket.once('timeout', () => done('closed:timeout'))
socket.once('error', (err) => done('closed:' + (err.code || err.message)))
setTimeout(() => done('closed:deadline'), ${timeoutMs + 1_000}).unref()
`
}

/** The resolver probe. `resolved:<address>` or `unresolved:<reason>`. */
function dnsProbe(name, timeoutMs = 5_000) {
	return `
const dns = require('node:dns')
let settled = false
const done = (result) => {
  if (settled) return
  settled = true
  process.stdout.write('namzu-probe:' + result + '\\n')
  process.exit(0)
}
setTimeout(() => done('unresolved:deadline'), ${timeoutMs}).unref()
dns.lookup(${JSON.stringify(name)}, (err, address) => done(err ? 'unresolved:' + (err.code || err.message) : 'resolved:' + address))
`
}

function splitAddress(address) {
	const colon = address.lastIndexOf(':')
	if (colon < 0) return [address, agentPort]
	return [address.slice(0, colon), Number(address.slice(colon + 1))]
}

function readProbe(stdout) {
	return /namzu-probe:(\S+)/.exec(stdout ?? '')?.[1]
}

const backendConfig = {
	tier: 'microvm',
	service: 'kubernetes',
	namespace,
	access,
	sandboxTemplateName: template,
	...(warmPoolName ? { warmPoolName } : {}),
	agentPort,
	egress: {
		policy: { kind: policyKind },
		...(engine ? { engine } : {}),
		...(profile ? { profile: String(profile) } : {}),
		...(profileLabelKey ? { profileLabelKey: String(profileLabelKey) } : {}),
	},
}

let ok = true
let sandbox
let peer

async function dial(box, address) {
	const result = readProbe((await box.exec('node', ['-e', tcpProbe(address)])).stdout)
	return result ?? 'closed:no-result'
}

async function resolve(box, name) {
	const result = readProbe((await box.exec('node', ['-e', dnsProbe(name)])).stdout)
	return result ?? 'unresolved:no-result'
}

function mustBeClosed(name, result, address) {
	return report(
		name,
		result.startsWith('closed:'),
		result === 'open'
			? `the connection to ${address} succeeded: either no policy stops it, or this cluster accepts NetworkPolicy objects without enforcing them (the stock local kind CNI does exactly that)`
			: result,
	)
}

/** Steps 2-4. Returns rather than exits, so the cleanup below always runs. */
async function probeFromInsideTheSandbox() {
	// 2. POSITIVE CONTROLS. Both must pass, or nothing below is evidence:
	//    under `no-network` every real probe is SUPPOSED to fail, so a broken
	//    probe program would otherwise read as a perfect boundary.
	const control = await dial(sandbox, `127.0.0.1:${agentPort}`)
	console.log(`  control probe (127.0.0.1:${agentPort}, must be open): ${control}`)
	if (control !== 'open') {
		return report(
			'POSITIVE CONTROL: the probe reports a port it can reach as open',
			false,
			'the probe apparatus is broken or the guest has no usable runtime — every egress result below would be meaningless, so this run proves nothing',
		)
	}
	report('POSITIVE CONTROL: the probe reports a port it can reach as open', true)

	const localName = await resolve(sandbox, 'localhost')
	console.log(`  control probe (resolve localhost, must resolve): ${localName}`)
	if (!localName.startsWith('resolved:')) {
		return report(
			'POSITIVE CONTROL: the resolver probe resolves a name needing no resolver',
			false,
			'the resolver probe is broken, so an unresolved name below would say nothing about egress',
		)
	}
	report('POSITIVE CONTROL: the resolver probe resolves a name needing no resolver', true)

	// 3. `exec` still works, which every line above already depended on —
	//    stated as its own row because "the sandbox is unusable" and "the
	//    boundary holds" must never be confused for one another.
	const alive = await sandbox.exec('sh', ['-c', 'echo namzu-alive'])
	if (!report('exec inside the sandbox still works', alive.stdout.includes('namzu-alive'))) {
		return false
	}

	// 4. The real probes, per configured kind.
	if (policyKind === 'no-network') {
		const name = await resolve(sandbox, 'example.com')
		console.log(`  egress probe (resolve example.com, must fail): ${name}`)
		let passed = report(
			'a no-network sandbox cannot resolve an outside name',
			name.startsWith('unresolved:'),
			name.startsWith('resolved:')
				? 'the cluster resolver answered, so this pod still has a channel out — the whole reason no-network is not deny-all'
				: name,
		)
		const publicDial = await dial(sandbox, PUBLIC_ADDRESS)
		console.log(`  egress probe (${PUBLIC_ADDRESS}, must be closed): ${publicDial}`)
		passed = mustBeClosed('a no-network sandbox cannot open a TCP connection out', publicDial, PUBLIC_ADDRESS) && passed
		return passed
	}

	if (policyKind === 'deny-all') {
		// deny-all allows the cluster's own resolver and nothing else. That it
		// resolves is not a defect, it is the translation — and it is exactly
		// why `no-network` exists.
		const publicDial = await dial(sandbox, PUBLIC_ADDRESS)
		console.log(`  egress probe (${PUBLIC_ADDRESS}, must be closed): ${publicDial}`)
		return mustBeClosed('a deny-all sandbox cannot open a TCP connection out', publicDial, PUBLIC_ADDRESS)
	}

	// public-internet.
	const publicDial = await dial(sandbox, PUBLIC_ADDRESS)
	console.log(`  egress probe (${PUBLIC_ADDRESS}, must be OPEN): ${publicDial}`)
	let passed = report(
		'a public-internet sandbox reaches a public address',
		publicDial === 'open',
		publicDial === 'open' ? undefined : `${publicDial} — the kind allows the public internet, so this one is a FAILURE to reach`,
	)
	for (const [name, address] of [
		['the instance metadata address', METADATA_ADDRESS],
		['the platform endpoint', PLATFORM_ADDRESS],
		['a private address', PRIVATE_ADDRESS],
	]) {
		const result = await dial(sandbox, address)
		console.log(`  egress probe (${address}, must be closed): ${result}`)
		passed = mustBeClosed(`a public-internet sandbox cannot reach ${name}`, result, address) && passed
	}
	if (apiServerIp) {
		const result = await dial(sandbox, `${apiServerIp}:443`)
		console.log(`  egress probe (${apiServerIp}:443, must be closed): ${result}`)
		passed = mustBeClosed("a public-internet sandbox cannot reach the API server's service IP", result, apiServerIp) && passed
	} else {
		console.log(
			"  NOT PROBED: the API server's service IP — pass --api-server-ip to include it (this Role does not read Services)",
		)
	}

	// Another sandbox pod, which is the "cannot reach sideways" half of the
	// kind's whole point. Its address comes off the peer handle's own
	// transport target rather than a Service read this Role may not have.
	peer = await createSandboxProvider({ backend: backendConfig }).create()
	const peerIp = readProbe((await peer.exec('node', ['-e', "process.stdout.write('namzu-probe:' + require('node:os').networkInterfaces().eth0?.[0]?.address)"])).stdout)
	if (peerIp && peerIp !== 'undefined') {
		const result = await dial(sandbox, `${peerIp}:${agentPort}`)
		console.log(`  egress probe (${peerIp}:${agentPort}, must be closed): ${result}`)
		passed = mustBeClosed('a public-internet sandbox cannot reach another sandbox pod', result, peerIp) && passed
	} else {
		console.log('  NOT PROBED: another sandbox pod — the peer sandbox reported no address on eth0')
	}
	return passed
}

try {
	// 1. The shipped check, run by the shipped code. A refusal here is the
	//    finding, printed in full — it names every policy it examined.
	try {
		sandbox = await createSandboxProvider({ backend: backendConfig }).create()
		report(
			`the backend admits this namespace for a '${policyKind}' policy: the named object matches and nothing selecting these pods widens it`,
			true,
		)
	} catch (err) {
		report(
			`the backend admits this namespace for a '${policyKind}' policy: the named object matches and nothing selecting these pods widens it`,
			false,
			err instanceof Error ? err.message : String(err),
		)
		ok = false
	}

	if (ok) ok = await probeFromInsideTheSandbox()
} catch (err) {
	// Without this the summary never prints: a throw from the probe half would
	// run the cleanup and leave the module, exiting non-zero with nothing said
	// about why. A check that could not be RUN is a FAIL with a reason.
	report(
		'the check ran to completion',
		false,
		err instanceof Error ? (err.stack ?? err.message) : String(err),
	)
	ok = false
} finally {
	await peer?.destroy().catch(() => {})
	await sandbox?.destroy().catch(() => {})
}

console.log(ok ? 'egress-check: all checks passed' : 'egress-check: at least one check FAILED')
process.exitCode = ok ? 0 : 1
