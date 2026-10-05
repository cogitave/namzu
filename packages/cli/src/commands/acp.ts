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
import { type PluginInventoryView, readPluginInventory } from '../integrations/plugins/inventory.js'
import { canSelectModel } from '../integrations/providers/access.js'
import {
	type ComposerModelSettings,
	validateComposerSendSettings,
} from '../integrations/providers/composer-settings.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { isOfferableModel } from '../integrations/providers/zen-catalogue.js'
import {
	closeSessions,
	loadResumableConversation,
	openSessions,
} from '../integrations/sessions/store.js'
import { cliLogger } from '../logging.js'
import { palSessionEnvironment } from '../pals/agent-session.js'
import { palConversationBinding } from '../pals/conversations.js'
import { closeCliPalRuntime, getCliPalRuntime } from '../pals/environment.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { compilePermissions, warnLegacyMcpPermissionNames } from '../permissions/rules.js'
import {
	type AgentSession,
	createAgentSession,
	describeProviderModels,
	describeProviderReasoning,
	probeAgentSession,
} from '../tui/agent.js'
import { withCliHarnesses } from './acp-harness.js'
import { createDesktopHostExtensions } from './desktop-host.js'
import { desktopModelCatalogue } from './desktop-model-catalogue.js'
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
	| 'hasProvider'
	| 'errorHint'
	| 'mcpFailed'
	| 'send'
	| 'close'
	| 'presenter'
	| 'jobs'
	| 'readJob'
	| 'stopJob'
	| 'plugins'
	| 'reasoningEffortLevels'
	| 'reasoningEffortDefault'
	| 'imageAttachmentsSupported'
	| 'documentAttachmentsSupported'
>

export interface AcpRuntimeDependencies {
	readonly palBinding?: typeof palConversationBinding
	readonly palRuntime?: typeof getCliPalRuntime
	readonly probe: typeof probeAgentSession
	readonly describeModels?: typeof describeProviderModels
	readonly describeReasoning?: typeof describeProviderReasoning
	readonly readPlugins?: typeof readPluginInventory
	readonly createSession: (
		preferences: Preferences,
		detected: readonly DetectedProvider[],
		options: Parameters<typeof createAgentSession>[2],
	) => Promise<AcpLiveSession>
	readonly decideTrust: typeof decideHeadlessTrust
	readonly resolveProjectContext: typeof resolveTrustedProjectContext
	/** Which namzu session a wire session id stands for; see {@link resolveAcpSession}. */
	readonly resolveSession: (wireSessionId: string) => Promise<AcpSessionTarget>
	/** Durable CLI catalog owned for the lifetime of one runtime session. */
	readonly openSessions?: typeof openSessions
}

interface AcpRuntimeRecord {
	readonly conversations?: Awaited<ReturnType<typeof openSessions>>
	readonly cwd: string
	readonly session: AcpLiveSession
	/** Host-validated Pal binding, never a wire-supplied scope claim. */
	readonly ownedPal: boolean
	route: ((event: SessionEvent) => void) | undefined
}

export interface CliAcpRuntime {
	readonly gateway: AcpAgentGateway
	providerStatus(sessionId?: string): Promise<unknown>
	modelSettings(provider: string, model: string, sessionId?: string): Promise<ComposerModelSettings>
	plugins(cwd: string, sessionId?: string): Promise<PluginInventoryView>
	setPluginEnabled(
		sessionId: string,
		name: string,
		enabled: boolean,
		cwd?: string,
	): Promise<PluginInventoryView>
	models(
		provider: string,
		sessionId?: string,
	): Promise<{
		models: { id: string; label: string; note?: string }[]
		notice: string | null
	}>
	selectProvider(sessionId: string, provider: string, model?: string): Promise<void>
	jobs(sessionId: string): readonly import('@namzu/sdk').BackgroundJob[]
	readJob(sessionId: string, jobId: string): unknown
	stopJob(sessionId: string, jobId: string): Promise<unknown>
	/**
	 * Delegates to whichever session's own event is being rendered RIGHT NOW
	 * — never "whichever session's `prompt` call is live", which two
	 * concurrent prompts both are. `record.route` (see `gateway.prompt`
	 * below) wraps the SDK's `onEvent` so that `activeRecord` is set to
	 * `record` for exactly the synchronous span of that one call: `update.ts`
	 * reads `presenter` synchronously while building the update it emits, so
	 * bracketing the call this tightly, rather than for the whole turn, is
	 * what keeps a second session's prompt — live at the same time — from
	 * ever being read as "active" while this event is presented. Falls back
	 * to the generic label/view before any turn has run. Was permanently a
	 * presenter over an empty, never-populated registry; every ACP
	 * tool-call/result view fell back to the generic label for every tool,
	 * every session (fixed here, not in the SDK: `ACPServerConfig.presenter`
	 * is one value for the whole server, not per session, so this is the
	 * best a CLI-side fix can do without also changing that surface).
	 */
	readonly presenter: ToolPresenter
	close(): Promise<void>
}

