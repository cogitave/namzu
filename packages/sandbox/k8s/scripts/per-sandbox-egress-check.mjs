#!/usr/bin/env node
/**
 * Is a per-sandbox hostname grant ENFORCED on this cluster's data plane — the
 * acceptance probe for `config.egress.perSandbox` (#617).
 *
 * ## NEEDS A CLUSTER THAT ENFORCES CILIUM FQDN POLICY
 *
 * Everything the unit suite proves about per-sandbox egress is a statement
 * about OBJECTS: which are written, what they contain, what the admission
 * fence is, what the union of the policies selecting the pod is. None of it
 * says a packet is dropped. This script is the one place that does, and it can
 * only run against a cluster whose CNI is Cilium with `toFQDNs` enforcement
 * on (the DNS proxy enabled). The stock local `kind` cluster enforces no
 * NetworkPolicy at all: every "must be refused" row below CONNECTS there, and
 * this script reports FAIL, which is the point (see `egress-check.mjs`'s
 * header). It was NOT run against an enforcing cluster when it was written;
 * nothing recorded in this repository has been measured by it yet. Record the
 * first run, with the date, the Cilium version and the cluster's shape, where
 * `egress-check.mjs`'s numbers go.
 *
 * ## What it does
 *
 * Creates a real task sandbox on a `no-network` baseline with
 * `egress.perSandbox` configured (ports narrowed to 443, DNS names narrowed),
 * and runs the probes from INSIDE the guest:
 *
 *  - **POSITIVE CONTROLS first.** A dial of the pod's own agent port on
 *    127.0.0.1 must be open and `localhost` must resolve. Without them every
 *    refusal below would pass on a guest with no working runtime.
 *  - **(a) Before any grant:** the allowed name neither resolves nor connects.
 *  - **(b) After `setNetworkPolicy([host])`:** the host resolves and connects
 *    on 443 (positive); the same host on another port is refused; a name that
 *    was not granted does not resolve; a fixed public IP is not reachable; and,
 *    if `--cname-host` names a host that resolves through a CNAME chain, it is
 *    admitted (positive).
 *  - **(c) After `setNetworkPolicy([])`:** (a) holds again.
 *  - **(d) SNI.** With `--tls-server-names` the config sets
 *    `narrowing.tlsServerNames`, and a TLS handshake to the allowed address
 *    presenting a DIFFERENT server name must be refused (after a positive
 *    handshake with the right name). Without it the script prints SNI as
 *    UNENFORCED and does not count it as a pass: whether a managed Cilium
 *    distribution enforces `serverNames` is a property of its L7 proxy, and
 *    this repository will not claim a property the policy object cannot show.
 *
 * Exit status is non-zero on any positive control or positive probe that
 * fails and on any negative probe that connects.
 *
 * ## What it cannot observe
 *
 *  - SNI enforcement on a distribution that accepts `serverNames` without
 *    enforcing it, unless `--tls-server-names` is given and the decoy
 *    handshake is run. Even then a pass means "this decoy was refused", not
 *    "every SNI is checked".
 *  - Whether a host's resolver answers a refused search-suffix query with
 *    REFUSED or NXDOMAIN, and what a glibc or musl search walk does with it.
 *    The guest's resolver library is not asked, and `dnsNames` narrowing is
 *    only proved to the extent the allowed name still resolves.
 *  - Anything about the `permittedHostsParam` admission rule: the CEL runs in
 *    the API server and is measured with a direct write to a cluster with the
 *    CRD installed, not here.
 *  - Propagation time. Cilium takes seconds to program a new policy; the
 *    positive probes retry for `--settle-seconds` (default 30) before they
 *    fail, and the negative probes are not retried at all.
 *
 * Runs against the BUILT package (`pnpm -r build` first).
 *
 * Usage:
 *   node per-sandbox-egress-check.mjs --namespace namzu-sandboxes \
 *     --template namzu-task --pool namzu-task-pool \
 *     --host login.example.com \
 *     [--cname-host www.example.com] [--denied-name example.org] \
 *     [--other-port 80] [--fixed-ip 1.1.1.1:443] [--tls-server-names] \
 *     [--sni-decoy example.net] [--admission-policy namzu-per-sandbox-egress] \
 *     [--host-identity system:serviceaccount:namzu-sandboxes:namzu-sandbox-host] \
 *     [--agent-port 1024] [--settle-seconds 30] \
 *     [--in-cluster | --server URL --token TOKEN]
 */

