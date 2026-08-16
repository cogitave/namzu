import {
	ACP_CLIENT_NOTIFICATIONS,
	ACP_CLIENT_REQUESTS,
	ACP_ERROR_CODES,
	ACP_FILESYSTEM_CAPABILITY,
	ACP_METHODS,
	ACP_PERMISSION_CAPABILITY,
	ACP_PROTOCOL_VERSION,
} from '../../constants/acp/index.js'
import type { HostCommandRegistry } from '../../registry/command/index.js'
import type { ToolPresenter } from '../../registry/tool/presentation.js'
import type {
	AcpFsReadResult,
	AcpInitializeParams,
	AcpInitializeResult,
	AcpRequestPermissionResult,
	AcpSessionCancelParams,
	AcpSessionLoadParams,
	AcpSessionNewParams,
	AcpSessionNewResult,
	AcpSessionPromptParams,
	AcpSessionPromptResult,
	AcpSessionUpdate,
} from '../../types/acp/index.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../types/connector/mcp.js'
import type { RunEvent } from '../../types/run/events.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import type { AcpClientFilesystem } from './filesystem.js'
import type {
	AcpPermissionAsker,
	AcpPermissionOutcome,
	AcpPermissionRequest,
} from './permission.js'
import { toAcpSessionUpdate, toAcpStopReason } from './update.js'

/**
 * An agent-client protocol server over stdio.
 *
 * An editor extension or a CI orchestrator could previously do two things:
 * shell out to the CLI and scrape its output, or embed the SDK in its own
 * process. This is the third — a wire surface a peer written in any language
 * can drive.
 *
 * **The precedent in this tree is a warning, and this change answers it.**
 * `MCPServer` and `ServerStdioTransport` are both exported, and nothing
 * anywhere constructs an `MCPServer`: a complete protocol server with no
 * driver. So `packages/cli/src/commands/acp.ts` ships in the same change,
 * and a subprocess test spawns the real binary — the wire half alone is not
 * a deliverable.
 *
 * **stdout belongs to the protocol.** `ServerStdioTransport`'s own header
 * says it and this is the surface that pays for it: one stray `console.log`
 * anywhere in the process and a client reports malformed JSON with nothing
 * naming the culprit. This repository's logger writes to stderr, and a test
 * asserts zero non-JSON bytes on the child's stdout under info-level
 * logging.
 */

/** What the bridge needs from the runtime, taken as an interface. */
export interface AcpAgentGateway {
	/**
	 * Run one prompt, streaming events, and resolve with the stop reason.
	 *
	 * Deliberately not `AgentManagerContract` itself. This bridge needs one
	 * verb, and a session front end holding the whole manager could cancel
	 * somebody else's task, spawn children, or drain a queue it does not own
	 * — none of which a peer asked for. The CLI passes an adapter over
	 * `sendMessage`/`cancel`.
	 */
	prompt(request: {
		readonly sessionId: string
		readonly prompt: string
		readonly cwd: string
		readonly onEvent: (event: RunEvent) => void
		readonly signal: AbortSignal
		/**
		 * Ask the human in front of the client about a tool batch.
		 *
		 * Handed to the gateway rather than installed by it, so the ONE place
		 * that knows how to reach the client is this bridge. A gateway that
		 * built its own asker would be a second path to the same human, and
		 * the one that forgot to latch `approve_all` would be it.
		 */
		readonly ask: AcpPermissionAsker
		/**
		 * The client's buffers, when it declared the capability. `undefined`
		 * means disk — which is correct, and is what every non-editor peer
		 * wants.
		 */
		readonly filesystem: AcpClientFilesystem | undefined
		/** Turns to resume from, oldest first. Empty for a fresh session. */
		readonly history: readonly unknown[]
	}): Promise<{ readonly stopReason?: string }>

	/**
	 * The turns a prior session left behind, for `session/load`.
	 *
	 * Optional: a gateway with no session store cannot resume, and saying so
	 * by not implementing this is better than returning an empty history that
	 * a client cannot tell apart from a session that really had no turns.
	 */
	load?(sessionId: string): Promise<readonly unknown[]>
}

export interface AcpServerOptions {
	readonly transport: MCPTransport
	readonly gateway: AcpAgentGateway
	/**
	 * The command surface, verbatim from the registry.
	 *
	 * Passed as the registry rather than as a list so `describe()` is called
	 * per initialize: a host that registers a command after construction
	 * still has it appear, and this module has no place to hard-code one.
	 */
	readonly commands: HostCommandRegistry
	readonly presenter: ToolPresenter
	readonly agentInfo: { readonly name: string; readonly version: string }
	/** Injectable so a test does not depend on a random id. */
	readonly newSessionId?: () => string
	readonly log?: Logger
}

