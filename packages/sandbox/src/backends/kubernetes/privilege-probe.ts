/**
 * Acquire-time privilege probe: prove the guest process really was
 * deprivileged, rather than assume the entrypoint did its job.
 *
 * The image's entrypoint mounts the workspace as root and then
 * `exec setpriv --reuid --regid --clear-groups --inh-caps=-all
 * --bounding-set=-all --no-new-privs -- node agent.cjs`. Nothing in
 * `agent.cjs` knows about any of that, and nothing on the host can see it
 * either — an image built from an older entrypoint, a `RuntimeClass` change,
 * a hand-edited `SandboxTemplate` all produce a sandbox that works perfectly
 * and is not deprivileged. So the backend asks the guest, once, before it
 * hands a caller a handle.
 *
 * ## Why `execute`, and why not `read-file`
 *
 * The guest's `read-file` resolves every path against `READ_ROOTS`
 * (`WORKSPACE_ROOT` only), so it cannot reach `/proc` at all, and widening
 * `READ_ROOTS` to make the probe work would hand every caller of `readFile`
 * a window into the guest's process tree for the sake of one diagnostic.
 * `handleExecute` jails only `cwd`, so a command whose ARGUMENT is an
 * absolute path outside the workspace runs fine. The probe therefore spends
 * one `exec` and touches no jail.
 *
 * ## Why all four masks
 *
 * Checking `CapEff` alone is a true-looking answer: an ordinary unprivileged
 * process shows `CapEff: 0000000000000000` whether or not its bounding set
 * was ever dropped, so a container running as uid 0 with the full bounding
 * set still passes. `CapBnd` is the one that says a capability can never be
 * regained; `CapInh` and `CapPrm` close the two ways one could be carried
 * across an exec. `NoNewPrivs: 1` is what makes a setuid binary inside the
 * guest unable to raise any of it back.
 *
 * ## Why every failure is a refusal
 *
 * A probe that could not run, one that never answered at all, output that
 * could not be parsed and a process that is genuinely privileged are all
 * reasons NOT to hand back a handle, and they are separated only in the error
 * TEXT — a distroless image with no `cat` on `PATH` must be diagnosable as
 * exactly that rather than read as a hardening failure. There is no
 * configuration that turns this off.
 *
 * ## The clock is the caller's, and it lives in `index.ts`
 *
 * Nothing here has a timeout: the probe is one `exec`, and the budget it may
 * spend belongs to the `create()` that ordered it. `admitProbedSandbox` runs
 * it under an `OperationDeadline` and turns an expiry into
 * {@link privilegeProbeTimedOut}, so a guest that accepts the connection and
 * then goes quiet is refused on the caller's clock rather than on the
 * execution controller's five-minute generic default.
 */

import type { SandboxExecResult } from '@namzu/sdk'

/**
 * The probe command. `cat` rather than an absolute `/bin/cat` so a guest
 * that keeps its coreutils somewhere else still answers, and rather than a
 * shell so there is no quoting to get wrong. A guest without it fails with
 * a spawn error the refusal repeats verbatim.
 */
export const PRIVILEGE_PROBE_COMMAND = 'cat'

/** `/proc/self/status` — of the process the guest agent spawns, which
 * inherits exactly the agent's own credentials and capability masks. */
export const PRIVILEGE_PROBE_ARGS: readonly string[] = ['/proc/self/status']

/** Why a probe refused. The text says the same thing in words. */
export type PrivilegeProbeFailure =
	/** The `exec` failed, exited non-zero, or never answered at all. */
	| 'probe-failed'
	/** It ran, but its output is not a readable `/proc/<pid>/status`. */
	| 'unreadable-output'
	/** It ran, it parsed, and the process has capabilities it should not. */
	| 'privileged'

/**
 * Raised by {@link runPrivilegeProbe} and {@link parseProcStatus}. The
 * `reason` is the machine-readable form of the distinction the message
 * draws in prose: `'privileged'` means the guest is under-hardened, and the
 * other two mean the backend could not tell.
 */
export class KubernetesPrivilegeProbeError extends Error {
	override readonly name = 'KubernetesPrivilegeProbeError'