import { createSandboxProvider } from '@namzu/sandbox'
import { parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const template = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const host = String(requireOption(flags, 'host', 'NAMZU_K8S_PROBE_HOST')).toLowerCase()
const warmPoolName = flags.pool ?? process.env.NAMZU_K8S_POOL
const agentPort = Number(flags['agent-port'] ?? process.env.NAMZU_K8S_AGENT_PORT ?? 1024)
const cnameHost = flags['cname-host'] ? String(flags['cname-host']).toLowerCase() : undefined
const deniedName = String(flags['denied-name'] ?? 'example.org').toLowerCase()
const otherPort = Number(flags['other-port'] ?? 80)
const fixedIp = String(flags['fixed-ip'] ?? '1.1.1.1:443')
const tlsServerNames = flags['tls-server-names'] === true || flags['tls-server-names'] === 'true'
const sniDecoy = String(flags['sni-decoy'] ?? 'example.net')
const admissionPolicyName = String(flags['admission-policy'] ?? 'namzu-per-sandbox-egress')
const hostIdentity = flags['host-identity'] ? String(flags['host-identity']) : undefined
const settleMs = Number(flags['settle-seconds'] ?? 30) * 1_000
const access = resolveAccess(flags)

if ([host, cnameHost].includes(deniedName) || deniedName === sniDecoy) {
	console.log('[FAIL] --denied-name must differ from --host, --cname-host and --sni-decoy')
	process.exit(1)
}

function tcpProbe(address, timeoutMs = 5_000) {
	const colon = address.lastIndexOf(':')
	const name = address.slice(0, colon)
	const port = Number(address.slice(colon + 1))
	return `
const net = require('node:net')
const socket = net.connect({ host: ${JSON.stringify(name)}, port: ${port} })
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
dns.lookup(${JSON.stringify(name)}, { family: 4 }, (err, address) => done(err ? 'unresolved:' + (err.code || err.message) : 'resolved:' + address))
`
}

/** A TLS handshake to `address` presenting `serverName`: `handshake` or `closed:<reason>`. */
function tlsProbe(address, serverName, timeoutMs = 7_000) {
	return `
const tls = require('node:tls')
let settled = false
const socket = tls.connect({ host: ${JSON.stringify(address)}, port: 443, servername: ${JSON.stringify(serverName)}, rejectUnauthorized: false })
const done = (result) => {
  if (settled) return
  settled = true
  process.stdout.write('namzu-probe:' + result + '\\n')
  socket.destroy()
  process.exit(0)
}
socket.once('secureConnect', () => done('handshake'))
socket.once('error', (err) => done('closed:' + (err.code || err.message)))
setTimeout(() => done('closed:deadline'), ${timeoutMs}).unref()
`
}

const readProbe = (stdout) => /namzu-probe:(\S+)/.exec(stdout ?? '')?.[1]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const backendConfig = {
	tier: 'microvm',
	service: 'kubernetes',
	namespace,
	access,
	sandboxTemplateName: template,
	...(warmPoolName ? { warmPoolName } : {}),
	agentPort,
	egress: {
		policy: { kind: 'no-network' },
		engine: 'cilium',
		perSandbox: {
			engine: 'cilium',
			admissionPolicyName,
			...(hostIdentity ? { hostIdentity } : {}),
			narrowing: {
				ports: [443],
				dnsNames: true,
				...(tlsServerNames ? { tlsServerNames: true } : {}),
			},
		},
	},
}

let sandbox
let ok = true

async function dial(address) {
	return readProbe((await sandbox.exec('node', ['-e', tcpProbe(address)])).stdout) ?? 'closed:no-result'
}
async function resolve(name) {
	return readProbe((await sandbox.exec('node', ['-e', dnsProbe(name)])).stdout) ?? 'unresolved:no-result'
}
async function handshake(address, serverName) {
	return (
		readProbe((await sandbox.exec('node', ['-e', tlsProbe(address, serverName)])).stdout) ??
		'closed:no-result'
	)
}

/** A positive probe is retried while the policy propagates; a negative one never is. */
async function eventually(probe, isGood) {
	const deadline = Date.now() + settleMs
	let result = await probe()
	while (!isGood(result) && Date.now() < deadline) {
		await sleep(2_000)
		result = await probe()
	}
	return result
}

function mustBeRefused(name, result, hint) {
	const refused = result.startsWith('closed:') || result.startsWith('unresolved:')
	return report(name, refused, refused ? result : `${result} — ${hint}`)
}

const NOT_ENFORCED =
	'it was reachable, so either the policy is not enforced here (the stock local kind CNI enforces none) or the grant is wider than asked'

/** Phase (a) and (c): nothing is granted. */
async function nothingIsGranted(label) {
	const name = await resolve(host)
	let passed = mustBeRefused(`${label}: ${host} does not resolve`, name, NOT_ENFORCED)
	const dialled = await dial(`${host}:443`)
	passed = mustBeRefused(`${label}: ${host}:443 does not connect`, dialled, NOT_ENFORCED) && passed
	return passed
}

async function probeFromInsideTheSandbox() {
	const control = await dial(`127.0.0.1:${agentPort}`)
	console.log(`  control probe (127.0.0.1:${agentPort}, must be open): ${control}`)
	if (!report('POSITIVE CONTROL: the probe reports a port it can reach as open', control === 'open')) {
		return false
	}
	const localName = await resolve('localhost')
	console.log(`  control probe (resolve localhost, must resolve): ${localName}`)
	if (
		!report(
			'POSITIVE CONTROL: the resolver probe resolves a name needing no resolver',
			localName.startsWith('resolved:'),
		)
	) {
		return false
	}

	// (a)
	let passed = await nothingIsGranted('(a) before the grant')

	// The grant itself runs the shipped code: the fence is verified by content,
	// the written object is read back, and the union of the policies selecting
	// this pod is checked. A refusal prints in full and ends the run.
	const granted = [host, ...(cnameHost ? [cnameHost] : [])]
	try {
		await sandbox.setNetworkPolicy({ allowedHosts: granted })
		report(`setNetworkPolicy([${granted.join(', ')}]) is admitted, read back and union-verified`, true)
	} catch (err) {
		report(
			`setNetworkPolicy([${granted.join(', ')}]) is admitted, read back and union-verified`,
			false,
			err instanceof Error ? err.message : String(err),
		)
		return false
	}

	// (b) positives, with a settle window for the data plane to program.
	const resolved = await eventually(
		() => resolve(host),
		(r) => r.startsWith('resolved:'),
	)
	passed = report(`(b) ${host} resolves after the grant`, resolved.startsWith('resolved:'), resolved) && passed
	const connected = await eventually(
		() => dial(`${host}:443`),
		(r) => r === 'open',
	)
	passed = report(`(b) ${host}:443 connects after the grant`, connected === 'open', connected) && passed

	// (b) negatives.
	passed =
		mustBeRefused(
			`(b) ${host}:${otherPort} is refused (same host, another port)`,
			await dial(`${host}:${otherPort}`),
			NOT_ENFORCED,
		) && passed
	passed =
		mustBeRefused(
			`(b) ${deniedName} does not resolve (not granted)`,
			await resolve(deniedName),
			NOT_ENFORCED,
		) && passed
	passed =
		mustBeRefused(
			`(b) the fixed address ${fixedIp} is not reachable`,
			await dial(fixedIp),
			NOT_ENFORCED,
		) && passed

	if (cnameHost) {
		const viaCname = await eventually(
			() => dial(`${cnameHost}:443`),
			(r) => r === 'open',
		)
		passed =
			report(
				`(b) ${cnameHost}, which resolves through a CNAME chain, is admitted`,
				viaCname === 'open',
				viaCname,
			) && passed
	} else {
		console.log('  NOT PROBED: a host that resolves through a CNAME chain — pass --cname-host')
	}

	// (d)
	if (tlsServerNames) {
		const address = resolved.startsWith('resolved:') ? resolved.slice('resolved:'.length) : undefined
		if (address === undefined) {
			passed = report('(d) SNI: the allowed address could not be resolved to probe', false) && passed
		} else {
			const proper = await eventually(
				() => handshake(address, host),
				(r) => r === 'handshake',
			)
			const positive = report(
				`(d) a TLS handshake to ${address} presenting ${host} completes`,
				proper === 'handshake',
				proper,
			)
			passed = positive && passed
			if (positive) {
				passed =
					mustBeRefused(
						`(d) a TLS handshake to ${address} presenting ${sniDecoy} is refused`,
						await handshake(address, sniDecoy),
						'the server name is NOT enforced on this distribution even though narrowing.tlsServerNames is set',
					) && passed
			}
		}
	} else {
		console.log(
			'  [UNENFORCED] SNI: narrowing.tlsServerNames is not configured by this run, so a different server name presented to an allowed address is NOT refused by anything this script checked. This is a statement about this run, not a pass: pass --tls-server-names to probe it.',
		)
	}

	// (c)
	try {
		await sandbox.setNetworkPolicy({ allowedHosts: [] })
		report('setNetworkPolicy([]) is admitted', true)
	} catch (err) {
		report('setNetworkPolicy([]) is admitted', false, err instanceof Error ? err.message : String(err))
		return false
	}
	// The negative must hold once the removal has propagated; wait for the
	// name to stop resolving, then assert it once.
	await eventually(
		() => resolve(host),
		(r) => r.startsWith('unresolved:'),
	)
	passed = (await nothingIsGranted('(c) after setNetworkPolicy([])')) && passed
	return passed
}

try {
	try {
		sandbox = await createSandboxProvider({ backend: backendConfig }).create()
		report('the backend admits this namespace: baseline verified, per-sandbox egress configured', true)
	} catch (err) {
		report(
			'the backend admits this namespace: baseline verified, per-sandbox egress configured',
			false,
			err instanceof Error ? err.message : String(err),
		)
		ok = false
	}
	if (ok) ok = await probeFromInsideTheSandbox()
} catch (err) {
	report('the check ran to completion', false, err instanceof Error ? (err.stack ?? err.message) : String(err))
	ok = false
} finally {
	await sandbox?.destroy().catch(() => {})
}

console.log(
	ok ? 'per-sandbox-egress-check: all checks passed' : 'per-sandbox-egress-check: at least one check FAILED',
)
process.exitCode = ok ? 0 : 1
