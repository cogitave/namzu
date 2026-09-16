#!/usr/bin/env node
/**
 * Does this cluster actually close the guest agent's port to everything but
 * the host — and does this backend agree.
 *
 * Two different questions, and this script answers them in that order because
 * only the second one needs a cluster that ENFORCES anything:
 *
 *  1. **The shipped check admits this cluster.** Creating a workspace runs
 *     `src/backends/kubernetes/ingress-policy.ts` against the policies this
 *     namespace actually holds. A refusal prints the whole finding — every
 *     policy examined, the pod's labels, the port — and this script stops
 *     there, because there is nothing to probe on a deployment the backend
 *     will not build on.
 *  2. **The port really is shut from a pod that is not the host.** The probe
 *     runs INSIDE a second sandbox — a pod outside whatever selector the
 *     ingress rule names — and dials the first sandbox's agent port. It
 *     passes only if that connection fails.
 *
 * ## The positive control, and what it is for
 *
 * A probe that reports "closed" because it is broken looks exactly like a
 * probe that reports "closed" because the policy works. So before the real
 * probe runs, the SAME probe program dials a port that must be open — the
 * probe pod's own agent, on its own loopback — and this script FAILS as an
 * ENVIRONMENT failure if that comes back closed. Only a run whose control
 * says `open` is allowed to report the real probe's `closed` as a pass.
 *
 * ## What a green run does NOT prove
 *
 * A cluster whose CNI does not implement `NetworkPolicy` at all — the stock
 * local `kind` cluster is one — accepts every policy object and enforces
 * none of them. On such a cluster the real probe connects and this script
 * reports FAIL, which is the point: a non-enforcing environment must fail
 * loudly rather than pass for the wrong reason. Never read a pass here off
 * anything but a cluster whose CNI enforces policy.
 *
 * A failing probe also cannot, by itself, say WHICH of the two rules stopped
 * it: the probe pod's own egress policy and the target pod's ingress policy
 * are both in the path, and the shipped manifests set both. Both are the
 * boundary, so the acceptance criterion ("the connection fails") is answered
 * either way — but an operator attributing the block to one of them has to
 * say which policy they removed to find out.
 *
 * Runs against the BUILT package (`pnpm -r build` first — see ../README.md).
 *
 * `--workspace-id` names a workspace this script CREATES and then DELETES,
 * its disk with it, however the run ends. Never point it at a workspace whose
 * files somebody wants.
 *
 * Usage:
 *   node ingress-check.mjs --namespace namzu-sandboxes \
 *     --template namzu-workspace --task-template namzu-task \
 *     [--workspace-id ingress-probe] [--pool namzu-task-pool] \
 *     [--agent-port 1024] [--in-cluster | --server URL --token TOKEN]
 */

