/** Pal-only composition: all model file, shell and computer operations use the guest. */
import { randomUUID } from 'node:crypto'
import {
	BackgroundJobRegistry,
	DiskSessionLog,
	type LLMProvider,
	type Message,
	type MessageAttachment,
	type PalAdmission,
	type PalConversationAdmission,
	type PalDefinition,
	type PalEnvironmentLease,
	type PalRuntime,
	type QueryParams,
	type ReasoningEffort,
	type ResumeOutcome,
	type SandboxProvider,
	type SessionEvent,
	type SessionLease,
	ToolManager,
	type Toolset,
	asCheckpointId,
	asTurnId,
	bindOwner,
	buildPalSystemPrompt,
	computerUseUnavailableReason,
	createBrowserTools,
	createComputerUseTool,
	createPalReferenceImageTool,
	createToolPresenter,
	createViewImageTool,
	getBuiltinTools,
	palConversationGreeting,
	query,
	resumeSession,
	toolset,
} from '@namzu/sdk'
import { readStoredTurnGuards, resolveTurnGuards } from '../config/turn-guards.js'
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
import { createLiveModeControl } from '../permissions/live-mode.js'
import { PLAN_MODE_REFUSAL, type PermissionMode } from '../permissions/mode.js'
import {
	type AgentSession,
	type AgentSessionOptions,
	type ResumeDurableParams,
	type ResumePausedParams,
	type SendOptions,
	constructProvider,
	makeHoldingResumeHandler,
	makeResumeHandler,
	reviewExemptionFor,
	toAgentEvent,
} from '../tui/agent.js'
import { projectTurnConversation } from '../tui/conversation-history.js'
import { createCliPalMessagingContext } from './communication.js'
import { palConversationBinding } from './conversations.js'
import { assertPalReviewDecision, readPalWaitingReview } from './review.js'

export interface PalSessionEnvironment {
	readonly definition: PalDefinition
	readonly lease?: PalEnvironmentLease
	/** Observe actual ready Pal-controlled guest authority; never starts a computer. */
	readyComputer?(): PalEnvironmentLease | undefined
	admitConversation?(signal?: AbortSignal): Promise<PalConversationAdmission>
	admit(signal?: AbortSignal): Promise<PalAdmission>
}

/** Shared terminal/ACP composition, with no guest allocation at session startup. */
export function palSessionEnvironment(
	runtime: PalRuntime,
	definition: PalDefinition,
	conversationId: string,
): PalSessionEnvironment {
	const { id, revision } = definition
	const request = (signal?: AbortSignal) => ({
		palId: id,
		revision,
		conversationId,
		...(signal ? { signal } : {}),
	})
	return {
		definition: structuredClone(definition),
		readyComputer: () => {
			const lease = runtime.computer(id)
			const control = runtime.computerControl(id)
			return lease && (!control.supported || control.mode === 'pal') ? lease : undefined
		},
		admit: (signal) => runtime.admit(request(signal)),
		admitConversation: (signal) => runtime.admitConversation(request(signal)),
	}
}