interface Session {
	readonly cwd: string
	controller: AbortController
	/**
	 * Whether the human said "approve all" for THIS session.
	 *
	 * Per session, on the session record, and that placement is the whole
	 * property: hoisting it to the server — or to a module-level variable —
	 * would make one person's "stop asking me" silently cover the next
	 * session this process serves, which may be a different repository, a
	 * different editor window, or a different human.
	 */
	approveAll: boolean
	/** Prior turns, when this session was loaded rather than created. */
	history: readonly unknown[]
}

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown

/** A JSON-RPC error this bridge answers with, rather than throwing out. */
class AcpError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message)
		this.name = 'AcpError'
	}
}

export class ACPServer {
	private readonly log: Logger
	private readonly sessions = new Map<string, Session>()
	private initialized = false
	private clientCapabilities: readonly string[] = []
	private sessionSeq = 0

	/**
	 * The method table, authored INDEPENDENTLY of `ACP_METHODS`.
	 *
	 * Deriving it from the constant would make the drift test a tautology.
	 * Two hand-written sets compared in both directions is the only shape
	 * where "a handler nobody advertises" and "an advertised method with no
	 * handler" are both catchable.
	 */
	private readonly handlers: Readonly<Record<string, Handler>> = {
		initialize: (p) => this.onInitialize(p as unknown as AcpInitializeParams),
		'session/new': (p) => this.onSessionNew(p as unknown as AcpSessionNewParams),
		'session/prompt': (p) => this.onSessionPrompt(p as unknown as AcpSessionPromptParams),
		'session/cancel': (p) => this.onSessionCancel(p as unknown as AcpSessionCancelParams),
		'session/load': (p) => this.onSessionLoad(p as unknown as AcpSessionLoadParams),
	}