	constructor(
		readonly reason: PrivilegeProbeFailure,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

/**
 * The five fields the probe reads, parsed. The four capability masks are
 * `bigint` because a capability mask is 64 bits wide and `Number` stops
 * being exact at 53 — `000001ffffffffff` is only 41 bits today, but a mask
 * that silently rounds is precisely the bug this whole module exists to
 * catch.
 */
export interface ProcStatusPrivileges {
	readonly capInh: bigint
	readonly capPrm: bigint
	readonly capEff: bigint
	readonly capBnd: bigint
	/** `prctl(PR_GET_NO_NEW_PRIVS)`, 0 or 1 as the kernel prints it. */
	readonly noNewPrivs: number
}

const CAPABILITY_FIELDS = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd'] as const
const NO_NEW_PRIVS_FIELD = 'NoNewPrivs'

/** Clip a value before it goes into an error message. */
function clip(value: string): string {
	return value.length > 40 ? `${value.slice(0, 40)}…` : value
}

function readField(text: string, field: string): string {
	for (const rawLine of text.split(/\r?\n/)) {
		const colon = rawLine.indexOf(':')
		if (colon < 0) continue
		if (rawLine.slice(0, colon).trim() !== field) continue
		return rawLine.slice(colon + 1).trim()
	}
	throw new KubernetesPrivilegeProbeError(
		'unreadable-output',
		`the privilege probe ran but its output carries no ${field} line, so this sandbox's privileges could not be read. The probe is \`${PRIVILEGE_PROBE_COMMAND} ${PRIVILEGE_PROBE_ARGS.join(' ')}\` — a guest whose /proc is not mounted, or whose kernel does not publish ${field}, cannot be admitted, because an unreadable answer is not a safe one.`,
	)
}

/**
 * Parse `/proc/<pid>/status` into the five fields that decide admission.
 *
 * Pure: no transport, no clock, no I/O. Everything it cannot read is a
 * throw, never a default — a zero substituted for a missing mask is the one
 * mistake that would make this function report hardening that is not there.
 */
export function parseProcStatus(text: string): ProcStatusPrivileges {
	const masks = CAPABILITY_FIELDS.map((field) => {
		const raw = readField(text, field)
		// The kernel prints a bare, fixed-width hex mask with no `0x`. A
		// `0x` prefix, a sign, whitespace inside, or anything non-hex means
		// this is not the file this parser thinks it is.
		if (!/^[0-9a-fA-F]+$/.test(raw)) {
			throw new KubernetesPrivilegeProbeError(
				'unreadable-output',
				`the privilege probe ran but ${field} is ${JSON.stringify(clip(raw))}, which is not the bare hexadecimal capability mask /proc/<pid>/status publishes, so this sandbox's privileges could not be read.`,
			)
		}
		return BigInt(`0x${raw}`)
	})

	const noNewPrivsRaw = readField(text, NO_NEW_PRIVS_FIELD)
	if (!/^\d+$/.test(noNewPrivsRaw)) {
		throw new KubernetesPrivilegeProbeError(
			'unreadable-output',
			`the privilege probe ran but ${NO_NEW_PRIVS_FIELD} is ${JSON.stringify(clip(noNewPrivsRaw))}, which is not the integer /proc/<pid>/status publishes, so this sandbox's privileges could not be read.`,
		)
	}

	return {
		capInh: masks[0] as bigint,
		capPrm: masks[1] as bigint,
		capEff: masks[2] as bigint,
		capBnd: masks[3] as bigint,
		noNewPrivs: Number(noNewPrivsRaw),
	}
}

/**
 * Admit only an all-zero capability set with `no_new_privs` set. Every
 * non-zero mask is named in the refusal, because "one of them is set" sends
 * the reader back to the guest to find out which.
 */
export function assertDeprivileged(privileges: ProcStatusPrivileges, sandboxName: string): void {
	const offenders: string[] = []
	if (privileges.capInh !== 0n) offenders.push(`CapInh=${privileges.capInh.toString(16)}`)
	if (privileges.capPrm !== 0n) offenders.push(`CapPrm=${privileges.capPrm.toString(16)}`)
	if (privileges.capEff !== 0n) offenders.push(`CapEff=${privileges.capEff.toString(16)}`)
	if (privileges.capBnd !== 0n) offenders.push(`CapBnd=${privileges.capBnd.toString(16)}`)
	if (privileges.noNewPrivs !== 1) offenders.push(`NoNewPrivs=${privileges.noNewPrivs}`)
	if (offenders.length === 0) return

	throw new KubernetesPrivilegeProbeError(
		'privileged',
		`kubernetes sandbox ${sandboxName} is PRIVILEGED and was refused: ${offenders.join(
			', ',
		)} (every capability mask must be 0 and NoNewPrivs must be 1). The probe ran and was read successfully — this is the guest's real state, not a diagnostic failure. The image's entrypoint is expected to end with \`exec setpriv --reuid --regid --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- node agent.cjs\`; a sandbox that reaches this message is running with capabilities the workload could use.`,
	)
}

/**
 * Run the probe over an already-built sandbox's `exec` and admit or refuse.
 *
 * `run` is the sandbox's own `exec`, not the raw transport, so the probe
 * traverses exactly the path every later call will: reserve, admit, stream,
 * confirm. A probe that cannot get through this is a sandbox a caller
 * cannot use either.
 */
export async function runPrivilegeProbe(
	run: (command: string, args: string[]) => Promise<SandboxExecResult>,
	sandboxName: string,
): Promise<ProcStatusPrivileges> {
	let result: SandboxExecResult
	try {
		result = await run(PRIVILEGE_PROBE_COMMAND, [...PRIVILEGE_PROBE_ARGS])
	} catch (error) {
		throw new KubernetesPrivilegeProbeError(
			'probe-failed',
			`the privilege probe could not run in kubernetes sandbox ${sandboxName}: ${
				error instanceof Error ? error.message : String(error)
			}. The probe is \`${PRIVILEGE_PROBE_COMMAND} ${PRIVILEGE_PROBE_ARGS.join(
				' ',
			)}\`; an image without it on PATH cannot be admitted, because a sandbox whose privileges cannot be checked is refused rather than trusted.`,
			{ cause: error },
		)
	}
	if (result.exitCode !== 0) {
		throw new KubernetesPrivilegeProbeError(
			'probe-failed',
			`the privilege probe could not run in kubernetes sandbox ${sandboxName}: \`${PRIVILEGE_PROBE_COMMAND} ${PRIVILEGE_PROBE_ARGS.join(
				' ',
			)}\` exited ${result.exitCode}${
				result.stderr.trim() ? ` (${clip(result.stderr.trim())})` : ''
			}. This is a diagnostic failure, not a privilege failure — the sandbox is refused because its state is unknown.`,
		)
	}

	const privileges = parseProcStatus(result.stdout)
	assertDeprivileged(privileges, sandboxName)
	return privileges
}

/**
 * The refusal for a probe that never answered.
 *
 * A guest that accepts the TCP connection and then goes quiet — an agent
 * process out of memory, an event loop blocked by the workload, a container
 * alive with a listener that has stopped reading — cannot be told apart from
 * a healthy one by the wire alone, so the caller's acquire budget is the only
 * thing that ends the wait. That expiry is a `'probe-failed'` like any other
 * way the probe could not run, but it gets its own words: "the deadline
 * expired" on its own says nothing about WHICH half of the acquire stopped
 * answering, and a reader who sees `cat` blamed for a hang goes looking for a
 * missing binary that is not missing.
 */
export function privilegeProbeTimedOut(
	sandboxName: string,
	timeoutMs: number,
	cause: unknown,
): KubernetesPrivilegeProbeError {
	return new KubernetesPrivilegeProbeError(
		'probe-failed',
		`the privilege probe could not run in kubernetes sandbox ${sandboxName}: the guest accepted the connection and did not answer \`${PRIVILEGE_PROBE_COMMAND} ${PRIVILEGE_PROBE_ARGS.join(
			' ',
		)}\` within ${timeoutMs} ms, so the probe was abandoned. This is a diagnostic failure, not a privilege failure — the sandbox is refused because its state is unknown. A wedged agent (out of memory, an event loop blocked by the workload) looks exactly like this from the host; check the pod's logs before raising the acquire budget.`,
		{ cause },
	)
}
