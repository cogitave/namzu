import {
	ACPServer,
	type AcpAgentGateway,
	type ExternalRefTarget,
	HostCommandRegistry,
	type Message,
	type Origin,
	ServerStdioTransport,
	type SessionEvent,
	type SessionId,
	type ToolPresenter,
	createUserMessage,
	generateSessionId,
	genericLabel,
	isEntityId,
	openSessionIndex,
} from '@namzu/sdk'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { cliLogger } from '../logging.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { compilePermissions } from '../permissions/rules.js'
import { type AgentSession, createAgentSession, probeAgentSession } from '../tui/agent.js'
import type { CommandContext, CommandDef } from './types.js'

/** Same read as `cli.ts`'s `--version`: the manifest, never a second copy. */
function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
			version?: unknown
		}
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first
		? {
				version: 3,
				providers: [{ id: first.entry.id }],
				subagents: { active: [] },
			}
		: null
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise<T>((resolve, reject) => {
		let active = true
		const finish = () => {
			if (!active) return false
			active = false
			signal.removeEventListener('abort', onAbort)
			return true
		}
		const onAbort = () => {
			if (finish()) reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		operation.then(
			(value) => {
				if (finish()) resolve(value)
			},
			(error) => {
				if (finish()) reject(error)
			},
		)
	})
}

/**
 * `namzu acp` — the agent-client protocol over this process's stdio.
 *
 * This command exists in the same change as the bridge it drives, and that
 * is the point rather than a convenience. `MCPServer` and
 * `ServerStdioTransport` are both exported from this SDK and nothing in the
 * tree ever constructed an `MCPServer`: a complete protocol server with no
 * driver, which reads as a supported feature and is not one. A subprocess
 * test spawns this binary, so removing the registration below fails a test
 * rather than quietly shipping the same shape twice.
 *
 * **stdout belongs to the protocol.** Everything this command prints for a
 * human goes to stderr. The SDK's logger already writes there; what this
 * file must not do is `console.log`, and a test asserts zero non-JSON bytes
 * on the child's stdout under info-level logging.
 */

/** The namzu session one ACP wire session id stands for. */
export interface AcpSessionTarget {
	readonly sessionId: SessionId
	/** Present when the session is new: recorded in `session_started.origin`. */
	readonly origin?: Origin
}

/** How a caller-side name is looked up (`SessionIndex.resolveExternal`). */
export type ExternalSessionLookup = (
	protocol: 'acp',
	kind: 'session',
	externalId: string,
) => Promise<ExternalRefTarget | undefined>

/**
 * Map an ACP wire session id onto a namzu session (spec §5.3).
 *
 * The SDK's server mints a UUIDv7 `SessionId` by default, and that id IS the
 * namzu session. A host's `newSessionId` may return any string; such an id
 * is never read as a namzu id. It is looked up in the index's
 * `external_refs('acp', 'session', id)`, and a name nobody has claimed gets a
 * new session whose `session_started.origin` records it — which is what puts
 * the ref in the index, so it survives a rebuild and the next connection
 * finds the same session.
 */
export async function resolveAcpSession(
	wireSessionId: string,
	lookup: ExternalSessionLookup,
): Promise<AcpSessionTarget> {
	if (isEntityId(wireSessionId, 'session')) return { sessionId: wireSessionId }
	const found = await lookup('acp', 'session', wireSessionId)
	if (found) return { sessionId: found.sessionId }
	return {
		sessionId: generateSessionId(),
		origin: { protocol: 'acp', externalSessionId: wireSessionId },
	}
}

/** Open the index under `NAMZU_HOME` for one lookup and close it again. */
async function lookupInIndex(
	protocol: 'acp',
	kind: 'session',
	externalId: string,
): Promise<ExternalRefTarget | undefined> {
	const index = await openSessionIndex()
	try {
		return await index.resolveExternal(protocol, kind, externalId)
	} finally {
		index.close()
	}
}

type AcpLiveSession = Pick<
	AgentSession,
	'hasProvider' | 'errorHint' | 'mcpFailed' | 'send' | 'close' | 'presenter'
