import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context, type Span, type Tracer, trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'
import { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { PluginRegistry } from '../../../registry/plugin/index.js'
import type {
	AttachmentOperationOptions,
	AttachmentStore,
	StoredBytes,
} from '../../../store/attachment/index.js'
import type { SessionCheckpointStore } from '../../../store/checkpoint/index.js'
import type { SessionLog } from '../../../store/session-log/index.js'
import { InMemoryTopicStateStore } from '../../../store/topic/state.js'
import type { PluginId, SessionId, TenantId } from '../../../types/ids/index.js'
import {
	type Message,
	type MessageAttachment,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { TurnCancelled } from '../../../types/session/cancel-cause.js'
import type { FencingToken } from '../../../types/session/durable.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { Logger } from '../../../utils/logger.js'
import { drainQuery } from '../index.js'
import { resumeSession } from '../resume-session.js'
import { TEST_SCOPE, records, sessionWithCheckpoint } from './support/session.js'

const dirs: string[] = []

/**
 * A message the kernel now stamps with the id its record was given, so a
 * fixture built before that stamp no longer matches by full equality.
 * `objectContaining` alone still misses: `createAssistantMessage` sets
 * `toolCalls: undefined` explicitly when none are given, and matches an
 * absent property differently than one round-tripped through JSON — which
 * is what a real message went through to reach the log and come back.
 */
function matchingMessage(expected: Message): ReturnType<typeof expect.objectContaining> {
	return expect.objectContaining(JSON.parse(JSON.stringify(expected)) as Record<string, unknown>)
}

function logger(): Logger {
	const make = (): Logger =>
		({
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			child: vi.fn(() => make()),
		}) as unknown as Logger
	return make()
}

afterEach(async () => {
	trace.disable()
	await removeTempDirs(dirs)
	dirs.length = 0
})

function recordSpanParents(): {
	readonly started: { name: string; parent?: Span }[]
	readonly ended: Span[]
} {
	const started: { name: string; parent?: Span }[] = []
	const ended: Span[] = []
	const tracer = {
		startSpan: (name: string, _options?: unknown, context?: Context) => {
			const parent = context ? trace.getSpan(context) : undefined
			const span = {
				spanContext: () => ({ traceId: 'f'.repeat(32), spanId: 'e'.repeat(16), traceFlags: 1 }),
				setAttribute: () => span,
				setAttributes: () => span,
				addEvent: () => span,
				setStatus: () => span,
				updateName: () => span,
				end: () => {
					ended.push(span)
				},
				isRecording: () => true,
				recordException: () => undefined,
				addLink: () => span,
				addLinks: () => span,
			} as unknown as Span
			started.push({ name, ...(parent ? { parent } : {}) })
			return span
		},
	} as unknown as Tracer
	trace.setGlobalTracerProvider({ getTracer: () => tracer } as never)
	return { started, ended }
}

async function workingDirectory(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-attachment-cancel-'))
	dirs.push(cwd)
	return cwd
}

function storedDocumentMessage(): Message {
	const attachment = {
		type: 'stored',
		ref: 'ref_contract',
		kind: 'document',
		mediaType: 'application/pdf',
		name: 'contract.pdf',
	} as unknown as MessageAttachment
	return {
		...createUserMessage('read the contract'),
		attachments: [attachment],
	}
}

function identity() {
	return {
		sessionId: '36352807-8b8c-40f9-83dd-ce171423424b' as SessionId,
		topicId: '958adcdc-028e-43c4-91e4-0bc4983e50de' as TopicId,
		projectId: '6509f00e-fe45-45e8-9402-a476e6538404' as ProjectId,
		tenantId: 'e5bed096-6762-42d8-a885-db684a4efc47' as TenantId,
	}
}

async function params(
	provider: MockLLMProvider,
	attachmentStore: AttachmentStore | undefined,
	messages: readonly Message[],
	signal: AbortSignal,
) {
	return {
		provider,
		toolsets: [],
		messages: [...messages],
		...(attachmentStore ? { attachmentStore } : {}),
		workingDirectory: await workingDirectory(),
		turnConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 100_000,
			maxIterations: 1,
		},
		agentId: 'attachment-cancellation',
		agentName: 'Attachment cancellation',
		signal,
		...identity(),
	}
}

describe('stored attachment resolution belongs to the turn', () => {
	it('lets withdrawn authority outrank a missing attachment store', async () => {
		const reason = new TurnCancelled('user')
		const caller = new AbortController()
		caller.abort(reason)
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const input = storedDocumentMessage()

		const run = await drainQuery(await params(provider, undefined, [input], caller.signal))

		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(run.messages).toContainEqual(input)
	})

	it('starts no store or provider work when authority was already withdrawn', async () => {
		const caller = new AbortController()
		caller.abort(new TurnCancelled('user'))
		const get = vi.fn(
			async (): Promise<StoredBytes> => ({
				data: 'must-not-be-read',
				mediaType: 'application/pdf',
			}),
		)
		const store: AttachmentStore = {
			put: async () => 'unused',
			get,
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })

		const run = await drainQuery(
			await params(provider, store, [storedDocumentMessage()], caller.signal),
		)

		expect(get).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
	})

	it('settles on cancellation even when the store ignores its signal', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let release!: (bytes: StoredBytes) => void
		const held = new Promise<StoredBytes>((resolve) => {
			release = resolve
		})
		let storeOptions: AttachmentOperationOptions | undefined
		const store: AttachmentStore = {
			put: async () => 'unused',
			get: (_ref, options) => {
				storeOptions = options
				markStarted()
				return held
			},
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const input = storedDocumentMessage()
		const caller = new AbortController()
		const pending = drainQuery(await params(provider, store, [input], caller.signal))

		await started
		const reason = new TurnCancelled('user')
		caller.abort(reason)
		// No real 250ms safety race: it competed with the same clock as the
		// cancellation work it waited on, so a starved CI runner could make
		// that work outlast the guard with nothing actually broken. A
		// regression that left this unresolved now fails on Vitest's own
		// per-test timeout instead.
		let outcome: Awaited<typeof pending>
		try {
			outcome = await pending
		} finally {
			// Release the stalled attachment fetch so nothing is left live
			// regardless of how the query above settled.
			release({ data: 'late-pdf', mediaType: 'application/pdf' })
		}

		expect(storeOptions?.signal).not.toBe(caller.signal)
		expect(storeOptions?.signal?.aborted).toBe(true)
		expect(storeOptions?.signal?.reason).toBe(reason)
		expect(caller.signal.reason).toBe(reason)
		expect(provider.requests).toHaveLength(0)
		expect(outcome.status).toBe('cancelled')
		expect(outcome.stopReason).toBe('cancelled')
		const persistedInput = outcome.messages.find((message) => message.role === 'user')
		expect(persistedInput).toEqual(input)

		// Releasing a non-cooperative backend after the turn settled cannot
		// publish its bytes or start a provider request.
		await Promise.resolve()
		expect(provider.requests).toHaveLength(0)
	})

	it('notifies root interrupt observers after attachment cancellation without starting ordinary hooks', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let release!: (bytes: StoredBytes) => void
		const held = new Promise<StoredBytes>((resolve) => {
			release = resolve
		})
		const store: AttachmentStore = {
			put: async () => 'unused',
			get: () => {
				markStarted()
				return held
			},
		}
		const manager = new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: logger(),
			hookTimeoutMs: 1_000,
		})
		const ordinaryStart = vi.fn(async () => ({ action: 'continue' as const }))
		const interrupted = vi.fn(async () => ({ action: 'continue' as const }))
		manager.registerHook('plugin_start' as PluginId, {
			event: 'turn_start',
			handler: ordinaryStart,
		})
		manager.registerHook('plugin_interrupt' as PluginId, {
			event: 'turn_interrupt',
			handler: interrupted,
		})
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		const events: SessionEvent[] = []
		const pending = drainQuery(
			{
				...(await params(provider, store, [storedDocumentMessage()], caller.signal)),
				pluginManager: manager,
			},
			(event) => {
				events.push(event)
			},
		)

		await started
		caller.abort(new TurnCancelled('user'))
		const run = await pending
		release({ data: 'late-pdf', mediaType: 'application/pdf' })

		expect(run.status).toBe('cancelled')
		expect(provider.requests).toHaveLength(0)
		expect(ordinaryStart).not.toHaveBeenCalled()
		expect(interrupted).toHaveBeenCalledOnce()
		const interruptCompleted = events.findIndex(
			(event) => event.type === 'plugin_hook_completed' && event.hookEvent === 'turn_interrupt',
		)
		const runCompleted = events.findIndex((event) => event.type === 'turn_completed')
		expect(interruptCompleted).toBeGreaterThan(-1)
		expect(interruptCompleted).toBeLessThan(runCompleted)
	})

	it('does not enter a non-cooperative guardrail after attachment cancellation', async () => {
		let markStoreStarted!: () => void
		const storeStarted = new Promise<void>((resolve) => {
			markStoreStarted = resolve
		})
		let releaseStore!: (bytes: StoredBytes) => void
		const heldStore = new Promise<StoredBytes>((resolve) => {
			releaseStore = resolve
		})
		let releaseGuardrail!: (value: { action: 'pass' }) => void
		const heldGuardrail = new Promise<{ action: 'pass' }>((resolve) => {
			releaseGuardrail = resolve
		})
		const inputGuardrail = vi.fn(() => heldGuardrail)
		const store: AttachmentStore = {
			put: async () => 'unused',
			get: () => {
				markStoreStarted()
				return heldStore
			},
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		const queryParams = await params(provider, store, [storedDocumentMessage()], caller.signal)
		const pending = drainQuery({
			...queryParams,
			inputGuardrails: [inputGuardrail],
		})

		await storeStarted
		caller.abort(new TurnCancelled('user'))
		// No real 250ms safety race: see the fix above at the top of this
		// file for why racing it against the cancellation work it waited on
		// was the flaky part, not the mechanism.
		let outcome: Awaited<typeof pending>
		try {
			outcome = await pending
		} finally {
			releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })
			releaseGuardrail({ action: 'pass' })
		}

		expect(inputGuardrail).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(outcome.status).toBe('cancelled')
		expect(outcome.stopReason).toBe('cancelled')
	})

	it('does not hand a turn context back after project preparation cancellation', async () => {
		const store: AttachmentStore = {
			put: async () => 'unused',
			get: async () => ({ data: 'resolved-pdf', mediaType: 'application/pdf' }),
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		const sentinel = new Error('host callback must not replace cancellation')
		let markPreparationStarted!: () => void
		const preparationStarted = new Promise<void>((resolve) => {
			markPreparationStarted = resolve
		})
		let releasePreparation!: (value: undefined) => void
		const heldPreparation = new Promise<undefined>((resolve) => {
			releasePreparation = resolve
		})
		const onContextCreated = vi.fn(() => {
			throw sentinel
		})
		const queryParams = await params(provider, store, [storedDocumentMessage()], caller.signal)
		const pending = drainQuery({
			...queryParams,
			onContextCreated,
			projectInstructionContext: {
				prepareInitialSnapshot: () => {
					markPreparationStarted()
					return heldPreparation
				},
				observeToolResult: () => undefined,
			},
		})

		await preparationStarted
		caller.abort(new TurnCancelled('user'))
		const run = await pending
		releasePreparation(undefined)

		expect(onContextCreated).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
	})

	it('does not render host prompt contributions after attachment cancellation', async () => {
		let markStoreStarted!: () => void
		const storeStarted = new Promise<void>((resolve) => {
			markStoreStarted = resolve
		})
		let releaseStore!: (bytes: StoredBytes) => void
		const heldStore = new Promise<StoredBytes>((resolve) => {
			releaseStore = resolve
		})
		const store: AttachmentStore = {
			put: async () => 'unused',
			get: () => {
				markStoreStarted()
				return heldStore
			},
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		const sentinel = new Error('prompt contribution must not replace cancellation')
		const render = vi.fn(() => {
			throw sentinel
		})
		const promptContributions = new PromptContributionRegistry()
		promptContributions.register({
			id: 'test.throwing',
			placement: 'static',
			render,
		})
		const input = storedDocumentMessage()
		const queryParams = await params(provider, store, [input], caller.signal)
		const pending = drainQuery({ ...queryParams, promptContributions })

		await storeStarted
		caller.abort(new TurnCancelled('user'))
		const run = await pending
		releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })

		expect(render).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(run.messages).toContainEqual(input)
	})

	it('does not prepare project instructions after attachment cancellation', async () => {
		let markStoreStarted!: () => void
		const storeStarted = new Promise<void>((resolve) => {
			markStoreStarted = resolve
		})
		let releaseStore!: (bytes: StoredBytes) => void
		const heldStore = new Promise<StoredBytes>((resolve) => {
			releaseStore = resolve
		})
		const store: AttachmentStore = {
			put: async () => 'unused',
			get: () => {
				markStoreStarted()
				return heldStore
			},
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		const sentinel = new Error('project preparation must not replace cancellation')
		const prepareInitialSnapshot = vi.fn(() => {
			throw sentinel
		})
		const input = storedDocumentMessage()
		const queryParams = await params(provider, store, [input], caller.signal)
		const pending = drainQuery({
			...queryParams,
			projectInstructionContext: {
				prepareInitialSnapshot,
				observeToolResult: () => undefined,
			},
		})

		await storeStarted
		caller.abort(new TurnCancelled('user'))
		const run = await pending
		releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })

		expect(prepareInitialSnapshot).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(run.messages).toContainEqual(input)
	})

	it('preserves checkpoint history when a queued attachment is cancelled on resume', async () => {
		const { started } = recordSpanParents()
		const priorUser = createUserMessage('history before the process stopped')
		const priorAssistant = createAssistantMessage('durable answer before resume')
		const tokenUsage = {
			promptTokens: 17,
			completionTokens: 5,
			totalTokens: 22,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const traceContext = {
			traceId: 'a'.repeat(32),
			spanId: 'b'.repeat(16),
			traceFlags: 1,
			isRemote: true,
		}
		const session = await sessionWithCheckpoint({
			messages: [priorUser, priorAssistant],
			document: {
				tokenUsage,
				costInfo: { totalCost: 0.25, cacheDiscount: 0, unpricedTokens: 0 },
				guards: { iteration: 2, elapsedMs: 4_000 },
				trace: traceContext,
			},
			release: true,
		})
		const ids = { ...TEST_SCOPE, sessionId: session.sessionId }
		const queued = storedDocumentMessage()
		const topicStateStore = new InMemoryTopicStateStore()
		await topicStateStore.setQueuedMessages(ids.topicId, ids.tenantId, [queued], { revision: 0 })
		let markStoreStarted!: () => void
		const storeStarted = new Promise<void>((resolve) => {
			markStoreStarted = resolve
		})
		let releaseStore!: (bytes: StoredBytes) => void
		const heldStore = new Promise<StoredBytes>((resolve) => {
			releaseStore = resolve
		})
		const attachmentStore: AttachmentStore = {
			put: async () => 'unused',
			get: () => {
				markStoreStarted()
				return heldStore
			},
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		const pending = resumeSession({
			scope: { ...ids, turnId: session.turnId },
			sessionLog: session.log,
			checkpointStore: session.store,
			provider,
			toolsets: [],
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 4,
			},
			agentId: 'attachment-cancellation-resume',
			agentName: 'Attachment cancellation resume',
			workingDirectory: await workingDirectory(),
			...ids,
			resumeHandler: async () => ({ action: 'continue' }),
			topicStateStore,
			attachmentStore,
			signal: caller.signal,
		})

		await storeStarted
		caller.abort(new TurnCancelled('user'))
		const outcome = await pending
		releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(provider.requests).toHaveLength(0)
		expect(outcome.turn.status).toBe('cancelled')
		expect(outcome.turn.messages).toContainEqual(matchingMessage(priorUser))
		expect(outcome.turn.messages).toContainEqual(matchingMessage(priorAssistant))
		expect(outcome.turn.messages).toContainEqual(queued)
		expect(outcome.turn.tokenUsage).toEqual(tokenUsage)
		const turnSpan = started.find((entry) => entry.name.startsWith('namzu.agent.turn '))
		expect(turnSpan?.parent?.spanContext()).toMatchObject({
			traceId: traceContext.traceId,
			spanId: traceContext.spanId,
		})
		const persisted = (await readFoldedHistory(session.log)).map((entry) => entry.message)
		expect(persisted).toContainEqual(matchingMessage(priorUser))
		expect(persisted).toContainEqual(matchingMessage(priorAssistant))
		expect(persisted).toContainEqual(queued)
	})

	it('does not reread the selected checkpoint after resume cancellation', async () => {
		const prior = createUserMessage('selected checkpoint history')
		const tokenUsage = {
			promptTokens: 23,
			completionTokens: 7,
			totalTokens: 30,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const session = await sessionWithCheckpoint({
			messages: [prior],
			document: {
				iteration: 3,
				tokenUsage,
				costInfo: { totalCost: 0.5, cacheDiscount: 0, unpricedTokens: 0 },
				guards: { iteration: 3, elapsedMs: 6_000 },
			},
		})
		const ids = { ...TEST_SCOPE, sessionId: session.sessionId }
		// The worker still holds the session: every record the resumed turn
		// writes carries the same fence as what the consumer already saw.
		const lease = session.lease
		const cursorSeq = (await session.log.head())?.pointer.seq ?? 0
		await session.log.append(lease, {
			type: 'approval_policy_changed',
			turnId: session.turnId,
			from: 'historical-policy',
			to: 'replacement-policy',
			reason: 'persisted before reconnect',
		} as Parameters<SessionLog['append']>[1])
		// Reads of a checkpoint after the selection has been made: a resume
		// that has already chosen its checkpoint must not go back for it.
		let selected = false
		let rereads = 0
		const checkpointStore: SessionCheckpointStore = {
			write: (scope, checkpoint) => session.store.write(scope, checkpoint),
			read: async (scope, id) => {
				if (selected) rereads++
				return session.store.read(scope, id)
			},
			restore: async (scope, id) => {
				if (selected) rereads++
				return session.store.restore(scope, id)
			},
			list: (scope) => session.store.list(scope),
			delete: (scope, id) => session.store.delete(scope, id),
			prune: (scope, keepLast) => session.store.prune(scope, keepLast),
		}
		const queued = storedDocumentMessage()
		const topicStateStore = new InMemoryTopicStateStore()
		await topicStateStore.setQueuedMessages(ids.topicId, ids.tenantId, [queued], { revision: 0 })
		let markStoreStarted!: () => void
		const storeStarted = new Promise<void>((resolve) => {
			markStoreStarted = resolve
		})
		let releaseStore!: (bytes: StoredBytes) => void
		const heldStore = new Promise<StoredBytes>((resolve) => {
			releaseStore = resolve
		})
		const attachmentStore: AttachmentStore = {
			put: async () => 'unused',
			get: () => {
				selected = true
				markStoreStarted()
				return heldStore
			},
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const events: SessionEvent[] = []
		const caller = new AbortController()
		const pending = resumeSession({
			scope: { ...ids, turnId: session.turnId },
			sessionLog: session.log,
			checkpointStore,
			lease,
			provider,
			toolsets: [],
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 4,
			},
			agentId: 'attachment-selected-resume',
			agentName: 'Attachment selected resume',
			workingDirectory: await workingDirectory(),
			...ids,
			resumeHandler: async () => ({ action: 'continue' }),
			topicStateStore,
			attachmentStore,
			eventCursor: { sinceSeq: cursorSeq, generation: lease.fence as FencingToken },
			listener: (event) => {
				events.push(event)
			},
			signal: caller.signal,
		})

		await storeStarted
		caller.abort(new TurnCancelled('user'))
		// No real 250ms safety race: see the fix above at the top of this
		// file for why racing it against the cancellation work it waited on
		// was the flaky part, not the mechanism.
		let result: Awaited<typeof pending>
		try {
			result = await pending
		} finally {
			releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })
		}

		expect(rereads).toBe(0)
		expect(provider.requests).toHaveLength(0)
		expect(result.resumed).toBe(true)
		if (!result.resumed) return
		expect(result.turn.status).toBe('cancelled')
		expect(result.turn.messages).toContainEqual(matchingMessage(prior))
		expect(result.turn.messages).toContainEqual(queued)
		expect(result.turn.tokenUsage).toEqual(tokenUsage)
		expect(result.replay?.status).toBe('replayed')
		if (result.replay?.status === 'replayed') {
			expect(result.replay.records.map((record) => record.type)).toEqual([
				'approval_policy_changed',
			])
		}
		expect(events[0]?.type).toBe('approval_policy_changed')
		const lifecycle = events.filter((event) =>
			['turn_resuming', 'turn_started', 'turn_completed'].includes(event.type),
		)
		expect(lifecycle.map((event) => event.type)).toEqual(['turn_resuming', 'turn_completed'])
		expect(lifecycle.every((event) => event.generation === lease.fence)).toBe(true)
		const recorded = (await records(session.log)).filter((record) =>
			['turn_resuming', 'turn_completed'].includes(record.type),
		)
		expect(recorded.map((record) => record.type)).toEqual(['turn_resuming', 'turn_completed'])
		expect(recorded.every((record) => record.gen === lease.fence)).toBe(true)
	})

	it('keeps cancellation authoritative when replay notification throws', async () => {
		const { ended } = recordSpanParents()
		const checkpointUser = createUserMessage('durable history before reconnect')
		const checkpointAssistant = createAssistantMessage('durable answer before reconnect')
		const checkpointUsage = {
			promptTokens: 4,
			completionTokens: 2,
			totalTokens: 6,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const session = await sessionWithCheckpoint({
			messages: [checkpointUser, checkpointAssistant],
			document: {
				iteration: 1,
				tokenUsage: checkpointUsage,
				guards: { iteration: 1, elapsedMs: 100 },
			},
		})
		const ids = { ...TEST_SCOPE, sessionId: session.sessionId }
		const cursorSeq = (await session.log.head())?.pointer.seq ?? 0
		await session.log.append(session.lease, {
			type: 'approval_policy_changed',
			turnId: session.turnId,
			from: 'historical-policy',
			to: 'replacement-policy',
			reason: 'persisted before reconnect',
		} as Parameters<SessionLog['append']>[1])
		await session.log.release(session.lease)
		const queued = storedDocumentMessage()
		const topicStateStore = new InMemoryTopicStateStore()
		await topicStateStore.setQueuedMessages(ids.topicId, ids.tenantId, [queued], { revision: 0 })
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		caller.abort(new TurnCancelled('user'))
		const replayFailure = new Error('host replay observer failed')
		let replayCallbacks = 0
		let rejectReplay!: (error: Error) => void
		const heldReplay = new Promise<void>((_resolve, reject) => {
			rejectReplay = reject
		})
		const unhandledRejections: unknown[] = []
		const recordUnhandledRejection = (reason: unknown): void => {
			unhandledRejections.push(reason)
		}
		process.on('unhandledRejection', recordUnhandledRejection)
		const events: SessionEvent[] = []

		const pending = resumeSession({
			scope: { ...ids, turnId: session.turnId },
			sessionLog: session.log,
			checkpointStore: session.store,
			provider,
			toolsets: [],
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 2,
			},
			agentId: 'attachment-replay-callback',
			agentName: 'Attachment replay callback',
			workingDirectory: await workingDirectory(),
			...ids,
			resumeHandler: async () => ({ action: 'continue' }),
			topicStateStore,
			eventCursor: { sinceSeq: cursorSeq },
			onEventReplay: () => {
				replayCallbacks++
				return heldReplay
			},
			listener: (event) => {
				events.push(event)
			},
			signal: caller.signal,
		})
		// No real 250ms safety race: see the fix at the top of this file for
		// why racing it against the cancellation work it waited on was the
		// flaky part, not the mechanism. `rejectReplay` unconditionally
		// settling `heldReplay` in `finally` is what used to make the safety
		// branch reachable at all; now it just guarantees the observer's
		// promise is never left dangling, whichever way `pending` settles.
		let result: Awaited<typeof pending>
		try {
			result = await pending
		} finally {
			rejectReplay(replayFailure)
		}
		await new Promise<void>((resolve) => setImmediate(resolve))
		process.off('unhandledRejection', recordUnhandledRejection)

		expect(replayCallbacks).toBe(1)
		expect(unhandledRejections).toEqual([])
		expect(result.resumed).toBe(true)
		if (!result.resumed) return
		expect(provider.requests).toHaveLength(0)
		expect(result.turn.status).toBe('cancelled')
		expect(result.turn.stopReason).toBe('cancelled')
		expect(result.replay?.status).toBe('replayed')
		expect(result.turn.messages).toContainEqual(matchingMessage(checkpointUser))
		expect(result.turn.messages).toContainEqual(matchingMessage(checkpointAssistant))
		expect(result.turn.messages).toContainEqual(queued)
		expect(result.turn.tokenUsage).toEqual(checkpointUsage)
		const persistedMessages = (await readFoldedHistory(session.log)).map((entry) => entry.message)
		expect(persistedMessages).toContainEqual(matchingMessage(checkpointUser))
		expect(persistedMessages).toContainEqual(matchingMessage(checkpointAssistant))
		expect(persistedMessages).toContainEqual(queued)
		const lifecycle = ['approval_policy_changed', 'turn_resuming', 'turn_completed']
		expect(events.map((event) => event.type).filter((type) => lifecycle.includes(type))).toEqual(
			lifecycle,
		)
		const persisted = (await records(session.log)).filter((record) =>
			lifecycle.includes(record.type),
		)
		expect(persisted.map((record) => record.type)).toEqual(lifecycle)
		expect(persisted).toContainEqual(
			expect.objectContaining({ type: 'turn_completed', stopReason: 'cancelled' }),
		)
		expect(ended).toHaveLength(1)
	})
})
