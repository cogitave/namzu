/** Pal-only composition: all model file, shell and computer operations use the guest. */
import {
	BackgroundJobRegistry,
	DiskSessionLog,
	type LLMProvider,
	type PalAdmission,
	type PalDefinition,
	type PalEnvironmentLease,
	type SandboxProvider,
	ToolManager,
	bindOwner,
	computerUseUnavailableReason,
	createBrowserTools,
	createComputerUseTool,
	createToolPresenter,
	getBuiltinTools,
	query,
	toolset,
} from '@namzu/sdk'
import { resolveTurnGuards } from '../config/turn-guards.js'
import { createCurrentCredentialReader } from '../integrations/providers/current-credential.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
	ensureFreshStoredCodexCredential,
	ensureRegistered,
	findDetected,
	primaryProvider,
	readCodexCredentialFile,
} from '../integrations/providers/index.js'
import {
	type AgentSession,
	type AgentSessionOptions,
	constructProvider,
	makeResumeHandler,
	toAgentEvent,
} from '../tui/agent.js'
import { projectTurnConversation } from '../tui/conversation-history.js'
import { createCliPalMessagingContext } from './communication.js'

export interface PalSessionEnvironment {
	readonly definition: PalDefinition
	readonly lease: PalEnvironmentLease
	admit(signal?: AbortSignal): Promise<PalAdmission>
}

/** Every entry checks the current admission; a pause prevents the next guest operation. */
function guardHost<T extends object>(
	host: T,
	assertActive: () => void,
	ignoreDestroy = false,
	current?: () => T,
): T {
	return new Proxy(host, {
		get(target, key) {
			const source = current?.() ?? target
			const value = Reflect.get(source, key, source)
			if (ignoreDestroy && key === 'destroy') return async () => {}
			if (typeof value !== 'function') return value
			return (...args: unknown[]) => {
				assertActive()
				const actual = current?.() ?? target
				const method = Reflect.get(actual, key, actual)
				if (typeof method !== 'function')
					throw new Error('This Pal computer does not support that operation.')
				return method.apply(actual, args)
			}
		},
	})
}

/** Every inference entry, including compaction/retry calls, rereads live consent. */
function guardProvider(
	provider: LLMProvider,
	assertActive: () => void,
	assertExecutionAllowed: () => void | Promise<void>,
): LLMProvider {
	const guarded = guardHost(provider, assertActive)
	return new Proxy(guarded, {
		get(target, key) {
			if (key === 'chatStream')
				return async function* (params: Parameters<LLMProvider['chatStream']>[0]) {
					assertActive()
					await assertExecutionAllowed()
					assertActive()
					yield* target.chatStream(params)
				}
			return Reflect.get(target, key, target)
		},
	})
}

