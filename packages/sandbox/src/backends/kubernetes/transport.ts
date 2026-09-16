/**
 * Host-side transport for the kubernetes backend's guest agent: the same
 * `agent/agent.cjs` the Firecracker tier bakes into its golden image,
 * reached over the pod network instead of a host-local vsock/unix socket.
 *
 * Every byte on the wire goes through {@link VsockAgentTransport}
 * constructed with a `{ kind: 'tcp' }` handle (`../firecracker/transport.js`):
 * the SAME per-call dial (fresh connection, no cached socket, no cached
 * IP — a Service-FQDN host re-resolves on every call, so a resumed pod's
 * new address costs nothing extra), the SAME 8-hex-length framing, and
 * the SAME token-in-envelope credential. Nothing about the wire is
 * reimplemented here.
 *
 * This module supplies its OWN {@link RemoteExecutionAdapter} to the
 * shared {@link RemoteExecutionController} — a third adapter against the
 * same controller, alongside `http-worker-client.ts` and
 * `firecracker/transport.ts`, each of which does this independently — so
 * it can report where an `exec()` call's wall time actually goes: the
 * dial(s), the reserve round trip, the execute round trip, and the small
 * amount of local bookkeeping after the peer's own work is done
 * ("drain"). That attribution is the whole point of `onTiming`: the
 * Firecracker relay path has a known, unexplained fixed cost, and the
 * sub-second warm-acquire target this backend is judged against must be
 * measured, not guessed at.
 */

import type {
	OpenTerminalOptions,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxTcpConnectOptions,
	SandboxTcpConnection,
	TerminalSession,
} from '@namzu/sdk'

import type { ExecRequest } from '../firecracker/protocol.js'
import {
	type AgentRequest,
	type SandboxAgentHandle,
	VsockAgentTransport,
	type VsockTransportOptions,
} from '../firecracker/transport.js'
import {
	type RemoteExecutionAdapter,
	RemoteExecutionController,
} from '../remote-execution-controller.js'

/** The one {@link SandboxAgentHandle} arm this backend ever constructs. */
export type KubernetesAgentHandle = Extract<SandboxAgentHandle, { kind: 'tcp' }>

/**
 * Thrown when the guest agent refuses a request because the handle's
 * token does not match what the pod is bound to. Named distinctly from
 * {@link RemoteProtocolError} so a caller can tell "this credential is
 * wrong" (never going to succeed by retrying) from "the wire shape was
 * unexpected".
 */
export class KubernetesAgentUnauthorizedError extends Error {
	constructor(
		message = 'kubernetes tcp transport: the guest agent rejected this connection’s token (unauthorized)',
	) {
		super(message)
		this.name = 'KubernetesAgentUnauthorizedError'
	}
}

/** True for the wire shape `agent.cjs` sends when a token is rejected. */
function isUnauthorized(response: unknown): boolean {
	if (!response || typeof response !== 'object') return false
	const value = response as { ok?: unknown; error?: unknown }
	return value.ok === false && value.error === 'unauthorized'
}

/**
 * One framed control request, with the guest's `unauthorized` refusal
 * turned into {@link KubernetesAgentUnauthorizedError}.
 *
 * BOTH control requests go through here — `reserve-execution` and
 * `cancel-execution` — because the two are read by the same caller for
 * opposite reasons and neither may mistake a refusal for a blip. The
 * cancel path is the sharper of the two: {@link RemoteExecutionController}
 * RETRIES a failed cancellation for its whole confirm window and then
 * reports the cancellation UNCONFIRMED, which retires the sandbox. A
 * rejected token read as a transport failure would therefore spend that
 * window re-sending a request that can never succeed, and end by
 * describing a wrong credential as an ambiguous outcome.
 */
async function requestChecked(
	wire: VsockAgentTransport,
	request: AgentRequest,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await wire.request(request, signal)
	if (isUnauthorized(response)) throw new KubernetesAgentUnauthorizedError()
	return response
}

/**
 * One `exec()` call's wall-time breakdown. Durations are NOT a partition
 * of a single total — `reserveMs` and `executeMs` each include their OWN
 * dial, which is also folded into `dialMs` — this is a diagnostic
 * breakdown for attribution, not an accounting identity. Never carries a
 * token, a command, its arguments, or any output.
 */
export interface KubernetesTransportTiming {
	/** Total time spent establishing TCP connections for this call. */
	readonly dialMs: number
	/** Time spent on the `reserve-execution` round trip (dial included). */
	readonly reserveMs: number
	/** Time spent on the `execute` round trip (dial included). */
	readonly executeMs: number
	/**
	 * Time between the execute round trip settling and `exec()` itself
	 * resolving — the shared controller's own post-execute bookkeeping
	 * (clearing timers, tearing down the observation race). Always small
	 * on the happy path; distinct from `executeMs` because it is spent
	 * locally, after the peer has nothing left to do.
	 */
	readonly drainMs: number
}

export interface KubernetesTransportOptions extends VsockTransportOptions {
	/**
	 * Fires once per completed `exec()` call (success or failure) with
	 * the four phase durations above. The payload is exactly those four
	 * numbers — never the token, never a command, argv, or output.
	 */
	readonly onTiming?: (timing: KubernetesTransportTiming) => void
}