>

export interface AcpRuntimeDependencies {
	readonly probe: typeof probeAgentSession
	readonly createSession: (
		preferences: Preferences,
		detected: readonly DetectedProvider[],
		options: Parameters<typeof createAgentSession>[2],
	) => Promise<AcpLiveSession>
	readonly decideTrust: typeof decideHeadlessTrust
	readonly resolveProjectContext: typeof resolveTrustedProjectContext
	/** Which namzu session a wire session id stands for; see {@link resolveAcpSession}. */
	readonly resolveSession: (wireSessionId: string) => Promise<AcpSessionTarget>
}

interface AcpRuntimeRecord {
	readonly cwd: string
	readonly session: AcpLiveSession
	route: ((event: SessionEvent) => void) | undefined
}

export interface CliAcpRuntime {
	readonly gateway: AcpAgentGateway
	/**
	 * Delegates to whichever session's turn is currently streaming events —
	 * `record.route` is set exactly when a `prompt` call is live for that
	 * session (see `gateway.prompt` below) — falling back to the generic
	 * label/view before any turn has run. Was permanently a presenter over
	 * an empty, never-populated registry; every ACP tool-call/result view
	 * fell back to the generic label for every tool, every session (fixed
	 * here, not in the SDK: `ACPServerConfig.presenter` is one value for the
	 * whole server, not per session, so this is the best a CLI-side fix can
	 * do without also changing that surface).
	 */
	readonly presenter: ToolPresenter
	close(): Promise<void>
}

const DEFAULT_RUNTIME_DEPS: AcpRuntimeDependencies = {
	probe: probeAgentSession,
	createSession: createAgentSession,
	decideTrust: decideHeadlessTrust,
	resolveProjectContext: resolveTrustedProjectContext,
	resolveSession: (wireSessionId) => resolveAcpSession(wireSessionId, lookupInIndex),
}

/**
 * Owns the CLI runtime behind one ACP connection.
 *
 * The wire server owns IDs, cwd, cancellation and history. This owner mirrors
 * that boundary into the model runtime: one AgentSession and event route per
 * wire session, never one mutable connection-global slot.
 */