export async function createPalAgentSession(
	prefs: Preferences,
	detected: readonly DetectedProvider[],
	options: AgentSessionOptions,
): Promise<AgentSession> {
	const binding = options.palEnvironment
	const scope = options.scope ? { ...options.scope } : undefined
	const conversations = options.conversationSessions
	if (!binding || !scope || !conversations)
		throw new Error('Pal execution requires its owned computer and claimed conversation scope.')
	if (options.cwd !== binding.definition.workspace || binding.lease.palId !== binding.definition.id)
		throw new Error('This Pal does not own the conversation or computer.')
	const primary = primaryProvider(prefs)
	const entry = PROVIDER_REGISTRY[primary.id]
	if (!entry) throw new Error('Unknown Pal model provider.')
	await ensureRegistered(primary.id)
	const model = primary.model ?? entry.defaultModel
	let current = findDetected(detected, primary.id)
	const refresh = createCurrentCredentialReader()
	let provider = constructProvider(primary.id, current, model, { sessionId: scope.sessionId })
	let admission: PalAdmission | undefined
	let closed = false
	let cleaned = false
	let closing: Promise<void> | undefined
	let activeAbort: AbortController | undefined
	let settleSend: (() => void) | undefined
	let sendSettled = Promise.resolve()
	const assertActive = () => {
		if (closed || !admission) throw new Error('This Pal does not own an active computer admission.')
		admission.assertActive()
	}
	const releaseAdmission = async (workFailure?: unknown) => {
		try {
			await admission?.release()
			admission = undefined
		} catch (error) {
			if (workFailure !== undefined)
				throw new AggregateError([workFailure, error], 'Pal work and admission cleanup failed.')
			throw error
		}
	}
	const guest = guardHost(
		binding.lease.sandbox,
		assertActive,
		true,
		() => admission?.lease.sandbox ?? binding.lease.sandbox,
	)
	const computer = guardHost(
		binding.lease.computerUseHost,
		assertActive,
		false,
		() => admission?.lease.computerUseHost ?? binding.lease.computerUseHost,
	)
	const sandboxProvider: SandboxProvider = {
		id: `pal:${binding.definition.id}`,
		name: 'Pal virtual computer',
		environment: guest.environment,
		workspaceModes: ['working-directory'],
		create: async () => {
			assertActive()
			return guest
		},
	}
	const allTools = getBuiltinTools()
	const messaging = createCliPalMessagingContext(binding.definition, scope, assertActive)
	const computerTool = createComputerUseTool(computer, {
		unavailableReason: computerUseUnavailableReason(provider),
	})
	const tools = [
		...allTools,
		...messaging.tools,
		computerTool,
		...(binding.lease.browserHost
			? createBrowserTools(
					guardHost(binding.lease.browserHost, assertActive, false, () => {
						const browser = admission?.lease.browserHost ?? binding.lease.browserHost
						if (!browser) throw new Error('This Pal computer does not support browser operations.')
						return browser
					}),
				)
			: []),
	]
	let assertExecutionAllowed: (() => void | Promise<void>) | undefined
	const guardedTools = tools.map((tool) => ({
		...tool,
		async execute(input: unknown, context: Parameters<typeof tool.execute>[1]) {
			assertActive()
			await assertExecutionAllowed?.()
			assertActive()
			return tool.execute(input, context)
		},
	}))
	const sets = [toolset('pal-computer', guardedTools)]
	const manager = new ToolManager({ toolsets: sets, messages: () => [] })
	const presenter = createToolPresenter(manager)
	const jobs = new BackgroundJobRegistry()
	const ownedJobs = bindOwner(jobs, scope.sessionId)
	const approval = { all: false }
	const unavailable = async () => {
		throw new Error(
			'This Pal conversation cannot resume a parked turn yet. Send a new message after resolving its pause.',
		)
	}
	return {
		hasProvider: true,
		errorHint: null,
		errorKind: null,
		providerSummary: entry.label,
		modelSummary: model,
		imageAttachmentsSupported: provider.capabilities?.supportsVision,
		documentAttachmentsSupported: provider.capabilities?.supportsDocuments,
		reasoningEffortLevels: provider.reasoningEffortLevelsFor?.(model),
		reasoningEffortDefault: provider.reasoningEffortDefaultFor?.(model),
		sandbox: {
			unconfined: false,
			environment: guest.environment,
			enforced: ['filesystem', 'process'],
			required: ['filesystem', 'process'],
			workspace: 'working-directory',
		},
		toolNames: () => tools.map((tool) => tool.name),
		presenter,
		agentIds: [],
		instructionFiles: [],
		skippedInstructionFiles: [],
		mcpConnected: [],
		mcpFailed: [],
		configNotices: [
			'Pal tools run in its local virtual computer. Host plugins, MCP servers, browser accounts and filesystem are not inherited.',
		],
		approvalLatched: () => approval.all,
		resetApprovalLatch: () => {
			approval.all = false
		},
		promptExemptTools: () => [],
		jobs: () => jobs.list(scope.sessionId),
		readJob: (id, fromOffset) => ownedJobs.read(id, { fromOffset }),
		stopJob: (id) => ownedJobs.kill(id),
		onJobExit: (listener) =>
			jobs.onExit((job) => {
				if (job.owner === scope.sessionId) listener(job)
			}),
		compact: async () => {
			throw new Error('Manual compaction is not available in a Pal conversation yet.')
		},
		resumeDurable: unavailable,
		resumePaused: async function* () {
			yield { kind: 'error', message: 'This Pal conversation cannot resume a parked turn yet.' }
		},
		send: async function* (messages, opts) {
			if (closed) throw new Error('This Pal conversation is closed.')
			if (activeAbort) throw new Error('This Pal conversation already has active work.')
			if (admission) throw new Error('This Pal admission needs cleanup before further work.')
			if (options.scope?.sessionId !== scope.sessionId)
				throw new Error('Reopen this Pal conversation after switching its session.')
			const controller = new AbortController()
			const onAbort = () => controller.abort(opts?.signal?.reason)
			opts?.signal?.addEventListener('abort', onAbort, { once: true })
			if (opts?.signal?.aborted) onAbort()
			activeAbort = controller
			assertExecutionAllowed = opts?.assertExecutionAllowed
			sendSettled = new Promise<void>((done) => {
				settleSend = done
			})
			let sendFailure: unknown
			try {
				admission = await binding.admit(controller.signal)
				assertActive()
				if (current?.entry.id === 'codex' && current.codex?.origin === 'stored') {
					const credential = await ensureFreshStoredCodexCredential(controller.signal)
					current = {
						...current,
						apiKey: credential.accessToken,
						codex: {
							...current.codex,
							accountId: credential.accountId,
							expiresAt: credential.expiresAt,
						},
					}
				} else if (current?.entry.id === 'codex' && current.source.kind === 'codex-file') {
					const credential = readCodexCredentialFile(current.source.path)
					if (
						!credential ||
						(credential.expiresAt !== undefined && credential.expiresAt <= Date.now())
					)
						throw new Error(
							'The Codex credential is unavailable or expired; refresh it with its owner.',
						)
					current = {
						...current,
						apiKey: credential.accessToken,
						codex: {
							...current.codex,
							accountId: credential.accountId,
							expiresAt: credential.expiresAt,
							origin: 'codex-file',
						},
					}
				} else current = await refresh(current, controller.signal)
				provider = guardProvider(
					constructProvider(primary.id, current, model, { sessionId: scope.sessionId }),
					assertActive,
					() => assertExecutionAllowed?.(),
				)
				const events = query({
					provider,
					paths: conversations.paths,
					sessionLog: DiskSessionLog.at(conversations.paths, { sessionId: scope.sessionId }),
					...scope,
					agentId: `pal:${binding.definition.id}`,
					agentName: binding.definition.name,
					workingDirectory: admission.lease.sandbox.rootDir,
					sandboxProvider,
					sandboxEscape: 'refuse',
					outsideRootAccess: 'refuse',
					toolsets: sets,
					messages: [...messages],
					systemPrompt: [
						`You are ${binding.definition.name}, a Namzu Pal.`,
						binding.definition.purpose,
						`Your own local virtual computer is available. All file paths and terminal commands refer to its filesystem at ${admission.lease.sandbox.rootDir}. Use computer_use for its desktop. You do not have access to the operator's host files, desktop, browser accounts or other Pals.`,
					]
						.filter(Boolean)
						.join('\n\n'),
					beforeStep: async () => {
						assertActive()
						await assertExecutionAllowed?.()
						assertActive()
						return undefined
					},
					authorizationGate: {
						enabled: true,
						allowReadOnlyTools: true,
						denyDangerousPatterns: true,
						logDecisions: false,
						rules: [...(options.rules ?? [])],
					},
					resumeHandler: makeResumeHandler(
						approval,
						opts?.onPermission,
						opts?.permissionMode ?? options.permissionMode,
					),
					turnConfig: {
						model,
						...resolveTurnGuards(options.limits, opts?.limits),
						sandbox: { workspace: 'working-directory' },
						permissionMode: 'auto',
						...(opts?.effort ? { effort: opts.effort } : {}),
					},
					backgroundJobs: jobs,
					backgroundJobOwner: scope.sessionId,
					durableInbound: opts?.durableInbound ?? messaging.durableInbound,
					...(opts?.inboundMessages ? { inboundMessages: opts.inboundMessages } : {}),
					...(opts?.waitForInbound ? { waitForInbound: opts.waitForInbound } : {}),
					...(opts?.abandonInterrupted ? { abandonInterrupted: true } : {}),
					signal: controller.signal,
				})
				try {
					while (true) {
						const next = await events.next()
						if (next.done) {
							opts?.onConversationMessages?.(projectTurnConversation(next.value.messages))
							break
						}
						options.onSessionEvent?.(next.value)
						const mapped = toAgentEvent(next.value, presenter)
						if (mapped) yield mapped
					}
				} finally {
					await events.return(undefined as never)
				}
			} catch (error) {
				sendFailure = error
				throw error
			} finally {
				try {
					await releaseAdmission(sendFailure)
				} finally {
					opts?.signal?.removeEventListener('abort', onAbort)
					activeAbort = undefined
					assertExecutionAllowed = undefined
					settleSend?.()
					settleSend = undefined
				}
			}
		},
		close: async () => {
			if (cleaned) return
			if (closing) return closing
			closed = true
			activeAbort?.abort(new Error('Pal conversation closed.'))
			const cleanup = (async () => {
				await sendSettled
				await releaseAdmission()
				await jobs.killOwner(scope.sessionId)
				await manager.dispose()
				cleaned = true
			})()
			closing = cleanup
			try {
				await cleanup
			} finally {
				if (closing === cleanup) closing = undefined
			}
		},
	}
}