	/** Requests this side has out to the client, keyed by their id. */
	private readonly pending = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void }
	>()

	private requestSeq = 0

	constructor(private readonly options: AcpServerOptions) {
		this.log = resolveLogger(options.log).child({ 'namzu.log.scope': 'bridge/acp' })
	}

	/** The method names this server answers. For the drift test. */
	methodNames(): readonly string[] {
		return Object.keys(this.handlers).sort()
	}

	async start(): Promise<void> {
		this.options.transport.onMessage((message) => {
			void this.dispatch(message)
		})
		await this.options.transport.connect()
	}

	async stop(): Promise<void> {
		for (const session of this.sessions.values()) session.controller.abort()
		this.sessions.clear()
		// Anything still waiting on the client is rejected rather than left
		// pending: the transport is about to close, so no answer is coming, and
		// a promise nobody will ever settle keeps whatever awaited it alive.
		for (const waiting of this.pending.values()) {
			waiting.reject(new Error('The client connection closed before it answered.'))
		}
		this.pending.clear()
		await this.options.transport.close()
	}

	/**
	 * Ask the client something and wait for its answer.
	 *
	 * The direction this bridge did not have. A notification is fire and
	 * forget; a permission prompt is a question the run cannot proceed past,
	 * so it needs an id, a place to park the promise, and a `dispatch` that
	 * recognises a response frame.
	 */
	private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
		this.requestSeq += 1
		const id = `agent_${this.requestSeq}`
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
			void this.send({ jsonrpc: '2.0', id, method, params }).catch((err: unknown) => {
				this.pending.delete(id)
				reject(err instanceof Error ? err : new Error(String(err)))
			})
		})
	}

	private async dispatch(message: MCPJsonRpcMessage): Promise<void> {
		if (!message.method) {
			// A frame with no method is the client ANSWERING something this side
			// asked. Before permission requests existed there was nothing out on
			// the wire, so ignoring it was right; now dropping it would leave the
			// asker waiting forever and the run parked with nobody coming.
			if (message.id !== undefined && this.pending.has(message.id)) {
				const waiting = this.pending.get(message.id)
				this.pending.delete(message.id)
				if (message.error) {
					waiting?.reject(new Error(message.error.message))
				} else {
					waiting?.resolve(message.result)
				}
			}
			return
		}

		const handler = this.handlers[message.method]
		if (!handler) {
			// Answered, and the CONNECTION STAYS OPEN. A client probing for a
			// feature must not lose its session because this agent does not have
			// it yet.
			await this.respondError(
				message.id,
				ACP_ERROR_CODES.METHOD_NOT_FOUND,
				`Unknown method "${message.method}". This agent implements: ${this.methodNames().join(', ')}.`,
			)
			return
		}

		try {
			const result = await handler(message.params ?? {})
			if (message.id !== undefined) {
				await this.send({ jsonrpc: '2.0', id: message.id, result })
			}
		} catch (err) {
			const code = err instanceof AcpError ? err.code : ACP_ERROR_CODES.INTERNAL_ERROR
			await this.respondError(message.id, code, err instanceof Error ? err.message : String(err))
		}
	}

	private async respondError(
		id: MCPJsonRpcMessage['id'],
		code: number,
		message: string,
	): Promise<void> {
		// A notification (no id) that failed has nowhere to send an error, so
		// it is logged instead of dropped silently — on stderr, where it does
		// not corrupt the protocol stream.
		if (id === undefined) {
			this.log.warn('an acp notification failed', {
				'namzu.acp.error_code': code,
				'namzu.acp.error_message': message,
			})
			return
		}
		await this.send({ jsonrpc: '2.0', id, error: { code, message } })
	}

	private async send(message: MCPJsonRpcMessage): Promise<void> {
		try {
			await this.options.transport.send(message)
		} catch (err) {
			// The client hung up mid-write. Nothing to recover; a throw here
			// would escape into whichever handler happened to be running.
			this.log.warn('acp send failed', {
				'namzu.acp.error_message': err instanceof Error ? err.message : String(err),
			})
		}
	}

	private async notifyUpdate(sessionId: string, update: AcpSessionUpdate): Promise<void> {
		await this.send({
			jsonrpc: '2.0',
			method: ACP_CLIENT_NOTIFICATIONS.SESSION_UPDATE,
			params: { sessionId, update } as unknown as Record<string, unknown>,
		})
	}

	private onInitialize(params: AcpInitializeParams): AcpInitializeResult {
		this.initialized = true
		this.clientCapabilities = params.capabilities ?? []
		return {
			protocolVersion: ACP_PROTOCOL_VERSION,
			agentInfo: this.options.agentInfo,
			// From the registry, per call. A hard-coded list here would be a
			// second definition of the command surface.
			commands: this.options.commands.describe(),
			requiredClientCapabilities: [ACP_PERMISSION_CAPABILITY],
			// Advertised so a client author can see the option exists. Separate
			// from `required` on purpose: a peer that is not an editor has no
			// buffers, and demanding this of it would refuse a session that is
			// perfectly able to run.
			optionalClientCapabilities: [ACP_FILESYSTEM_CAPABILITY],
		}
	}

	private onSessionNew(params: AcpSessionNewParams): AcpSessionNewResult {
		this.requireInitialized()
		this.requirePermissionCapability()
		return { sessionId: this.openSession(params.cwd, []) }
	}

	/**
	 * Resume a session the store already has.
	 *
	 * The prior turns come from the gateway, never from this bridge: the
	 * history lives in whatever session store the host wired up, and a bridge
	 * that kept its own copy would answer a resume with the turns THIS process
	 * happened to see rather than the ones the session actually had.
	 */
	private async onSessionLoad(params: AcpSessionLoadParams): Promise<AcpSessionNewResult> {
		this.requireInitialized()
		this.requirePermissionCapability()
		if (!this.options.gateway.load) {
			throw new AcpError(
				ACP_ERROR_CODES.METHOD_NOT_FOUND,
				'This agent has no session store, so there is nothing to resume. Create a new session instead.',
			)
		}
		const history = await this.options.gateway.load(params.sessionId)
		// The SAME id, not a new one. A client that asked to resume `ses_x` and
		// got `ses_y` back has to rewrite whatever it had keyed by the old one.
		this.sessions.set(params.sessionId, {
			cwd: params.cwd ?? process.cwd(),
			controller: new AbortController(),
			approveAll: false,
			history,
		})
		return { sessionId: params.sessionId }
	}

	private openSession(cwd: string | undefined, history: readonly unknown[]): string {
		this.sessionSeq += 1
		const sessionId = this.options.newSessionId?.() ?? `acp_${this.sessionSeq}`
		this.sessions.set(sessionId, {
			cwd: cwd ?? process.cwd(),
			controller: new AbortController(),
			// Fresh per session. See `Session.approveAll`.
			approveAll: false,
			history,
		})
		return sessionId
	}

	private requireInitialized(): void {
		if (!this.initialized) {
			throw new AcpError(
				ACP_ERROR_CODES.INVALID_REQUEST,
				`Call "${ACP_METHODS.INITIALIZE}" before creating a session.`,
			)
		}
	}

	private requirePermissionCapability(): void {
		if (!this.clientCapabilities.includes(ACP_PERMISSION_CAPABILITY)) {
			// REFUSED, not auto-approved. A session that cannot ask a human
			// anything and runs every tool regardless is not a degraded version
			// of asking — it is the opposite of it, arrived at by omission.
			throw new AcpError(
				ACP_ERROR_CODES.INVALID_REQUEST,
				`This agent will not create a session for a client that did not declare the "${ACP_PERMISSION_CAPABILITY}" capability. Tool calls need somewhere to ask, and a session without one would approve everything silently.`,
			)
		}
	}

	private async onSessionPrompt(params: AcpSessionPromptParams): Promise<AcpSessionPromptResult> {
		const session = this.requireSession(params.sessionId)
		// A fresh controller per turn: the previous one may already be aborted
		// by a cancel of the turn before, and reusing it would start this one
		// already cancelled.
		session.controller = new AbortController()

		const outcome = await this.options.gateway.prompt({
			sessionId: params.sessionId,
			prompt: params.prompt,
			cwd: session.cwd,
			signal: session.controller.signal,
			onEvent: (event) => {
				const update = toAcpSessionUpdate(event, this.options.presenter)
				if (update) void this.notifyUpdate(params.sessionId, update)
			},
			ask: (request) => this.askPermission(session, request),
			filesystem: this.clientFilesystem(),
			history: session.history,
		})

		return { stopReason: toAcpStopReason(outcome.stopReason) }
	}

	private onSessionCancel(params: AcpSessionCancelParams): null {
		this.requireSession(params.sessionId).controller.abort()
		// `null` rather than `{}`: a JSON-RPC result has to be present, and an
		// empty object invites a client to look for a field.
		return null
	}

	/**
	 * Put a tool batch in front of the human, unless they already said yes to
	 * everything for this session.
	 */
	private async askPermission(
		session: Session,
		request: AcpPermissionRequest,
	): Promise<AcpPermissionOutcome> {
		// The latch, read from the SESSION. Checked here rather than in the
		// gateway so no gateway can forget it.
		if (session.approveAll) return { kind: 'approve_all' }

		const answer = await this.request<AcpRequestPermissionResult>(
			ACP_CLIENT_REQUESTS.REQUEST_PERMISSION,
			{
				sessionId: request.sessionId,
				toolCalls: request.toolCalls,
			},
		)

		switch (answer?.outcome) {
			case 'approve':
				return { kind: 'approve' }
			case 'approve_all':
				session.approveAll = true
				return { kind: 'approve_all' }
			case 'reject':
				return { kind: 'reject', ...(answer.feedback ? { feedback: answer.feedback } : {}) }
			default:
				// An answer this side cannot read is not an approval. A client that
				// sent something unrecognised has not said yes, and treating
				// "unparseable" as consent is the failure this whole exchange
				// exists to prevent.
				return {
					kind: 'reject',
					feedback: `The client answered the permission request with an outcome this agent does not recognise (${JSON.stringify(answer?.outcome)}), so the calls were not run.`,
				}
		}
	}

	/**
	 * The client's buffers, when it declared the capability.
	 *
	 * `undefined` otherwise, and that is the ordinary case: a peer that is not
	 * an editor has no buffers, and the agent should read the disk.
	 */
	private clientFilesystem(): AcpClientFilesystem | undefined {
		if (!this.clientCapabilities.includes(ACP_FILESYSTEM_CAPABILITY)) return undefined
		return {
			readTextFile: async (path) => {
				const result = await this.request<AcpFsReadResult>(ACP_CLIENT_REQUESTS.FS_READ, { path })
				return result?.content ?? ''
			},
			writeTextFile: async (path, content) => {
				await this.request(ACP_CLIENT_REQUESTS.FS_WRITE, { path, content })
			},
		}
	}

	private requireSession(sessionId: string): Session {
		const session = this.sessions.get(sessionId)
		if (!session) {
			throw new AcpError(
				ACP_ERROR_CODES.INVALID_PARAMS,
				`No session "${sessionId}". Create one with "${ACP_METHODS.SESSION_NEW}" first.`,
			)
		}
		return session
	}
}
