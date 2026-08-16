import { A2A_PROTOCOL_VERSION, TERMINAL_STATES } from '../../constants/a2a/index.js'
import { A2ATaskSchema } from '../../contracts/a2a.js'
import type { A2AAgentCard, A2AMessage, A2AMethod, A2ATask } from '../../types/a2a/index.js'
import type {
	Delegate,
	DelegateCapabilities,
	DelegateRequest,
	DelegateResult,
} from '../../types/agent/delegate.js'

/**
 * The client half of the A2A bridge, as a `Delegate`.
 *
 * This kernel could SERVE an agent card and answer `message/send` for two
 * versions and could not read anybody else's — the bridge was a one-way
 * door. So the seam added in NZ-PEER-05 had no driven consumer, which is
 * the state this repo has a ratified rule about: a seam with no caller is
 * an untested guess at what a caller needs.
 *
 * It is deliberately small. Everything about scheduling, cancellation
 * bookkeeping, sibling policy and outcome predicates already lives in
 * `DelegatingTaskScheduler`; this only knows how to talk to a peer.
 */

/** Anything that answers like `fetch`. Injected so a test needs no socket. */
export type FetchLike = (
	input: string,
	init?: {
		method?: string
		headers?: Record<string, string>
		body?: string
		signal?: AbortSignal
	},
) => Promise<{
	ok: boolean
	status: number
	json(): Promise<unknown>
	text(): Promise<string>
}>

/** A peer that answered with something that is not an agent card. */
export class InvalidAgentCardError extends Error {
	readonly details: { url: string; reason: string }

	constructor(details: { url: string; reason: string }) {
		super(`The agent card at ${details.url} is not usable: ${details.reason}`)
		this.name = 'InvalidAgentCardError'
		this.details = details
	}
}

/** A peer speaking a protocol version this kernel does not implement. */
export class A2AProtocolMismatchError extends Error {
	readonly details: { url: string; theirs: string; ours: string }

	constructor(details: { url: string; theirs: string; ours: string }) {
		super(
			`The peer at ${details.url} speaks A2A ${details.theirs}; this kernel implements ${details.ours}.`,
		)
		this.name = 'A2AProtocolMismatchError'
		this.details = details
	}
}

/** The peer answered, and said no. */
export class A2ARequestError extends Error {
	readonly details: { method: string; status?: number; code?: string }

	constructor(message: string, details: { method: string; status?: number; code?: string }) {
		super(message)
		this.name = 'A2ARequestError'
		this.details = details
	}
}

const majorMinor = (version: string): string => version.split('.').slice(0, 2).join('.')

/**
 * Read a peer's card, and refuse one this kernel cannot honestly use.
 *
 * Two refusals rather than a best effort. A card that does not parse is not
 * a peer with quirks, it is an unknown service at a URL somebody typed —
 * and a protocol version this kernel does not implement means every
 * subsequent request is a guess. Both are found once, at wiring time, which
 * is the only moment a human is looking; degrade here and the failure moves
 * to the middle of a delegation with a run waiting on it.
 *
 * The version comparison is on major.minor, not the patch. A2A is
 * pre-1.0, where the minor carries breaking changes — matching on the full
 * string would refuse a peer over a patch bump that changes nothing.
 */
export async function fetchAgentCard(
	baseUrl: string,
	opts: { readonly fetch: FetchLike; readonly signal?: AbortSignal },
): Promise<A2AAgentCard> {
	const url = `${baseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`
	const response = await opts.fetch(url, {
		method: 'GET',
		headers: { accept: 'application/json' },
		...(opts.signal ? { signal: opts.signal } : {}),
	})
	if (!response.ok) {
		throw new InvalidAgentCardError({ url, reason: `HTTP ${response.status}` })
	}

	let body: unknown
	try {
		body = await response.json()
	} catch (err) {
		throw new InvalidAgentCardError({
			url,
			reason: err instanceof Error ? err.message : 'the body is not JSON',
		})
	}

	const card = body as Partial<A2AAgentCard>
	// Checked by hand rather than through a schema, because there is no
	// `A2AAgentCardSchema` in `contracts/a2a.ts` — the card is a type here
	// and not a parser. Only the fields this client actually depends on are
	// required; inventing requirements a peer does not owe us would refuse
	// working peers.
	if (typeof card?.name !== 'string' || !Array.isArray(card.supportedInterfaces)) {
		throw new InvalidAgentCardError({ url, reason: 'no name, or no supportedInterfaces' })
	}
	if (card.supportedInterfaces.length === 0) {
		throw new InvalidAgentCardError({ url, reason: 'supportedInterfaces is empty' })
	}
	if (
		card.protocolVersion &&
		majorMinor(card.protocolVersion) !== majorMinor(A2A_PROTOCOL_VERSION)
	) {
		throw new A2AProtocolMismatchError({
			url,
			theirs: card.protocolVersion,
			ours: A2A_PROTOCOL_VERSION,
		})
	}
	return card as A2AAgentCard
}