/** Every entry checks the current admission; a pause prevents the next guest operation. */
function guardHost<T extends object>(
	host: T,
	assertActive: () => void,
	ignoreDestroy = false,
	current?: () => T,
	beforeAsync?: () => Promise<void>,
): T {
	return new Proxy(host, {
		get(target, key) {
			const source = current?.() ?? target
			const value = Reflect.get(source, key, source)
			if (ignoreDestroy && key === 'destroy') return async () => {}
			if (typeof value !== 'function') return value
			if (beforeAsync && key === 'execStream')
				return async function* (...args: unknown[]) {
					await beforeAsync()
					assertActive()
					const actual = current?.() ?? target
					const method = Reflect.get(actual, key, actual)
					if (typeof method !== 'function')
						throw new Error('This Pal computer lost its stream operation.')
					yield* method.apply(actual, args)
				}
			if (
				beforeAsync &&
				['readFile', 'writeFile', 'listFiles', 'exec', 'execute', 'getDisplayGeometry'].includes(
					String(key),
				)
			)
				return async (...args: unknown[]) => {
					await beforeAsync()
					assertActive()
					const actual = current?.() ?? target
					const method = Reflect.get(actual, key, actual)
					if (typeof method !== 'function') throw new Error('This Pal computer lost its operation.')
					return method.apply(actual, args)
				}
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
	const suppliedBinding = options.palEnvironment
	const binding = suppliedBinding
		? {
				...suppliedBinding,
				definition: structuredClone(suppliedBinding.definition),
				admit: suppliedBinding.admit.bind(suppliedBinding),
				admitConversation: suppliedBinding.admitConversation?.bind(suppliedBinding),
				readyComputer: suppliedBinding.readyComputer?.bind(suppliedBinding),
			}
		: undefined
	const scope = options.scope ? { ...options.scope } : undefined
	const conversations = options.conversationSessions
	if (!binding || !scope || !conversations)
		throw new Error('Pal execution requires its owned computer and claimed conversation scope.')
	if (
		options.cwd !== binding.definition.workspace ||
		(binding.lease && binding.lease.palId !== binding.definition.id) ||
		(!binding.admitConversation && !binding.lease)
	)
		throw new Error('This Pal does not own the conversation or computer.')
	const primary = { ...primaryProvider(prefs) }
	const entry = PROVIDER_REGISTRY[primary.id]
	if (!entry) throw new Error('Unknown Pal model provider.')
	await ensureRegistered(primary.id)
	const model = primary.model ?? entry.defaultModel
	let current = findDetected(detected, primary.id)
	const refresh = createCurrentCredentialReader()
	let provider = constructProvider(primary.id, current, model, {
		sessionId: scope.sessionId,
	})
	let admission: PalAdmission | undefined
	let conversationAdmission: PalConversationAdmission | undefined
	let identity = {
		name: binding.definition.name,
		appearance: binding.definition.appearance,
	}
	let writer:
		| {
				log: DiskSessionLog
				lease: SessionLease
				heartbeat?: ReturnType<typeof setInterval>
				closing?: boolean
				renewing?: Promise<void>
		  }
		| undefined
	let borrowedWriter: { log: DiskSessionLog; lease: SessionLease } | undefined
	let closed = false
	let cleaned = false
	let closing: Promise<void> | undefined
	let activeAbort: AbortController | undefined
	let settleSend: (() => void) | undefined
	let sendSettled = Promise.resolve()
	const assertActive = () => {
		if (closed || (!conversationAdmission && !admission))
			throw new Error('This Pal does not own an active conversation admission.')
		if (conversationAdmission) conversationAdmission.assertActive()
		else admission?.assertActive()
		if (conversationAdmission && admission) admission.assertActive()
	}
	const assertComputerActive = () => {
		assertActive()
		if (!admission) throw new Error('This Pal turn has no computer authority.')
		admission.assertActive()
	}
	const releaseAdmission = async (workFailure?: unknown) => {
		try {
			if (conversationAdmission) await conversationAdmission.release()
			else await admission?.release()
			admission = undefined
			conversationAdmission = undefined
		} catch (error) {
			if (workFailure !== undefined)
				throw new AggregateError([workFailure, error], 'Pal work and admission cleanup failed.')
			throw error
		}
	}
	let sandboxProvider: SandboxProvider | undefined
	let tools: ReturnType<typeof getBuiltinTools> = []
	let sets: Toolset[] = []
	let manager = new ToolManager({ toolsets: sets, messages: () => [] })
	const presenter = createToolPresenter({ get: (name) => manager.get(name) })
	const messaging = createCliPalMessagingContext(binding.definition, scope, assertActive)
	let assertExecutionAllowed: (() => void | Promise<void>) | undefined
	let activePermissionMode: (() => PermissionMode) | undefined
	let referenceAttachments: readonly MessageAttachment[] = []
	const configureComputer = async (lease?: PalEnvironmentLease) => {
		await manager.dispose()
		tools = []
		sets = []
		sandboxProvider = undefined
		if (lease) {
			const guest = guardHost(
				lease.sandbox,
				assertComputerActive,
				true,
				() => admission?.lease.sandbox ?? lease.sandbox,
				async () => {
					await renewWriter()
					await assertExecutionAllowed?.()
				},
			)
			const computer = guardHost(
				lease.computerUseHost,
				assertComputerActive,
				false,
				() => admission?.lease.computerUseHost ?? lease.computerUseHost,
				async () => {
					await renewWriter()
					await assertExecutionAllowed?.()
				},
			)
			sandboxProvider = {
				id: `pal:${binding.definition.id}`,
				name: 'Pal virtual computer',
				environment: guest.environment,
				workspaceModes: ['working-directory'],
				create: async () => {
					assertComputerActive()
					return guest
				},
			}
			const allTools = getBuiltinTools()
			const computerTool = createComputerUseTool(computer, {
				unavailableReason: computerUseUnavailableReason(provider),
			})
			tools = [
				...allTools,
				createViewImageTool({
					unavailableReason: computerUseUnavailableReason(provider),
				}),
				...messaging.tools,
				createPalReferenceImageTool({
					attachments: () => referenceAttachments,
					assertCurrentAdmission: async () => {
						assertComputerActive()
						await renewWriter()
						await assertExecutionAllowed?.()
						assertComputerActive()
						if (activePermissionMode?.() === 'plan') throw new Error(PLAN_MODE_REFUSAL)
					},
				}),
				computerTool,
				...(lease.browserHost
					? createBrowserTools(
							guardHost(lease.browserHost, assertComputerActive, false, () => {
								const browser = admission?.lease.browserHost ?? lease.browserHost
								if (!browser)
									throw new Error('This Pal computer does not support browser operations.')
								return browser
							}),
						)
					: []),
			]
			const guardedTools = tools.map((tool) => ({
				...tool,
				async execute(input: unknown, context: Parameters<typeof tool.execute>[1]) {
					assertComputerActive()
					await renewWriter()
					await assertExecutionAllowed?.()
					assertComputerActive()
					// Durable replay applies its answer before entering the ordinary review
					// handler. The host's current plan mode still governs the actual call.
					if (
						activePermissionMode?.() === 'plan' &&
						!reviewExemptionFor('plan', manager, () => false)(tool.name, input)
					)
						throw new Error(PLAN_MODE_REFUSAL)
					return tool.execute(input, context)
				},
			}))
			sets = [toolset('pal-computer', guardedTools)]
		}
		manager = new ToolManager({ toolsets: sets, messages: () => [] })
	}
	await configureComputer(binding.readyComputer?.() ?? binding.lease)
	const jobs = new BackgroundJobRegistry()
	const ownedJobs = bindOwner(jobs, scope.sessionId)
	const approval = { all: false }

	const permissionReader = (
		opts?: Pick<
			SendOptions,
			'permissionMode' | 'currentPermissionMode' | 'onPermission' | 'reviewHold'
		>,
	): (() => PermissionMode) => {
		const read = opts?.currentPermissionMode
		const fallback =
			opts?.permissionMode ??
			options.permissionMode ??
			// Supplying a review UI does not opt an owned guest into prompting.
			// Explicit modes and a durable review hold still narrow this default.
			(opts?.reviewHold ? 'prompt' : 'auto')
		return () => read?.() ?? fallback
	}
	const beginWork = (
		signal?: AbortSignal,
		guard?: () => void | Promise<void>,
		mode?: () => PermissionMode,
	) => {
		if (closed) throw new Error('This Pal conversation is closed.')
		if (activeAbort) throw new Error('This Pal conversation already has active work.')
		if (admission || conversationAdmission || writer)
			throw new Error('This Pal admission needs cleanup before further work.')
		if (options.scope?.sessionId !== scope.sessionId)
			throw new Error('Reopen this Pal conversation after switching its session.')
		const controller = new AbortController()
		const onAbort = () => controller.abort(signal?.reason)
		signal?.addEventListener('abort', onAbort, { once: true })
		if (signal?.aborted) onAbort()
		activeAbort = controller
		referenceAttachments = []
		assertExecutionAllowed = guard
		activePermissionMode = mode
		sendSettled = new Promise<void>((done) => {
			settleSend = done
		})
		return { controller, signal, onAbort }
	}
	const releaseWriter = async () => {
		if (!writer) return
		writer.closing = true
		if (writer.heartbeat) {
			clearInterval(writer.heartbeat)
			writer.heartbeat = undefined
		}
		await writer.renewing?.catch(() => undefined)
		await writer.log.release(writer.lease)
		writer = undefined
	}
	const renewWriter = async () => {
		if (borrowedWriter) {
			const current = await borrowedWriter.log.lease()
			if (
				!current ||
				current.fence !== borrowedWriter.lease.fence ||
				current.holder !== borrowedWriter.lease.holder ||
				current.expiresAt <= Date.now()
			)
				throw new Error('This Pal resume lost its borrowed session writer lease.')
			return
		}
		const owned = writer
		if (!owned) return
		if (owned.closing) throw new Error('This Pal resume writer is closing.')
		if (owned.renewing) return owned.renewing
		const renewal = (async () => {
			const renewed = await owned.log.claim({
				holder: owned.lease.holder,
				ttlMs: 90_000,
				repairTornTail: false,
			})
			if (!renewed || renewed.fence !== owned.lease.fence)
				throw new Error('This Pal resume lost its session writer lease.')
			owned.lease = renewed
		})()
		owned.renewing = renewal
		try {
			await renewal
		} finally {
			if (owned.renewing === renewal) owned.renewing = undefined
		}
	}
	const finishWork = async (work: ReturnType<typeof beginWork>, failure?: unknown) => {
		try {
			const failures: unknown[] = []
			try {
				await releaseWriter()
			} catch (error) {
				failures.push(error)
			}
			try {
				await releaseAdmission()
			} catch (error) {
				failures.push(error)
			}
			if (failures.length)
				throw failures.length === 1 && failure === undefined
					? failures[0]
					: new AggregateError(
							[...(failure === undefined ? [] : [failure]), ...failures],
							'Pal work cleanup was not confirmed.',
						)
		} finally {
			work.signal?.removeEventListener('abort', work.onAbort)
			activeAbort = undefined
			assertExecutionAllowed = undefined
			activePermissionMode = undefined
			referenceAttachments = []
			borrowedWriter = undefined
			settleSend?.()
			settleSend = undefined
		}
	}
	const assertOwnedConversation = async () => {
		const owner = await palConversationBinding(binding.definition.workspace, scope.sessionId)
		if (
			!owner ||
			owner.definition.id !== binding.definition.id ||
			owner.definition.revision !== binding.definition.revision ||
			owner.definition.workspace !== binding.definition.workspace
		)
			throw new Error('This Pal does not own the pinned conversation revision.')
		// Display identity follows an authenticated rename; execution policy stays pinned.
		identity = { name: owner.pal.name, appearance: owner.pal.appearance }
	}
	const prepareProvider = async (controller: AbortController) => {
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
			if (!credential || (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()))
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
			constructProvider(primary.id, current, model, {
				sessionId: scope.sessionId,
			}),
			assertActive,
			async () => {
				await renewWriter()
				await assertExecutionAllowed?.()
			},
		)
	}
	const enterConversation = async (controller: AbortController, requireComputer = false) => {
		controller.signal.throwIfAborted()
		await assertExecutionAllowed?.()
		controller.signal.throwIfAborted()
		await assertOwnedConversation()
		if (binding.admitConversation) {
			conversationAdmission = await binding.admitConversation(controller.signal)
			assertActive()
			const ready = binding.readyComputer?.()
			if (requireComputer || ready) {
				admission = await conversationAdmission.acquireComputer()
				if (
					ready &&
					(admission.lease.environmentId !== ready.environmentId ||
						admission.lease.generation !== ready.generation)
				)
					throw new Error('This Pal computer changed before its turn was admitted.')
			}
		} else admission = await binding.admit(controller.signal)
		assertActive()
		await configureComputer(admission?.lease)
		await prepareProvider(controller)
	}
	const queryOptions = (
		opts?: Pick<
			SendOptions,
			'permissionMode' | 'currentPermissionMode' | 'onPermission' | 'reviewHold'
		> &
			Pick<ResumePausedParams, 'rules' | 'systemNote'>,
	): Omit<QueryParams, 'messages' | 'turnConfig'> => {
		const read = activePermissionMode ?? permissionReader(opts)
		const modeControl = createLiveModeControl({
			initial: read(),
			read,
			handlerFor: (mode) => {
				const exempt = reviewExemptionFor(mode, manager, () => false)
				return opts?.reviewHold
					? makeHoldingResumeHandler(mode, exempt, {}, opts.reviewHold.reason)
					: makeResumeHandler(approval, opts?.onPermission, mode, exempt)
			},
		})
		return {
			provider,
			paths: conversations.paths,
			...scope,
			agentId: `pal:${binding.definition.id}`,
			agentName: identity.name,
			...(admission ? { workingDirectory: admission.lease.sandbox.rootDir, sandboxProvider } : {}),
			sandboxEscape: 'refuse',
			outsideRootAccess: 'refuse',
			toolsets: sets,
			systemPrompt: buildPalSystemPrompt(
				{ ...binding.definition, ...identity },
				{
					greeting: palConversationGreeting(binding.definition, scope.sessionId),
					computer: admission
						? {
								status: 'ready',
								workingDirectory: admission.lease.sandbox.rootDir,
							}
						: { status: 'unavailable' },
					...(opts?.systemNote ? { systemNote: opts.systemNote } : {}),
				},
			),
			beforeStep: async () => {
				assertActive()
				await renewWriter()
				await assertExecutionAllowed?.()
				assertActive()
				return undefined
			},
			authorizationGate: {
				enabled: true,
				allowReadOnlyTools: true,
				denyDangerousPatterns: true,
				logDecisions: false,
				rules: [...(opts?.rules ?? options.rules ?? [])],
			},
			resumeHandler: modeControl.handler,
			approvalPolicyName: modeControl.initialName,
			onApprovalPolicy: (box) => modeControl.attach(box),
			reviewAllowedCalls: modeControl.reviewAllowedCalls,
			backgroundJobs: jobs,
			backgroundJobOwner: scope.sessionId,
		}
	}
	const kernelResume = async (
		input: ResumeDurableParams &
			Partial<ResumePausedParams> & {
				listener?: (event: SessionEvent) => void
			},
	): Promise<ResumeOutcome> => {
		const params = {
			...input,
			entry: { ...input.entry },
			...(input.pendingDecision ? { pendingDecision: structuredClone(input.pendingDecision) } : {}),
			...(input.model ? { model: { ...input.model } } : {}),
		}
		const work = beginWork(params.signal, params.assertExecutionAllowed, permissionReader(params))
		let failure: unknown
		try {
			const expected = DiskSessionLog.at(conversations.paths, {
				sessionId: scope.sessionId,
			})
			if (
				params.entry.sessionId !== scope.sessionId ||
				params.entry.tenantId !== scope.tenantId ||
				params.entry.projectId !== scope.projectId ||
				!(params.sessionLog instanceof DiskSessionLog) ||
				params.sessionLog.file !== expected.file ||
				params.sessionLog.sessionDir !== expected.sessionDir
			)
				throw new Error('A Pal can resume only its own original conversation journal.')
			const turnId = asTurnId(params.entry.turnId)
			const checkpointId =
				params.checkpointId === undefined ? undefined : asCheckpointId(params.checkpointId)
			if (
				params.model &&
				(params.model.provider !== primary.id || (params.model.model ?? model) !== model)
			)
				throw new Error('A Pal resume must retain its pinned model provider and model.')
			await assertExecutionAllowed?.()
			work.controller.signal.throwIfAborted()
			await assertOwnedConversation()
			const waiting = await readPalWaitingReview(params.sessionLog, turnId, checkpointId)
			if (params.pendingDecision) {
				if (!waiting) throw new Error('This Pal decision is no longer waiting.')
				assertPalReviewDecision(waiting.request, params.pendingDecision)
			}
			const limits = await readStoredTurnGuards(params.sessionLog, turnId)
			if (!limits) throw new Error('This Pal turn has no original recorded limits.')
			for await (const { record } of params.sessionLog.read({
				mode: 'strict',
			})) {
				if (
					record.type === 'turn_started' &&
					record.turnId === turnId &&
					record.config.model !== model
				)
					throw new Error('This Pal turn used another model.')
				// Recover only the original operator input admitted to this exact
				// durable turn. The tool result/checkpoint retains its verified
				// guest manifest; resuming never rewrites prior user attachments.
				if (
					record.type === 'message' &&
					record.turnId === turnId &&
					record.content.role === 'user' &&
					!record.content.source
				)
					referenceAttachments = structuredClone(record.content.attachments ?? [])
			}
			const effort = params.model?.effort
			if (
				effort !== undefined &&
				!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)
			)
				throw new Error('Invalid Pal resume reasoning effort.')
			if (params.lease) {
				borrowedWriter = { log: params.sessionLog, lease: { ...params.lease } }
				await renewWriter()
			} else {
				const lease = await params.sessionLog.claim({
					holder: `pal-resume:${randomUUID()}`,
					ttlMs: 90_000,
					repairTornTail: false,
				})
				if (!lease) throw new Error('This Pal turn is leased by another writer.')
				writer = { log: params.sessionLog, lease }
				writer.heartbeat = setInterval(() => {
					void renewWriter().catch((error) => work.controller.abort(error))
				}, 30_000)
				writer.heartbeat.unref()
			}
			// The actual writer fence holds while the final park is checked and its tools execute.
			const lockedWaiting = await readPalWaitingReview(params.sessionLog, turnId, checkpointId)
			if (params.pendingDecision) {
				if (
					!lockedWaiting ||
					lockedWaiting.decisionId !== waiting?.decisionId ||
					lockedWaiting.requestRecord.sha256 !== waiting.requestRecord.sha256
				)
					throw new Error('This Pal decision changed before its writer was admitted.')
				assertPalReviewDecision(lockedWaiting.request, params.pendingDecision)
			}
			await enterConversation(work.controller, true)
			return await resumeSession({
				...queryOptions(params),
				scope: { ...scope, turnId },
				sessionLog: params.sessionLog,
				...(params.checkpointStore ? { checkpointStore: params.checkpointStore } : {}),
				lease: params.lease ?? writer?.lease,
				...(checkpointId ? { checkpointId } : {}),
				...(params.pendingDecision ? { pendingDecision: params.pendingDecision } : {}),
				turnConfig: {
					model,
					...limits,
					sandbox: { workspace: 'working-directory' },
					permissionMode: 'auto',
					...(effort ? { effort: effort as ReasoningEffort } : {}),
				},
				listener: (event) => {
					options.onSessionEvent?.(event)
					params.listener?.(event)
				},
				signal: work.controller.signal,
			})
		} catch (error) {
			failure = error
			throw error
		} finally {
			await finishWork(work, failure)
		}
	}
	const resumePaused = async function* (params: ResumePausedParams) {
		const turnId = asTurnId(params.turnId)
		const controller = new AbortController()
		const onAbort = () => controller.abort(params.signal?.reason)
		params.signal?.addEventListener('abort', onAbort, { once: true })
		if (params.signal?.aborted) onAbort()
		const queue: SessionEvent[] = []
		let wake: (() => void) | undefined
		let settled = false
		let failure: unknown
		const completion = kernelResume({
			...params,
			signal: controller.signal,
			entry: {
				tenantId: scope.tenantId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				turnId,
			},
			sessionLog: DiskSessionLog.at(conversations.paths, {
				sessionId: scope.sessionId,
			}),
			listener: (event) => {
				queue.push(event)
				wake?.()
			},
		})
			.then((result) => {
				if (!result.resumed)
					throw new Error(
						result.reason === 'awaiting-decision'
							? 'This Pal turn is parked on a decision only a person can answer.'
							: 'This Pal turn has no recorded checkpoint.',
					)
			})
			.catch((error: unknown) => {
				failure = error
			})
			.finally(() => {
				settled = true
				wake?.()
			})
		try {
			for (;;) {
				while (queue.length) {
					const event = queue.shift()
					if (!event) break
					const mapped = toAgentEvent(event, presenter)
					if (mapped) yield mapped
				}
				if (settled) break
				await new Promise<void>((resolve) => {
					wake = resolve
				})
				wake = undefined
			}
			await completion
			if (failure) throw failure
		} finally {
			controller.abort(new Error('Pal resume event stream closed.'))
			params.signal?.removeEventListener('abort', onAbort)
			await completion
		}
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
		get sandbox() {
			return sandboxProvider
				? {
						unconfined: false,
						environment: sandboxProvider.environment,
						enforced: ['filesystem', 'process'] as const,
						required: ['filesystem', 'process'] as const,
						workspace: 'working-directory' as const,
					}
				: { unconfined: false, enforced: [], required: [] }
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
		resumeDurable: kernelResume,
		resumePaused,
		send: async function* (messages, opts) {
			const work = beginWork(opts?.signal, opts?.assertExecutionAllowed, permissionReader(opts))
			const { controller } = work
			let sendFailure: unknown
			try {
				// send() also receives cached history. Only an unrecorded operator
				// input after the last model/tool reply belongs to this new turn.
				// An old attachment is never reimported just because history is sent.
				for (let index = messages.length - 1; index >= 0; index--) {
					const message: Message | undefined = messages[index]
					if (!message || message.role === 'assistant' || message.role === 'tool') break
					if (message.role === 'user' && !message.source && !message.id) {
						referenceAttachments = structuredClone(message.attachments ?? [])
						break
					}
				}
				await enterConversation(controller)
				const events = query({
					...queryOptions(opts),
					sessionLog: DiskSessionLog.at(conversations.paths, {
						sessionId: scope.sessionId,
					}),
					messages: [...messages],
					...(opts?.turnId ? { turnId: opts.turnId } : {}),
					...(opts?.origin ? { origin: opts.origin } : {}),
					turnConfig: {
						model,
						...resolveTurnGuards(options.limits, opts?.limits),
						...(admission ? { sandbox: { workspace: 'working-directory' as const } } : {}),
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
				await finishWork(work, sendFailure)
			}
		},
		close: async () => {
			if (cleaned) return
			if (closing) return closing
			closed = true
			activeAbort?.abort(new Error('Pal conversation closed.'))
			const cleanup = (async () => {
				await sendSettled
				await releaseWriter()
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