import { createKubernetesWorkspace, createSandboxProvider, deleteKubernetesWorkspace } from '@namzu/sandbox'
import { getResource, parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const workspaceTemplate = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const taskTemplate = flags['task-template'] ?? process.env.NAMZU_K8S_TASK_TEMPLATE ?? workspaceTemplate
const warmPoolName = flags.pool ?? process.env.NAMZU_K8S_POOL
const workspaceId = String(flags['workspace-id'] ?? 'ingress-probe')
const agentPort = Number(flags['agent-port'] ?? process.env.NAMZU_K8S_AGENT_PORT ?? 1024)
const access = resolveAccess(flags)

/**
 * The probe, as a program the guest runs. Written out here rather than
 * shipped as a file because the image carries no copy of it, and `exec` is
 * the only way into the pod this backend has.
 *
 * It reports exactly three outcomes and never throws: `open` (a completed TCP
 * handshake), `closed:<reason>` (refused, unreachable, or nothing answered
 * inside the deadline), and nothing else. A blocked SYN normally shows up as
 * the timeout rather than a refusal — a policy drops the packet, it does not
 * answer it — which is why the deadline is part of the result rather than a
 * failure of the run.
 */
function probeProgram(host, port, timeoutMs = 5_000) {
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

function readProbe(stdout) {
	const match = /namzu-probe:(\S+)/.exec(stdout ?? '')
	return match?.[1]
}

const backendConfig = {
	tier: 'microvm',
	service: 'kubernetes',
	namespace,
	access,
	sandboxTemplateName: taskTemplate,
	...(warmPoolName ? { warmPoolName } : {}),
	agentPort,
}

let ok = true
let workspace
let probePod

/**
 * Steps 2-5, in a function rather than inline, so that a step which cannot
 * continue RETURNS rather than exits. `process.exit()` skips the cleanup at
 * the foot of this file, and nothing in the cluster reaps what this script
 * abandons — a workspace Sandbox carries no shutdown time — so an exit taken
 * after step 1 would leave a Sandbox and its disk standing in the namespace
 * for somebody to find by hand. The control failing is a DESIGNED outcome
 * here, not an exotic one, so that path has to clean up like any other. This
 * file calls `process.exit` nowhere, for the same reason.
 */
async function probeTheAgentPortFromAnotherPod() {
	// 2. Where that workspace's pod answers. Read from the API server rather
	//    than from the handle: the handle dials a Service FQDN, and what the
	//    probe needs is the pod address a policy is written about.
	const sandboxName = `namzu-ws-${workspaceId}`
	const sandbox = await getResource(
		access,
		`/apis/agents.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/sandboxes/${encodeURIComponent(sandboxName)}`,
	)
	const targetIp = sandbox?.status?.podIPs?.[0]
	if (!targetIp) {
		return report('the workspace reports a pod address to probe', false, `${sandboxName} has no status.podIPs`)
	}
	report('the workspace reports a pod address to probe', true, `${targetIp}:${agentPort}`)

	// 3. A second sandbox: a pod that is not the host, which is the vantage
	//    point the acceptance criterion names.
	probePod = await createSandboxProvider({ backend: backendConfig }).create()

	// 4. POSITIVE CONTROL. The same program, against a port that must be
	//    open: the probe pod's own agent, on its own loopback, which no
	//    NetworkPolicy governs. A control that comes back closed means the
	//    probe cannot tell open from closed, so nothing after it is evidence.
	const control = await probePod.exec('node', ['-e', probeProgram('127.0.0.1', agentPort)])
	const controlResult = readProbe(control.stdout)
	console.log(`  control probe (127.0.0.1:${agentPort}, must be open): ${controlResult ?? '(no result)'}`)
	if (controlResult !== 'open') {
		return report(
			'POSITIVE CONTROL: the probe reports a port it can reach as open',
			false,
			'the probe apparatus is broken or the guest has no usable node — the ingress result below would be meaningless, so this run proves nothing',
		)
	}
	report('POSITIVE CONTROL: the probe reports a port it can reach as open', true)

	// 5. The real probe.
	const probe = await probePod.exec('node', ['-e', probeProgram(targetIp, agentPort)])
	const result = readProbe(probe.stdout)
	console.log(`  ingress probe (${targetIp}:${agentPort}, must be closed): ${result ?? '(no result)'}`)
	return report(
		'a pod outside the host selector CANNOT reach the agent port',
		typeof result === 'string' && result.startsWith('closed:'),
		result === 'open'
			? 'the connection succeeded: either no policy closes this port, or this cluster accepts NetworkPolicy objects without enforcing them (the stock local kind CNI does exactly that)'
			: (result ?? 'the probe produced no result'),
	)
}

/**
 * What a failed `createKubernetesWorkspace` may have left standing, removed.
 *
 * The refusal this script exists to surface is decided BEFORE the POST, so on
 * that path there is nothing in the cluster and this sends one DELETE for a
 * name that does not exist, which the verb treats as already deleted. Every
 * other way that call can fail is different: a readiness timeout, a privilege
 * probe refusal or an adopt mismatch SUSPENDS the Sandbox and rethrows —
 * deliberately, because inside the backend `deleteDisk` is not a decision a
 * failure path gets to make (`src/backends/kubernetes/workspace.ts` says so at
 * length) — and nothing in the cluster reaps what that leaves: a Sandbox under
 * `namzu-ws-<workspace-id>` and, on the workspace template, its block PVC.
 *
 * From HERE that decision is safe to make, and only here: `--workspace-id`
 * names this script's own probe target, and the success path destroys the same
 * object with `deleteDisk: true` a few lines below. The DELETE is by name; it
 * starts no pod and resumes nothing.
 *
 * Best effort, and it prints what it did either way — when the DELETE is the
 * thing that failed, the operator is the one who has to clear the namespace.
 */
async function removeWhateverTheFailedCreateLeftBehind() {
	const sandboxName = `namzu-ws-${workspaceId}`
	try {
		await deleteKubernetesWorkspace({ ...backendConfig, sandboxTemplateName: workspaceTemplate }, workspaceId)
		console.log(`  cleanup: sent one DELETE for ${sandboxName} — a create can fail after POSTing it`)
	} catch (err) {
		console.log(
			`  cleanup: the DELETE for ${sandboxName} FAILED (${err instanceof Error ? err.message : String(err)}) — if the create got as far as POSTing it, that Sandbox and its disk are still standing in ${namespace}`,
		)
	}
}

try {
	// 1. The shipped check, run by the shipped code. A refusal here is the
	//    finding, printed in full.
	try {
		workspace = await createKubernetesWorkspace(
			{ ...backendConfig, sandboxTemplateName: workspaceTemplate },
			{ workspaceId, workingDirectory: '/workspace' },
		)
		report('the backend admits this namespace: an applied policy closes the agent port', true)
	} catch (err) {
		report(
			'the backend admits this namespace: an applied policy closes the agent port',
			false,
			err instanceof Error ? err.message : String(err),
		)
		ok = false
		await removeWhateverTheFailedCreateLeftBehind()
	}

	if (ok) ok = await probeTheAgentPortFromAnotherPod()
} catch (err) {
	// Without this the script's two summary lines never print: a throw from
	// the probe half — its own create, an exec, the address it dials — would
	// run the cleanup below and then leave the module, exiting non-zero with
	// nothing said about why. A check that could not be RUN is a FAIL with a
	// reason, like every other row here.
	report(
		'the check ran to completion',
		false,
		err instanceof Error ? (err.stack ?? err.message) : String(err),
	)
	ok = false
} finally {
	await probePod?.destroy().catch(() => {})
	// The workspace this script created, and its disk, are this script's to
	// remove: it is a probe target, not a caller's work.
	await workspace?.destroy({ deleteDisk: true }).catch(() => {})
}

console.log(ok ? 'ingress-check: all checks passed' : 'ingress-check: at least one check FAILED')
process.exitCode = ok ? 0 : 1