export function createCliAcpRuntime(
	bootstrapCtx: CommandContext,
	deps: AcpRuntimeDependencies = DEFAULT_RUNTIME_DEPS,
): CliAcpRuntime {
	const records = new Map<string, AcpRuntimeRecord>()
	const constructing = new Map<string, string>()
	let probePromise: ReturnType<typeof probeAgentSession> | undefined
	let closed = false
	// The record whose turn is currently streaming (`route` set below, at
	// `gateway.prompt`) — the session `toAcpSessionUpdate`'s events are
	// actually about, and so the session `presenter` delegates to.
	let activeRecord: AcpRuntimeRecord | undefined
	const presenter: ToolPresenter = {
		presentCall: (toolName, input) =>
			activeRecord?.session.presenter.presentCall(toolName, input) ?? {
				kind: 'generic',
				label: genericLabel(input),
			},
		presentResult: (toolName, input, result) =>
			activeRecord?.session.presenter.presentResult(toolName, input, result) ?? {
				kind: 'generic',
				label: genericLabel(input),
			},
	}

	const sharedProbe = () => {
		if (!probePromise) {
			probePromise = deps.probe().catch((error) => {
				probePromise = undefined
				throw error
			})
		}
		return probePromise
	}

	const ensureSession = async (
		sessionId: string,
		requestedCwd: string,
		signal: AbortSignal,
	): Promise<AcpRuntimeRecord> => {
		signal.throwIfAborted()
		if (closed) throw new Error('The ACP connection has closed.')

		// This is the first project-aware operation. Session creation and the
		// protocol handshake remain credential-free and do not read the target.
		const trust = deps.decideTrust({ cwd: requestedCwd, trustFlag: false })
		if (!trust.allowed) throw new Error(trust.message ?? 'folder not trusted')
		const cwd = trust.cwd
		const existing = records.get(sessionId)
		if (existing) {
			if (existing.cwd !== cwd) {
				throw new Error(
					`ACP session "${sessionId}" already owns ${existing.cwd}; refusing to reuse it for ${cwd}.`,
				)
			}
			return existing
		}
		if (constructing.has(sessionId)) {
			throw new Error(`ACP session "${sessionId}" is already being constructed.`)
		}
		constructing.set(sessionId, cwd)

		const construction = (async (): Promise<AcpRuntimeRecord> => {
			let candidate: AcpLiveSession | undefined
			const closeCandidate = async () => {
				const owned = candidate
				candidate = undefined
				if (owned) await owned.close()
			}
			try {
				const projectCtx = deps.resolveProjectContext(bootstrapCtx, cwd)
				const permissions = compilePermissions(
					projectCtx.config.permissions,
					projectCtx.config.permissionChecks,
				)
				if (permissions.diagnostics.length > 0) {
					throw new Error(
						permissions.diagnostics
							.map((diagnostic) => {
								const where = diagnostic.pattern
									? `permissions.${diagnostic.tool}."${diagnostic.pattern}"`
									: `permissions.${diagnostic.tool}`
								return `${where}: ${diagnostic.message}`
							})
							.join('\n'),
					)
				}

				const probe = await sharedProbe()
				signal.throwIfAborted()
				if (closed) throw new Error('The ACP connection closed while its session was starting.')
				const prefs = probe.preferences ?? defaultPrefs(probe.detected)
				if (!prefs) {
					throw new Error(
						'No LLM provider is available on this machine: set a credential in the environment, or run `namzu` interactively to pick one. The protocol handshake succeeded; there is nothing to run a prompt with.',
					)
				}

				const target = await deps.resolveSession(sessionId)
				signal.throwIfAborted()
				if (closed) throw new Error('The ACP connection closed while its session was starting.')
				const routeOwner: { current?: AcpRuntimeRecord } = {}
				candidate = await deps.createSession(prefs, probe.detected, {
					cwd,
					sessionId: target.sessionId,
					...(target.origin ? { origin: target.origin } : {}),
					rules: permissions.rules,
					...(projectCtx.config.mcpServers ? { mcpServers: projectCtx.config.mcpServers } : {}),
					...(projectCtx.config.plugins ? { plugins: projectCtx.config.plugins } : {}),
					...(projectCtx.config.skills ? { skills: projectCtx.config.skills } : {}),
					...(projectCtx.config.web ? { web: projectCtx.config.web } : {}),
					...(projectCtx.config.hooks ? { hooks: projectCtx.config.hooks } : {}),
					...(projectCtx.config.compaction ? { compaction: projectCtx.config.compaction } : {}),
					...(projectCtx.config.memory ? { memory: projectCtx.config.memory } : {}),
					...(projectCtx.config.sandbox ? { sandbox: projectCtx.config.sandbox } : {}),
					// `!== undefined`, not truthiness: an empty list is the
					// operator turning the default screen OFF.
					...(projectCtx.config.toolResultScreens !== undefined
						? { toolResultScreens: projectCtx.config.toolResultScreens }
						: {}),
					onSessionEvent: (event: SessionEvent) => routeOwner.current?.route?.(event),
				})
				if (signal.aborted || closed) {
					await closeCandidate()
					signal.throwIfAborted()
					throw new Error('The ACP connection closed while its session was starting.')
				}
				if (!candidate.hasProvider) {
					const hint = candidate.errorHint ?? 'agent is not ready'
					await closeCandidate()
					throw new Error(hint)
				}
				if (candidate.mcpFailed.length > 0) {
					const failure = candidate.mcpFailed
						.map((entry) => `tool server "${entry.name}" is not available: ${entry.reason}`)
						.join('\n')
					await closeCandidate()
					throw new Error(failure)
				}

				const record = { cwd, session: candidate, route: undefined }
				routeOwner.current = record
				if (records.has(sessionId)) {
					await closeCandidate()
					throw new Error(`ACP session "${sessionId}" was published by another operation.`)
				}
				records.set(sessionId, record)
				candidate = undefined
				return record
			} finally {
				constructing.delete(sessionId)
				await closeCandidate()
			}
		})()

		// Session startup can include provider, MCP and sandbox work that does
		// not itself settle when the wire prompt is cancelled. Release the ACP
		// turn immediately, but keep this construction observed and reserved;
		// its own fences close any candidate that eventually arrives.
		return waitForOperation(construction, signal)
	}

	const gateway: AcpAgentGateway = {
		prompt: async ({ sessionId, prompt, cwd, onEvent, signal, ask, history }) => {
			let record: AcpRuntimeRecord
			try {
				record = await ensureSession(sessionId, cwd, signal)
			} catch (error) {
				if (signal.aborted) return { stopReason: 'cancelled' }
				throw error
			}
			record.route = onEvent
			activeRecord = record
			try {
				let stopReason: string | undefined
				let settledHistory: readonly Message[] | undefined
				const onPermission = async (request: {
					toolCalls: readonly {
						id: string
						name: string
						input: unknown
						isDestructive: boolean
					}[]
				}) => {
					const outcome = await ask({
						sessionId,
						toolCalls: request.toolCalls.map((call) => ({
							id: call.id,
							name: call.name,
							input: call.input,
							isDestructive: call.isDestructive,
						})),
					})
					switch (outcome.kind) {
						case 'approve':
							return { kind: 'approve' as const }
						case 'approve_all':
							return { kind: 'approve-all' as const }
						case 'reject':
							return {
								kind: 'reject' as const,
								...(outcome.feedback ? { feedback: outcome.feedback } : {}),
							}
					}
				}
				const messages = [...(history as Message[]), createUserMessage(prompt)]
				for await (const event of record.session.send(messages, {
					signal,
					onPermission,
					onConversationMessages: (messages) => {
						settledHistory = [...messages]
					},
				})) {
					if (event.kind === 'done') stopReason = event.stopReason
					else if (event.kind === 'error' || event.kind === 'paused') {
						stopReason = signal.aborted ? 'cancelled' : 'error'
					}
				}
				if (signal.aborted) stopReason = 'cancelled'
				return {
					...(stopReason === undefined ? {} : { stopReason }),
					...(settledHistory === undefined ? {} : { history: settledHistory }),
				}
			} finally {
				if (record.route === onEvent) record.route = undefined
				if (activeRecord === record) activeRecord = undefined
			}
		},
	}

	return {
		gateway,
		presenter,
		close: async () => {
			closed = true
			const owned = [...records.values()]
			records.clear()
			const results = await Promise.allSettled(owned.map((record) => record.session.close()))
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map((result) => result.reason)
			if (failures.length > 0) throw new AggregateError(failures, 'Failed to close ACP sessions.')
		},
	}
}