export interface A2ADelegateConfig {
	/** The id the delegation tools name. See `Delegate.id`. */
	readonly id: string
	readonly card: A2AAgentCard
	readonly fetch: FetchLike
	/** Headers every request carries — an authorization header, in practice. */
	readonly headers?: Readonly<Record<string, string>>
	/** How often to ask `tasks/get` while the peer is still working. */
	readonly pollIntervalMs?: number
	/** Give up on a delegation still running after this long. */
	readonly timeoutMs?: number
}

const DEFAULT_POLL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * States this CLIENT will stop polling on — `TERMINAL_STATES` plus
 * `input-required`, and the difference is not a widening of the same idea.
 *
 * `TERMINAL_STATES` is the SERVER's set, and it is right there:
 * `input-required` is not terminal for a server, because the server is the
 * side that can receive the input and carry on. It is terminal for this
 * client, which has no channel to supply it — so the peer will sit in that
 * state forever and polling it is polling a state that cannot change.
 *
 * Reusing the server's set here cost a test timeout to find, and it would
 * have cost a real delegation the full ten-minute deadline for a peer that
 * had already answered "which quarter?" in the first second.
 */
const WILL_NOT_PROGRESS: ReadonlySet<string> = new Set([...TERMINAL_STATES, 'input-required'])

/** The text of every text part, in order. */
function textOf(message: A2AMessage | undefined): string | undefined {
	if (!message) return undefined
	const text = message.parts
		.filter((part): part is Extract<typeof part, { kind: 'text' }> => part.kind === 'text')
		.map((part) => part.text)
		.join('\n')
	return text.length > 0 ? text : undefined
}

/**
 * A peer's terminal task, as a delegate outcome.
 *
 * `input-required` is the interesting one. It is not a failure — the peer
 * did its work and is waiting for something — but `DelegateResult` has no
 * state for it, and inventing `completed` would hand the parent a
 * half-answer as though it were the answer. So it reports `failed` and SAYS
 * that is what happened, which is the honest reading: this delegate has no
 * channel to supply the input, so from the parent's side the delegation did
 * not produce a result.
 */
function toDelegateResult(task: A2ATask): DelegateResult {
	const message = textOf(task.status.message)
	const artifacts = (task.artifacts ?? [])
		.map((artifact) => textOf({ role: 'agent', parts: artifact.parts }))
		.filter((text): text is string => text !== undefined)
	// Artifacts first: a peer that produced one put its answer there, and the
	// status message is usually a sentence about the answer rather than the
	// answer itself.
	const output = artifacts.length > 0 ? artifacts.join('\n\n') : message

	switch (task.status.state) {
		case 'completed':
			return { status: 'completed', ...(output === undefined ? {} : { output }) }
		case 'canceled':
			return { status: 'cancelled', ...(output === undefined ? {} : { output }) }
		case 'input-required':
			return {
				status: 'failed',
				...(output === undefined ? {} : { output }),
				error: 'The peer is waiting for more input, and this delegate has no channel to supply it.',
			}
		default:
			return {
				status: 'failed',
				...(output === undefined ? {} : { output }),
				error: message ?? `The peer reported ${task.status.state}.`,
			}
	}
}

export class A2ADelegate implements Delegate {
	readonly id: string
	readonly capabilities: DelegateCapabilities

	private readonly endpoint: string

