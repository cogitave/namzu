import { type SandboxExecOptions, type SandboxExecResult, withHint } from '@namzu/sdk'

import {
	RemoteCommandError,
	type RemoteExecutionAdapter,
	RemoteExecutionController,
	RemoteProtocolError,
} from './remote-execution-controller.js'

type WorkerEvent =
	| { readonly type: 'stdout_delta'; readonly data: string }
	| { readonly type: 'stderr_delta'; readonly data: string }
	| {
			readonly type: 'result'
			readonly exitCode: number
			readonly timedOut: boolean
			readonly durationMs: number
			readonly signal?: string
			readonly stdoutTruncated?: boolean
			readonly stderrTruncated?: boolean
	  }
	| { readonly type: 'error'; readonly error: string }

/**
 * What every call to a worker's control API carries, if the worker has a
 * credential at all.
 *
 * The worker (`packages/sandbox/worker/server.js`) requires
 * `Authorization: Bearer <token>` on every route but `/healthz`, where the
 * token is the per-instance `NAMZU_SANDBOX_TOKEN` it was started with. An
 * absent token here sends no header, which is exactly right for a worker
 * that has none: a loopback-bound dev worker, or a warm-pool worker whose
 * profile authenticates nothing.
 *
 * A worker the host did NOT create is the case this cannot solve by
 * itself. The token is minted by whoever starts the container and travels
 * in its environment, so a warm pool has to be provisioned with the same
 * token before a host can claim it — there is no channel back. Constructing
 * this client with no token against such a worker fails at the first call
 * with a `401`, not silently.
 */
export function workerAuthorization(token: string | undefined): Record<string, string> {
	return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * The `401` a worker answers with, and what to do about it.
 *
 * Hung on every path that can be a caller's FIRST request to a worker —
 * `reserve`, `execute`, and the container backend's direct `read-file` /
 * `write-file` — because the bare status is the one failure whose cause is
 * never visible from the sandbox the caller thinks it is talking to: the
 * container is up, the port is open, and every command fails.
 */
export const WORKER_UNAUTHORIZED_HINT =
	'The worker requires the per-instance token it was started with, as `Authorization: Bearer <token>`. If this host created the worker, the token it minted and the token the client sends have diverged. If it did not — a warm pool, a shared profile, a container someone else started — that worker must be provisioned with the token by whoever builds it: the worker has no channel back to hand one over.'

/**
 * The same failure, for the one backend that can never fix it.
 *
 * The standby pool has no way to present a token. The claim API admits
 * exactly one property override, and it is not `env`: it is a config map,
 * and a config map reaches the container as a FILE MOUNT under
 * `/mnt/configmap/<containername>/<key>`, not as an environment variable.
 * This worker reads its credential from `process.env` once at startup, so
 * a value delivered that way is not read at all — and Microsoft's own
 * guidance is that config map values are not validated by the runtime and
 * that a value affecting application security belongs in an environment
 * variable instead. The channel exists; this credential is declined for
 * it, at both ends. See `docs/sdk/container-sandbox-worker.md` for the
 * answer, the reason, and the change that would close the gap.
 *
 * A token on the shared profile would make the worker boot and then refuse
 * every call the backend makes — an unrecoverable loop that looks like a
 * broken worker. So what works there is the address first and the
 * worker-side escape second, and the hint says which of the two situations
 * the caller is in.
 *
 * `HttpWorkerClient` uses {@link WORKER_UNAUTHORIZED_HINT} rather than this
 * one: the client is shared by two backends, and a 401 it sees could be
 * either situation.
 */
export const STANDBY_POOL_UNAUTHORIZED_HINT =
	'The worker requires a per-instance token, and this backend cannot present one: the claim API admits a config map and nothing else, and a config map arrives as a file mount under /mnt/configmap, not as an environment variable this worker reads. Putting a token on the shared container group profile does NOT fix this — the worker boots, the backend sends no header, and every call 401s. What works today is the address and then the worker-side escape: claim the group with `subnetId` so it sits on a private network, and set `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` on that group profile, which is the only configuration in which a pooled worker starts and this backend can talk to it. Any other workload should run on a backend that can carry a credential. See `docs/sdk/container-sandbox-worker.md`.'

function parseWorkerEvent(line: string): WorkerEvent {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch (error) {
		throw new RemoteProtocolError(
			`worker emitted malformed NDJSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new RemoteProtocolError('worker emitted an event without an object body')
	}
	const event = parsed as Record<string, unknown>
	if (
		(event.type === 'stdout_delta' || event.type === 'stderr_delta') &&
		typeof event.data === 'string'
	) {
		return event as WorkerEvent
	}
	if (event.type === 'error' && typeof event.error === 'string') return event as WorkerEvent
	if (
		event.type === 'result' &&
		Number.isFinite(event.exitCode) &&
		typeof event.timedOut === 'boolean' &&
		Number.isFinite(event.durationMs) &&
		(event.signal === undefined || typeof event.signal === 'string') &&
		(event.stdoutTruncated === undefined || typeof event.stdoutTruncated === 'boolean') &&
		(event.stderrTruncated === undefined || typeof event.stderrTruncated === 'boolean')
	) {
		return event as WorkerEvent
	}
	throw new RemoteProtocolError(`worker emitted an invalid ${String(event.type)} event`)
}

async function readExecution(
	baseUrl: string,
	token: string | undefined,
	executionId: string | undefined,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
	transportSignal: AbortSignal,
): Promise<SandboxExecResult> {
	let response: Response
	try {
		response = await fetch(`${baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...workerAuthorization(token) },
			signal: transportSignal,
			body: JSON.stringify({
				...(executionId ? { executionId } : {}),
				command,
				args: argv ?? [],
				cwd: opts?.cwd,
				env: opts?.env,
				timeoutMs: opts?.timeout,
			}),
		})
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined
		const causeMessage =
			cause instanceof Error
				? `${cause.message}${(cause as Error & { code?: string }).code ? ` (${(cause as Error & { code?: string }).code})` : ''}`
				: cause
					? String(cause)
					: 'unknown'
		throw withHint(
			new Error(
				`namzu-sandbox /execute fetch failed (baseUrl=${baseUrl}): ${error instanceof Error ? error.message : String(error)} — cause: ${causeMessage}`,
				{ cause: error },
			),
			'The worker was reachable when the sandbox started, so it has most likely exited, been killed, or become unreachable since. Check the container logs and runtime exit state.',
		)
	}
	if (response.status === 401) {
		throw withHint(
			new Error(`execute failed: HTTP 401 ${await response.text()}`),
			WORKER_UNAUTHORIZED_HINT,
		)
	}
	if (!response.ok || !response.body) {
		throw new Error(`execute failed: HTTP ${response.status} ${await response.text()}`)
	}

	const decoder = new TextDecoder()
	const reader = response.body.getReader()
	let buffered = ''
	let stdout = ''
	let stderr = ''
	let terminal: Extract<WorkerEvent, { type: 'result' }> | undefined
	let terminalCount = 0

	const consume = (rawLine: string): void => {
		if (!rawLine.trim()) return
		const event = parseWorkerEvent(rawLine)
		if (terminalCount > 0) {
			throw new RemoteProtocolError('worker emitted data after its terminal event')
		}
		if (event.type === 'stdout_delta') {
			stdout += event.data
			opts?.onOutput?.({ stream: 'stdout', data: event.data })
			return
		}
		if (event.type === 'stderr_delta') {
			stderr += event.data
			opts?.onOutput?.({ stream: 'stderr', data: event.data })
			return
		}
		terminalCount += 1
		if (event.type === 'error') throw new RemoteCommandError(event.error)
		terminal = event
	}

	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buffered += decoder.decode(value, { stream: true })
		let newline = buffered.indexOf('\n')
		while (newline !== -1) {
			consume(buffered.slice(0, newline))
			buffered = buffered.slice(newline + 1)
			newline = buffered.indexOf('\n')
		}
	}
	buffered += decoder.decode()
	if (buffered.trim()) consume(buffered)
	if (terminalCount !== 1 || !terminal) {
		throw new RemoteProtocolError('worker response ended without exactly one result event')
	}

	return {
		exitCode: terminal.exitCode,
		stdout,
		stderr,
		...(terminal.signal ? { signal: terminal.signal } : {}),
		timedOut: terminal.timedOut,
		durationMs: terminal.durationMs,
		...(terminal.stdoutTruncated !== undefined
			? { stdoutTruncated: terminal.stdoutTruncated }
			: {}),
		...(terminal.stderrTruncated !== undefined
			? { stderrTruncated: terminal.stderrTruncated }
			: {}),
	}
}