/**
 * The kubernetes backend's dialable transport: a `tcp` handle plus a
 * `RemoteExecutionAdapter` built from it, so `exec()` gets the same
 * reserve-before-admission behaviour (cancellation, timeout ownership,
 * "do not infer complete output on an ambiguous cancel") every other
 * remote backend gets, while every network operation is delegated to
 * {@link VsockAgentTransport} for the actual dial/frame/token work.
 */
export class KubernetesAgentTransport {
	private readonly handle: KubernetesAgentHandle
	private readonly transportOptions: VsockTransportOptions
	private readonly onTiming?: (timing: KubernetesTransportTiming) => void
	/** Simple pass-through operations share one transport instance. */
	private readonly wire: VsockAgentTransport

	constructor(handle: KubernetesAgentHandle, options: KubernetesTransportOptions = {}) {
		const { onTiming, ...transportOptions } = options
		this.handle = handle
		this.transportOptions = transportOptions
		this.onTiming = onTiming
		this.wire = new VsockAgentTransport(handle, transportOptions)
	}

	/** Readiness probe — never requires a token; see `protocol.ts`. */
	async healthz(signal?: AbortSignal): Promise<boolean> {
		return await this.wire.healthz(signal)
	}

	/** Poll until `healthz` succeeds or the timeout elapses. */
	async waitForReady(
		timeoutMs: number,
		pollIntervalMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		return await this.wire.waitForReady(timeoutMs, pollIntervalMs, signal)
	}

	/**
	 * The raw `reserve-execution` primitive, exposed directly (rather than
	 * only reachable as a side effect of `exec()`) so the reservation
	 * round trip is independently observable and testable against the
	 * real guest.
	 */
	async reserve(signal?: AbortSignal): Promise<unknown> {
		return await requestChecked(this.wire, { op: 'reserve-execution' }, signal)
	}

	/**
	 * The raw `cancel-execution` primitive, exposed for the same reason
	 * {@link reserve} is: it is a control request with its own refusal
	 * semantics, and proving those against the real guest should not require
	 * driving a whole cancelled `exec()` to reach it.
	 */
	async cancel(executionId: string, signal?: AbortSignal): Promise<unknown> {
		return await requestChecked(
			this.wire,
			{ op: 'cancel-execution', body: { executionId } },
			signal,
		)
	}

	async writeFile(path: string, content: Buffer): Promise<void> {
		return await this.wire.writeFile(path, content)
	}

	async readFile(path: string): Promise<Buffer> {
		return await this.wire.readFile(path)
	}

	async openTerminal(options: OpenTerminalOptions): Promise<TerminalSession> {
		return await this.wire.openTerminal(options)
	}

	async openTcpConnection(options: SandboxTcpConnectOptions): Promise<SandboxTcpConnection> {
		return await this.wire.openTcpConnection(options)
	}

	/**
	 * Run one command through a fresh, call-scoped adapter + controller.
	 * Fresh per call — not shared instance state — because
	 * {@link VsockAgentTransport} itself carries no cross-call connection
	 * state (it dials fresh every time), so building one per `exec()` is
	 * free and makes concurrent `exec()` calls on the same
	 * `KubernetesAgentTransport` correctly independent: each gets its own
	 * `onDial` closure and its own timing accumulator, with no shared
	 * mutable field for two in-flight calls to race on.
	 */
	async exec(
		command: string,
		argv?: string[],
		opts?: SandboxExecOptions,
	): Promise<SandboxExecResult> {
		let dialMs = 0
		let reserveMs = 0
		let executeMs = 0
		let executeSettledAt = 0

		const timedWire = new VsockAgentTransport(this.handle, {
			...this.transportOptions,
			onDial: (ms) => {
				dialMs += ms
			},
		})

		const adapter: RemoteExecutionAdapter<Pick<ExecRequest, 'stdin' | 'maxOutputBytes'>> = {
			label: 'kubernetes pod-network agent',
			reserve: async (signal) => {
				const startedAt = Date.now()
				try {
					return await requestChecked(timedWire, { op: 'reserve-execution' }, signal)
				} finally {
					reserveMs += Date.now() - startedAt
				}
			},
			// Checked exactly like `reserve` — see `requestChecked`.
			cancel: async (executionId, signal) =>
				await requestChecked(timedWire, { op: 'cancel-execution', body: { executionId } }, signal),
			execute: async (executionId, cmd, execArgv, execOpts, signal, context) => {
				const startedAt = Date.now()
				try {
					return await timedWire.executeStreamed(
						{
							...(executionId ? { executionId } : {}),
							command: cmd,
							args: execArgv ?? [],
							...(execOpts?.cwd !== undefined ? { cwd: execOpts.cwd } : {}),
							...(execOpts?.env !== undefined ? { env: execOpts.env } : {}),
							...(execOpts?.timeout !== undefined ? { timeoutMs: execOpts.timeout } : {}),
							...(context?.stdin !== undefined ? { stdin: context.stdin } : {}),
							...(context?.maxOutputBytes !== undefined
								? { maxOutputBytes: context.maxOutputBytes }
								: {}),
						},
						execOpts,
						signal,
					)
				} finally {
					executeMs += Date.now() - startedAt
					executeSettledAt = Date.now()
				}
			},
		}

		const controller = new RemoteExecutionController(adapter)
		try {
			return await controller.exec(command, argv, opts)
		} finally {
			this.onTiming?.({
				dialMs,
				reserveMs,
				executeMs,
				drainMs: executeSettledAt > 0 ? Date.now() - executeSettledAt : 0,
			})
		}
	}
}