	constructor(private readonly config: A2ADelegateConfig) {
		this.id = config.id
		const target = config.card.supportedInterfaces.find((i) => i.transport === 'jsonrpc')
		if (!target) {
			// Refused at construction. `supportedInterfaces` is what the card
			// exists to tell us, and a peer offering only gRPC is a peer this
			// client cannot talk to — discovering that mid-delegation would
			// waste a run's time on a wiring mistake.
			throw new InvalidAgentCardError({
				url: config.card.supportedInterfaces[0]?.url ?? '(no interface)',
				reason: 'no jsonrpc interface; this client speaks jsonrpc only',
			})
		}
		this.endpoint = target.url
		this.capabilities = {
			// Always offered: `tasks/cancel` is in the A2A method set, and a
			// peer that will not cancel a particular task answers
			// `TaskNotCancelable`, which surfaces as an error rather than as a
			// silent no-op.
			cancel: true,
			// NOT offered. A2A's `message/send` with an existing task id can
			// continue a conversation, but this delegate holds one task per
			// dispatch and `Delegate.continue` is fire-and-forget with no way
			// to report that the peer refused. Claiming it would be the
			// silent-no-op the seam refuses.
			continue: false,
		}
	}

	private async rpc(method: A2AMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const response = await this.config.fetch(this.endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				...this.config.headers,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${this.id}`, method, params }),
			...(signal ? { signal } : {}),
		})
		if (!response.ok) {
			throw new A2ARequestError(`${method} failed with HTTP ${response.status}`, {
				method,
				status: response.status,
			})
		}
		const body = (await response.json()) as {
			result?: unknown
			error?: { code?: string | number; message?: string }
		}
		if (body.error) {
			throw new A2ARequestError(body.error.message ?? `${method} was refused`, {
				method,
				...(body.error.code === undefined ? {} : { code: String(body.error.code) }),
			})
		}
		return body.result
	}

	private parseTask(raw: unknown, method: A2AMethod): A2ATask {
		const parsed = A2ATaskSchema.safeParse(raw)
		if (!parsed.success) {
			// Validated rather than trusted. This is a foreign service's reply
			// being turned into a result the model will read as an answer, and
			// the difference between a malformed task and a task in a state we
			// mishandle is exactly what a parse tells us.
			throw new A2ARequestError(`${method} returned something that is not an A2A task`, {
				method,
			})
		}
		return parsed.data as A2ATask
	}

	async dispatch(
		request: DelegateRequest,
		opts: { readonly signal?: AbortSignal },
	): Promise<DelegateResult> {
		const sent = this.parseTask(
			await this.rpc(
				'message/send',
				{ message: { role: 'user', parts: [{ kind: 'text', text: request.prompt }] } },
				// Deliberately NOT `opts.signal`. An abort must reach the peer as
				// a `tasks/cancel`, and it cannot if the request that learns the
				// task id is itself aborted — the delegation would be left
				// running on the peer's side, billed, with nothing here holding
				// an id that could stop it.
			),
			'message/send',
		)

		// The abort tells the PEER to stop. Aborting only our poll loop leaves
		// the peer working and holding whatever the task holds; a cancel has
		// to reach the side doing the work. Fire-and-forget with the failure
		// swallowed: this is best-effort courtesy on a path that is already
		// unwinding, and a peer that refuses the cancel must not turn the
		// parent's cancellation into an exception.
		const tellThePeer = () => {
			void this.rpc('tasks/cancel', { id: sent.id }).catch(() => {})
		}
		opts.signal?.addEventListener('abort', tellThePeer, { once: true })
		if (opts.signal?.aborted) tellThePeer()

		try {
			const deadline = Date.now() + (this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
			let task = sent
			while (!WILL_NOT_PROGRESS.has(task.status.state)) {
				if (opts.signal?.aborted) {
					// The peer has been told. Reported as cancelled rather than
					// polled to a terminal state, because the parent has stopped
					// waiting and the answer is no longer wanted.
					return { status: 'cancelled' }
				}
				if (Date.now() > deadline) {
					return {
						status: 'failed',
						error: `The peer was still ${task.status.state} after ${this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
					}
				}
				await sleep(this.config.pollIntervalMs ?? DEFAULT_POLL_MS, opts.signal)
				task = this.parseTask(
					await this.rpc('tasks/get', { id: sent.id }, opts.signal),
					'tasks/get',
				)
			}
			return toDelegateResult(task)
		} finally {
			opts.signal?.removeEventListener('abort', tellThePeer)
		}
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener('abort', () => {
			clearTimeout(timer)
			resolve()
		})
	})
}