/**
 * A per-sandbox HTTP worker client. Every command must reserve an identity
 * through the exact worker protocol before it can be admitted.
 *
 * `token` is the per-instance credential the worker was started with, and
 * it rides on every request this client makes. It is optional because a
 * worker that was never given one — a loopback dev worker — requires none;
 * say what happens when it is missing from the wrong side rather than
 * sending nothing quietly: the worker answers `401` and the failure names
 * the reason.
 */
export class HttpWorkerClient {
	private readonly controller: RemoteExecutionController

	constructor(baseUrl: string, token?: string) {
		const adapter: RemoteExecutionAdapter = {
			label: 'HTTP worker',
			reserve: async (signal) => {
				const response = await fetch(`${baseUrl}/executions/reserve`, {
					method: 'POST',
					headers: workerAuthorization(token),
					signal,
				})
				if (response.status === 404) {
					throw new RemoteProtocolError(
						'The sandbox worker does not implement the required execution protocol. Rebuild the worker image or standby-pool profile from the same Namzu release before admitting commands.',
					)
				}
				if (response.status === 401) {
					throw withHint(
						new Error(`execution reservation failed: HTTP 401 ${await response.text()}`),
						WORKER_UNAUTHORIZED_HINT,
					)
				}
				if (!response.ok) {
					throw new Error(
						`execution reservation failed: HTTP ${response.status} ${await response.text()}`,
					)
				}
				return await response.json()
			},
			cancel: async (executionId, signal) => {
				const response = await fetch(`${baseUrl}/cancel`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...workerAuthorization(token) },
					body: JSON.stringify({ executionId }),
					signal,
				})
				if (!response.ok) {
					throw new Error(`cancel failed: HTTP ${response.status} ${await response.text()}`)
				}
				return await response.json()
			},
			execute: async (executionId, command, argv, opts, signal) =>
				await readExecution(baseUrl, token, executionId, command, argv, opts, signal),
		}
		this.controller = new RemoteExecutionController(adapter)
	}

	async exec(
		command: string,
		argv: string[] | undefined,
		opts: SandboxExecOptions | undefined,
	): Promise<SandboxExecResult> {
		return await this.controller.exec(command, argv, opts)
	}
}

/** Convenience entry point for focused consumers. */
export async function execViaHttpWorker(
	baseUrl: string,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
	token?: string,
): Promise<SandboxExecResult> {
	return await new HttpWorkerClient(baseUrl, token).exec(command, argv, opts)
}
