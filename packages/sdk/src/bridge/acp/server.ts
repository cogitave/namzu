import {
	ACP_CLIENT_NOTIFICATIONS,
	ACP_ERROR_CODES,
	ACP_METHODS,
	ACP_PERMISSION_CAPABILITY,
	ACP_PROTOCOL_VERSION,
} from '../../constants/acp/index.js'
import type { HostCommandRegistry } from '../../registry/command/index.js'
import type { ToolPresenter } from '../../registry/tool/presentation.js'
import type {
	AcpInitializeParams,
	AcpInitializeResult,
	AcpSessionCancelParams,
	AcpSessionNewParams,
	AcpSessionNewResult,
	AcpSessionPromptParams,
	AcpSessionPromptResult,
	AcpSessionUpdate,
} from '../../types/acp/index.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../types/connector/mcp.js'
import type { RunEvent } from '../../types/run/events.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
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
	}): Promise<{ readonly stopReason?: string }>
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
	}

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
		await this.options.transport.close()
	}

	private async dispatch(message: MCPJsonRpcMessage): Promise<void> {
		// A response or a notification with no method: nothing to answer, and
		// nothing wrong either. Answering would put a frame on the wire the
		// client never asked for.
		if (!message.method) return

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
		}
	}

	private onSessionNew(params: AcpSessionNewParams): AcpSessionNewResult {
		if (!this.initialized) {
			throw new AcpError(
				ACP_ERROR_CODES.INVALID_REQUEST,
				`Call "${ACP_METHODS.INITIALIZE}" before creating a session.`,
			)
		}
		if (!this.clientCapabilities.includes(ACP_PERMISSION_CAPABILITY)) {
			// REFUSED, not auto-approved. A session that cannot ask a human
			// anything and runs every tool regardless is not a degraded version
			// of asking — it is the opposite of it, arrived at by omission.
			// Approval routing lands separately; until it does, this is the
			// honest answer and it names what is missing.
			throw new AcpError(
				ACP_ERROR_CODES.INVALID_REQUEST,
				`This agent will not create a session for a client that did not declare the "${ACP_PERMISSION_CAPABILITY}" capability. Tool calls need somewhere to ask, and a session without one would approve everything silently.`,
			)
		}

		this.sessionSeq += 1
		const sessionId = this.options.newSessionId?.() ?? `acp_${this.sessionSeq}`
		this.sessions.set(sessionId, {
			cwd: params.cwd ?? process.cwd(),
			controller: new AbortController(),
		})
		return { sessionId }
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
		})

		return { stopReason: toAcpStopReason(outcome.stopReason) }
	}

	private onSessionCancel(params: AcpSessionCancelParams): null {
		this.requireSession(params.sessionId).controller.abort()
		// `null` rather than `{}`: a JSON-RPC result has to be present, and an
		// empty object invites a client to look for a field.
		return null
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