const DEFAULT_RUNTIME_DEPS: AcpRuntimeDependencies = {
	palBinding: palConversationBinding,
	palRuntime: getCliPalRuntime,
	openSessions,
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
	const selections = new Map<string, Preferences>()
	// Explicit changes belong to the wire conversation, including when a model
	// change reconstructs its runtime. Never persist these into startup config.
	const pluginOverrides = new Map<string, Map<string, boolean>>()
	const selecting = new Set<string>()
	const catalogueController = new AbortController()
	const catalogueRequests = new Map<string, ReturnType<typeof describeProviderModels>>()
	let probePromise: ReturnType<typeof probeAgentSession> | undefined
	let closed = false
	// The record whose event `toAcpSessionUpdate` is presenting RIGHT NOW —
	// set only for the synchronous span of one `record.route(event)` call
	// (see `gateway.prompt`), never for a whole turn, so two turns in flight
	// at once cannot read each other's record while presenting their own
	// event.
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
	const preferencesFor = async (
		sessionId: string | undefined,
		probe: Awaited<ReturnType<typeof probeAgentSession>>,
		cwd = process.cwd(),
	) => {
		const selected = sessionId ? selections.get(sessionId) : undefined
		if (selected) return selected
		const base = probe.preferences ?? defaultPrefs(probe.detected)
		const binding = sessionId ? await deps.palBinding?.(cwd, sessionId) : null
		if (!binding?.definition.model) return base
		const profile = binding.definition.model
		const entry = probe.detected.find(({ entry }) => entry.id === profile.provider)?.entry
		if (!entry) throw new Error('This Pal provider is not configured. Set it up in Namzu first.')
		const preferences: Preferences = {
			...(base ?? { version: 3, subagents: { active: [] } }),
			providers: [{ id: entry.id, model: profile.model }],
		}
		selections.set(sessionId as string, preferences)
		return preferences
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
		const palBinding = await deps.palBinding?.(cwd, sessionId)
		if (palBinding?.pal.paused) throw new Error('This Pal is paused.')
		if (selecting.has(sessionId)) throw new Error('Wait for the model change to finish.')
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
			let conversationState: Awaited<ReturnType<typeof openSessions>> | undefined
			const closeCandidate = async () => {
				const owned = candidate
				candidate = undefined
				try {
					if (owned) await owned.close()
				} finally {
					if (conversationState) closeSessions(conversationState)
					conversationState = undefined
				}
			}
			try {
				const projectCtx = deps.resolveProjectContext(bootstrapCtx, cwd)
				warnLegacyMcpPermissionNames(projectCtx.config.permissions)
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
				const prefs = await preferencesFor(sessionId, probe, cwd)
				if (!prefs) {
					throw new Error(
						'No LLM provider is available on this machine: set a credential in the environment, or run `namzu` interactively to pick one. The protocol handshake succeeded; there is nothing to run a prompt with.',
					)
				}

				const target = await deps.resolveSession(sessionId)
				signal.throwIfAborted()
				if (closed) throw new Error('The ACP connection closed while its session was starting.')
				conversationState = await deps.openSessions?.(cwd)
				const palRuntime = palBinding ? await deps.palRuntime?.() : undefined
				if (palBinding && !palRuntime) throw new Error('This Pal runtime is unavailable.')
				signal.throwIfAborted()
				const routeOwner: { current?: AcpRuntimeRecord } = {}
				candidate = await deps.createSession(prefs, probe.detected, {
					...(palBinding && palRuntime
						? {
								palEnvironment: palSessionEnvironment(palRuntime, palBinding.definition, sessionId),
							}
						: {}),
					cwd,
					sessionId: target.sessionId,
					...(conversationState
						? {
								conversationSessions: conversationState,
								scope: {
									sessionId: target.sessionId,
									projectId: conversationState.projectId,
									topicId: conversationState.topicId,
									tenantId: conversationState.tenantId,
								},
							}
						: {}),
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
				for (const [name, enabled] of pluginOverrides.get(sessionId) ?? []) {
					if (!candidate.plugins?.list().some((plugin) => plugin.name === name)) {
						throw new Error(
							'A previously selected plugin is no longer available in this conversation.',
						)
					}
					await candidate.plugins.setEnabled(name, enabled)
					signal.throwIfAborted()
					if (closed) throw new Error('The connection closed while restoring plugin choices.')
				}

				const record: AcpRuntimeRecord = {
					cwd,
					session: candidate,
					ownedPal: !!palBinding,
					conversations: conversationState,
					route: undefined,
				}
				routeOwner.current = record
				if (records.has(sessionId)) {
					await closeCandidate()
					throw new Error(`ACP session "${sessionId}" was published by another operation.`)
				}
				records.set(sessionId, record)
				candidate = undefined
				conversationState = undefined
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
		load: async (sessionId, requestedCwd) => {
			if (!requestedCwd) throw new Error('A project is required to load a conversation.')
			const trust = deps.decideTrust({ cwd: requestedCwd, trustFlag: false })
			if (!trust.allowed) throw new Error(trust.message)
			const target = await deps.resolveSession(sessionId)
			await deps.palBinding?.(trust.cwd, target.sessionId)
			const state = await openSessions(trust.cwd)
			try {
				return await loadResumableConversation(state, target.sessionId)
			} finally {
				closeSessions(state)
			}
		},
		prompt: async ({
			sessionId,
			prompt,
			attachments,
			options,
			cwd,
			onEvent,
			signal,
			ask,
			history,
		}) => {
			let record: AcpRuntimeRecord
			try {
				record = await ensureSession(sessionId, cwd, signal)
			} catch (error) {
				if (signal.aborted) return { stopReason: 'cancelled' }
				throw error
			}
			if (
				record.session.imageAttachmentsSupported === false &&
				attachments?.some((file) => file.type !== 'document')
			)
				throw new Error(
					'This model cannot receive images. Choose a model that supports images before sending this attachment.',
				)
			if (
				record.session.documentAttachmentsSupported === false &&
				attachments?.some((file) => file.type === 'document')
			)
				throw new Error(
					'This model cannot receive documents. Choose a model that supports documents before sending this attachment.',
				)
			// Wraps `onEvent`, not aliases it: `toAcpSessionUpdate` reads
			// `presenter` synchronously while building the update this call
			// produces, so `activeRecord` is `record` for exactly that
			// synchronous span and restored (not just cleared) afterward — a
			// concurrent session's own routed event, firing between two of
			// this session's, sets and restores the SAME variable around its
			// own span without corrupting this one. `routedEvent`, not
			// `onEvent`, is what the `finally` below compares against, since
			// `record.route` never holds `onEvent` itself anymore.
			const routedEvent = (event: SessionEvent): void => {
				const outer = activeRecord
				activeRecord = record
				try {
					onEvent(event)
				} finally {
					activeRecord = outer
				}
			}
			record.route = routedEvent
			try {
				let stopReason: string | undefined
				let failureMessage: string | undefined
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
				const messages = [...(history as Message[]), createUserMessage(prompt, attachments)]
				const settings = validateComposerSendSettings(
					options,
					record.session,
					record.ownedPal ? 'auto' : 'prompt',
				)
				for await (const event of record.session.send(messages, {
					...settings,
					signal,
					onPermission,
					onConversationMessages: (messages) => {
						settledHistory = [...messages]
					},
				})) {
					if (event.kind === 'done') stopReason = event.stopReason
					else if (event.kind === 'error' || event.kind === 'paused') {
						stopReason = signal.aborted ? 'cancelled' : 'error'
						if (event.kind === 'error' && !signal.aborted) failureMessage = event.message
					}
				}
				if (signal.aborted) stopReason = 'cancelled'
				if (stopReason === 'error' && settledHistory === undefined && failureMessage)
					throw new Error(failureMessage)
				return {
					...(stopReason === undefined ? {} : { stopReason }),
					...(settledHistory === undefined ? {} : { history: settledHistory }),
				}
			} finally {
				if (record.route === routedEvent) record.route = undefined
			}
		},
	}

	return {
		gateway,
		presenter,
		modelSettings: async (provider, model, sessionId) => {
			if (closed) throw new Error('The connection is closed.')
			if (sessionId !== undefined && !isEntityId(sessionId, 'session'))
				throw new Error('Invalid conversation id.')
			if (typeof model !== 'string' || !model.trim() || model.length > 400)
				throw new Error('Invalid model.')
			const probe = await sharedProbe()
			const detected = probe.detected.find(({ entry }) => entry.id === provider)
			if (!detected) throw new Error('This provider is not configured. Set it up in Namzu first.')
			const preferences = await preferencesFor(sessionId, probe)
			const current = preferences?.providers[0]
			const record = sessionId ? records.get(sessionId) : undefined
			if (
				record &&
				current?.id === provider &&
				(current.model ?? detected.entry.defaultModel) === model
			) {
				return {
					effortLevels: record.session.reasoningEffortLevels,
					effortDefault: record.session.reasoningEffortDefault,
				}
			}
			const result = await (deps.describeReasoning ?? describeProviderReasoning)(
				{
					...(preferences ?? { version: 3, subagents: { active: [] } }),
					providers: [
						{ id: detected.entry.id, model },
						...(preferences?.providers.slice(1).filter((item) => item.id !== provider) ?? []),
					],
				},
				probe.detected,
				catalogueController.signal,
			)
			if (closed) throw new Error('The connection is closed.')
			return {
				effortLevels: result.effortLevels,
				effortDefault: result.effortDefault,
				...(result.notice
					? {
							notice: 'Reasoning choices could not be fully established for this model.',
						}
					: {}),
			}
		},
		plugins: async (requestedCwd, sessionId) => {
			if (closed) throw new Error('The connection is closed.')
			const trust = deps.decideTrust({ cwd: requestedCwd, trustFlag: false })
			if (!trust.allowed) throw new Error(trust.message ?? 'Trust this folder first.')
			if (sessionId && (await deps.palBinding?.(trust.cwd, sessionId)))
				return {
					plugins: [],
					live: false,
					canChange: false,
					notice: 'Host plugins are not inherited by Pals.',
				}
			const record = sessionId ? records.get(sessionId) : undefined
			if (record && record.cwd !== trust.cwd)
				throw new Error('This conversation belongs to another project.')
			const projectCtx = deps.resolveProjectContext(bootstrapCtx, trust.cwd)
			return (deps.readPlugins ?? readPluginInventory)({
				cwd: trust.cwd,
				config: projectCtx.config.plugins,
				runtime: record?.session.plugins,
				canChange: Boolean(
					record?.session.plugins &&
						!record.route &&
						!selecting.has(sessionId ?? '') &&
						!record.session.jobs?.().some((job) => job.status === 'running'),
				),
			})
		},
		setPluginEnabled: async (sessionId, name, enabled, cwd) => {
			if (
				!isEntityId(sessionId, 'session') ||
				typeof name !== 'string' ||
				!name.trim() ||
				name.length > 400 ||
				typeof enabled !== 'boolean'
			)
				throw new Error('Invalid plugin choice.')
			const record = records.get(sessionId)
			if (cwd !== undefined) {
				const trust = deps.decideTrust({ cwd, trustFlag: false })
				if (!trust.allowed) throw new Error(trust.message ?? 'Trust this folder first.')
				if (record && record.cwd !== trust.cwd)
					throw new Error('This conversation belongs to another project.')
			}
			if (!record?.session.plugins)
				throw new Error('Start this conversation before changing loaded plugins.')
			if (
				closed ||
				constructing.has(sessionId) ||
				selecting.has(sessionId) ||
				record.route ||
				record.session.jobs?.().some((job) => job.status === 'running')
			)
				throw new Error('Stop this conversation’s active work before changing plugins.')
			if (!record.session.plugins.list().some((plugin) => plugin.name === name))
				throw new Error('This plugin is not loaded in this conversation.')
			selecting.add(sessionId)
			try {
				await record.session.plugins.setEnabled(name, enabled)
				if (closed) throw new Error('The connection is closed.')
				let overrides = pluginOverrides.get(sessionId)
				if (!overrides) {
					overrides = new Map()
					pluginOverrides.set(sessionId, overrides)
				}
				overrides.set(name, enabled)
				return await (deps.readPlugins ?? readPluginInventory)({
					cwd: record.cwd,
					runtime: record.session.plugins,
					canChange: true,
				})
			} finally {
				selecting.delete(sessionId)
			}
		},
		providerStatus: async (sessionId) => {
			const probe = await sharedProbe()
			const choice = (await preferencesFor(sessionId, probe))?.providers[0]
			return {
				available: probe.detected.map(({ entry }) => ({
					id: entry.id,
					label: entry.label,
					defaultModel: entry.defaultModel,
				})),
				selected: choice
					? { id: choice.id, ...(choice.model ? { model: choice.model } : {}) }
					: null,
			}
		},
		models: async (provider, sessionId) => {
			if (closed) throw new Error('The connection is closed.')
			if (sessionId !== undefined && !isEntityId(sessionId, 'session'))
				throw new Error('Invalid conversation id.')
			const probe = await sharedProbe()
			if (closed) throw new Error('The connection is closed.')
			const detected = probe.detected.find(({ entry }) => entry.id === provider)
			if (!detected) throw new Error('This provider is not configured. Set it up in Namzu first.')
			let request = catalogueRequests.get(provider)
			if (!request) {
				request = (deps.describeModels ?? describeProviderModels)(
					detected.entry.id,
					detected,
					catalogueController.signal,
				)
				catalogueRequests.set(provider, request)
				void request.finally(() => catalogueRequests.delete(provider)).catch(() => {})
			}
			const listing = await request
			if (closed) throw new Error('The connection is closed.')
			const choice = (await preferencesFor(sessionId, probe))?.providers[0]
			return desktopModelCatalogue(
				listing,
				detected.entry.defaultModel,
				choice?.id === provider ? choice.model : undefined,
				(model) =>
					canSelectModel(detected.entry, detected.apiKey, model) &&
					isOfferableModel(provider, model),
			)
		},
		selectProvider: async (sessionId, provider, model) => {
			if (!isEntityId(sessionId, 'session')) throw new Error('Invalid conversation id.')
			if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 400))
				throw new Error('Invalid model.')
			if (constructing.has(sessionId) || selecting.has(sessionId))
				throw new Error('Wait for this conversation to finish connecting.')
			selecting.add(sessionId)
			try {
				const probe = await sharedProbe()
				if (closed) throw new Error('The connection is closed.')
				const detected = probe.detected.find(({ entry }) => entry.id === provider)
				if (!detected) throw new Error('This provider is not configured. Set it up in Namzu first.')
				const selectedModel = model ?? detected.entry.defaultModel
				if (!isOfferableModel(provider, selectedModel))
					throw new Error('This model has no supported wire format. Choose a listed model.')
				if (!canSelectModel(detected.entry, detected.apiKey, selectedModel))
					throw new Error(
						'This model requires a credential for the selected provider. Configure it or choose a listed free model.',
					)
				const preferences = await preferencesFor(sessionId, probe)
				const previous = preferences?.providers[0]
				if (
					previous?.id === provider &&
					(previous.model ?? detected.entry.defaultModel) === (model ?? detected.entry.defaultModel)
				)
					return
				const existing = records.get(sessionId)
				if (existing?.route || existing?.session.jobs?.().some((job) => job.status === 'running'))
					throw new Error('Stop this conversation’s active work before changing its model.')
				if (existing) {
					records.delete(sessionId)
					try {
						await existing.session.close()
					} finally {
						if (existing.conversations) closeSessions(existing.conversations)
					}
				}
				if (closed) throw new Error('The connection is closed.')
				selections.set(sessionId, {
					...(preferences ?? { version: 3, subagents: { active: [] } }),
					providers: [
						{ id: detected.entry.id, ...(model ? { model } : {}) },
						...(preferences?.providers.slice(1).filter((item) => item.id !== detected.entry.id) ??
							[]),
					],
				})
			} finally {
				selecting.delete(sessionId)
			}
		},
		jobs: (sessionId) => records.get(sessionId)?.session.jobs?.() ?? [],
		readJob: (sessionId, jobId) => {
			const session = records.get(sessionId)?.session
			if (!session?.readJob) throw new Error('This conversation has no background shell.')
			return session.readJob(jobId)
		},
		stopJob: async (sessionId, jobId) => {
			const session = records.get(sessionId)?.session
			if (!session?.stopJob) throw new Error('This conversation has no background shell.')
			return await session.stopJob(jobId)
		},
		close: async () => {
			closed = true
			pluginOverrides.clear()
			catalogueController.abort(new Error('The connection is closed.'))
			const owned = [...records.values()]
			records.clear()
			const results = await Promise.allSettled(
				owned.map(async (record) => {
					try {
						await record.session.close()
					} finally {
						if (record.conversations) closeSessions(record.conversations)
					}
				}),
			)
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map((result) => result.reason)
			if (failures.length > 0) throw new AggregateError(failures, 'Failed to close ACP sessions.')
		},
	}
}

/** Try both resource owners even if conversation shutdown fails. */
export async function closeAcpResources(
	runtime: Pick<CliAcpRuntime, 'close'>,
	closePals: () => Promise<void> = closeCliPalRuntime,
): Promise<void> {
	const failures: unknown[] = []
	try {
		await runtime.close()
	} catch (error) {
		failures.push(error)
	}
	try {
		await closePals()
	} catch (error) {
		failures.push(error)
	}
	if (failures.length) throw new AggregateError(failures, 'ACP cleanup failed.')
}

export async function runAcpCommand(ctx: CommandContext, desktop = false): Promise<number> {
	const runtime = withCliHarnesses(createCliAcpRuntime(ctx), process.cwd())
	const server: ACPServer = new ACPServer({
		supportsPromptAttachments: true,
		supportsPromptOptions: true,
		transport: new ServerStdioTransport(),
		gateway: runtime.gateway,
		commands: new HostCommandRegistry(),
		presenter: runtime.presenter,
		agentInfo: { name: 'namzu', version: readPackageVersion() },
		...(desktop
			? {
					extensions: createDesktopHostExtensions(runtime, process.cwd(), (id) =>
						server.getSessionCwd(id),
					),
				}
			: {}),
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
			await closeAcpResources(runtime)
		}
	}
	return 0
}

export const acpCommand: CommandDef = {
	name: 'acp',
	description: "Speak the agent-client protocol over this process's stdio",
	passThrough: true,
	help: 'Usage: namzu acp [--desktop]\nSpeak ACP over stdio. --desktop enables scoped operator methods for the Namzu desktop application.',
	handler: async ({ ctx, rawArgs }) => {
		if (rawArgs.some((arg) => arg !== '--desktop'))
			throw new Error('Unknown ACP argument. Use namzu acp --help.')
		return runAcpCommand(ctx, rawArgs.includes('--desktop'))
	},
}