export async function runAcpCommand(ctx: CommandContext): Promise<number> {
	const runtime = createCliAcpRuntime(ctx)
	const server = new ACPServer({
		transport: new ServerStdioTransport(),
		gateway: runtime.gateway,
		commands: new HostCommandRegistry(),
		presenter: runtime.presenter,
		agentInfo: { name: 'namzu', version: readPackageVersion() },
	})

	await server.start()
	// Bootstrap context deliberately does not activate the project yet, so it
	// cannot emit the project-aware boot narrative. Still make the live protocol
	// owner observable on stderr; stdout remains exclusively JSON-RPC frames.
	cliLogger().info('ACP protocol server started')
	try {
		// Held open until stdin ends. The client owns the lifetime — it spawned
		// this process — so there is no idle timeout to get wrong.
		await new Promise<void>((resolve) => {
			const finish = () => {
				process.stdin.off('end', finish)
				process.stdin.off('close', finish)
				resolve()
			}
			process.stdin.once('end', finish)
			process.stdin.once('close', finish)
		})
	} finally {
		try {
			await server.stop()
		} finally {
			await runtime.close()
		}
	}
	return 0
}

export const acpCommand: CommandDef = {
	name: 'acp',
	description: "Speak the agent-client protocol over this process's stdio",
	handler: async ({ ctx }) => runAcpCommand(ctx),
}
