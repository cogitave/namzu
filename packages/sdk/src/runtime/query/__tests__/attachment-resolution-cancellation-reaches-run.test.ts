import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context, type Span, type Tracer, trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type {
	AttachmentOperationOptions,
	AttachmentStore,
	StoredBytes,
} from '../../../store/attachment/index.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { InMemoryTopicStateStore } from '../../../store/topic/state.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import {
	type Message,
	type MessageAttachment,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { RunCancelled } from '../../../types/run/cancel-cause.js'
import type { CheckpointStore, FencingToken } from '../../../types/run/checkpoint-store.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { resumeRun } from '../resume-run.js'

const dirs: string[] = []

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
		sessionId: 'ses_attachment_cancel' as SessionId,
		topicId: 'top_attachment_cancel' as TopicId,
		projectId: 'prj_attachment_cancel' as ProjectId,
		tenantId: 'tnt_attachment_cancel' as TenantId,
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
		tools: new ToolRegistry(),
		messages: [...messages],
		...(attachmentStore ? { attachmentStore } : {}),
		workingDirectory: await workingDirectory(),
		runConfig: {
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

describe('stored attachment resolution belongs to the run', () => {
	it('lets withdrawn authority outrank a missing attachment store', async () => {
		const reason = new RunCancelled('user')
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
		caller.abort(new RunCancelled('user'))
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
		const reason = new RunCancelled('user')
		caller.abort(reason)
		const safety = Symbol('attachment resolution ignored cancellation')
		let timer: ReturnType<typeof setTimeout> | undefined
		const outcome = await Promise.race([
			pending,
			new Promise<typeof safety>((resolve) => {
				timer = setTimeout(() => resolve(safety), 250)
			}),
		])
		if (timer) clearTimeout(timer)

		try {
			expect(outcome).not.toBe(safety)
		} finally {
			// A broken implementation is released only after the bounded observer
			// has its answer, so the test fails rather than leaving a live query.
			release({ data: 'late-pdf', mediaType: 'application/pdf' })
			if (outcome === safety) await pending
		}
		if (outcome === safety) return

		expect(storeOptions?.signal).toBe(caller.signal)
		expect(storeOptions?.signal?.aborted).toBe(true)
		expect(storeOptions?.signal?.reason).toBe(reason)
		expect(provider.requests).toHaveLength(0)
		expect(outcome.status).toBe('cancelled')
		expect(outcome.stopReason).toBe('cancelled')
		const persistedInput = outcome.messages.find((message) => message.role === 'user')
		expect(persistedInput).toEqual(input)

		// Releasing a non-cooperative backend after the run settled cannot
		// publish its bytes or start a provider request.
		await Promise.resolve()
		expect(provider.requests).toHaveLength(0)
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
		caller.abort(new RunCancelled('user'))
		const safety = Symbol('cancelled run entered a non-cooperative guardrail')
		let timer: ReturnType<typeof setTimeout> | undefined
		const outcome = await Promise.race([
			pending,
			new Promise<typeof safety>((resolve) => {
				timer = setTimeout(() => resolve(safety), 250)
			}),
		])
		if (timer) clearTimeout(timer)

		try {
			expect(outcome).not.toBe(safety)
		} finally {
			releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })
			releaseGuardrail({ action: 'pass' })
			if (outcome === safety) await pending
		}
		if (outcome === safety) return

		expect(inputGuardrail).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(outcome.status).toBe('cancelled')
		expect(outcome.stopReason).toBe('cancelled')
	})

	it('does not hand a run context back after project preparation cancellation', async () => {
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
		caller.abort(new RunCancelled('user'))
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
		caller.abort(new RunCancelled('user'))
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
		caller.abort(new RunCancelled('user'))
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
		const ids = identity()
		const runId = 'run_attachment_cancel_resume' as RunId
		const checkpointId = 'ckpt_attachment_cancel_resume' as CheckpointId
		const scope = { ...ids, runId }
		const priorUser = createUserMessage('history before the process stopped')
		const priorAssistant = createAssistantMessage('durable answer before resume')
		const checkpointStore = new InMemoryCheckpointStore()
		const checkpoint: IterationCheckpoint = {
			id: checkpointId,
			runId,
			iteration: 2,
			messages: [priorUser, priorAssistant],
			tokenUsage: {
				promptTokens: 17,
				completionTokens: 5,
				totalTokens: 22,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			costInfo: {
				inputCostPer1M: 0,
				outputCostPer1M: 0,
				totalCost: 0.25,
				cacheDiscount: 0,
				unpricedTokens: 0,
			},
			guardState: { iterationCount: 2, elapsedMs: 4_000 },
			traceContext: {
				traceId: 'a'.repeat(32),
				spanId: 'b'.repeat(16),
				traceFlags: 1,
				isRemote: true,
			},
			createdAt: Date.now(),
		}
		await checkpointStore.writeCheckpoint(scope, checkpoint)
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
		const runStore = new InMemoryRunStore()
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		const pending = resumeRun({
			scope,
			checkpointStore,
			provider,
			tools: new ToolRegistry(),
			runConfig: {
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
			runStore,
			signal: caller.signal,
		})

		await storeStarted
		caller.abort(new RunCancelled('user'))
		const outcome = await pending
		releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(provider.requests).toHaveLength(0)
		expect(outcome.run.status).toBe('cancelled')
		expect(outcome.run.messages).toContainEqual(priorUser)
		expect(outcome.run.messages).toContainEqual(priorAssistant)
		expect(outcome.run.messages).toContainEqual(queued)
		expect(outcome.run.tokenUsage).toEqual(checkpoint.tokenUsage)
		const runSpan = started.find((entry) => entry.name.startsWith('namzu.agent.run '))
		expect(runSpan?.parent?.spanContext()).toMatchObject({
			traceId: checkpoint.traceContext?.traceId,
			spanId: checkpoint.traceContext?.spanId,
		})
		const persisted = await runStore.readMessages()
		expect(persisted.kind).toBe('available')
		if (persisted.kind !== 'available') return
		expect(persisted.messages).toContainEqual(priorUser)
		expect(persisted.messages).toContainEqual(priorAssistant)
		expect(persisted.messages).toContainEqual(queued)
	})

	it('does not reread the selected checkpoint after resume cancellation', async () => {
		const ids = identity()
		const runId = 'run_attachment_cancel_selected' as RunId
		const checkpointId = 'ckpt_attachment_cancel_selected' as CheckpointId
		const scope = { ...ids, runId }
		const prior = createUserMessage('selected checkpoint history')
		const checkpoint: IterationCheckpoint = {
			id: checkpointId,
			runId,
			iteration: 3,
			messages: [prior],
			tokenUsage: {
				promptTokens: 23,
				completionTokens: 7,
				totalTokens: 30,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			costInfo: {
				inputCostPer1M: 0,
				outputCostPer1M: 0,
				totalCost: 0.5,
				cacheDiscount: 0,
				unpricedTokens: 0,
			},
			guardState: { iterationCount: 3, elapsedMs: 6_000 },
			createdAt: Date.now(),
		}
		let releaseCheckpointRead!: (value: IterationCheckpoint | null) => void
		const heldCheckpointRead = new Promise<IterationCheckpoint | null>((resolve) => {
			releaseCheckpointRead = resolve
		})
		const readCheckpoint = vi.fn(() => heldCheckpointRead)
		const checkpointStore: CheckpointStore = {
			writeCheckpoint: async () => undefined,
			readCheckpoint,
			listCheckpoints: async () => [checkpoint],
			deleteCheckpoint: async () => undefined,
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
				markStoreStarted()
				return heldStore
			},
		}
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const runStore = new InMemoryRunStore()
		await runStore.initRun(runId)
		await runStore.appendEvent({
			type: 'approval_policy_changed',
			runId,
			from: 'historical-policy',
			to: 'replacement-policy',
			reason: 'persisted before reconnect',
			generation: 9 as FencingToken,
		})
		const events: RunEvent[] = []
		const caller = new AbortController()
		const pending = resumeRun({
			scope,
			checkpointStore,
			provider,
			tools: new ToolRegistry(),
			runConfig: {
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
			runStore,
			claimFence: 9 as FencingToken,
			eventCursor: { sinceSeq: 0, generation: 9 as FencingToken },
			listener: (event) => {
				events.push(event)
			},
			signal: caller.signal,
		})

		await storeStarted
		caller.abort(new RunCancelled('user'))
		const safety = Symbol('resume reread its checkpoint after cancellation')
		let timer: ReturnType<typeof setTimeout> | undefined
		const result = await Promise.race([
			pending,
			new Promise<typeof safety>((resolve) => {
				timer = setTimeout(() => resolve(safety), 250)
			}),
		])
		if (timer) clearTimeout(timer)

		try {
			expect(result).not.toBe(safety)
		} finally {
			releaseStore({ data: 'late-pdf', mediaType: 'application/pdf' })
			releaseCheckpointRead(checkpoint)
			if (result === safety) await pending
		}
		if (result === safety) return

		expect(readCheckpoint).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(result.resumed).toBe(true)
		if (!result.resumed) return
		expect(result.run.status).toBe('cancelled')
		expect(result.run.messages).toContainEqual(prior)
		expect(result.run.messages).toContainEqual(queued)
		expect(result.run.tokenUsage).toEqual(checkpoint.tokenUsage)
		expect(result.replay?.status).toBe('replayed')
		if (result.replay?.status === 'replayed') {
			expect(result.replay.events.map((event) => event.type)).toEqual(['approval_policy_changed'])
		}
		expect(events[0]?.type).toBe('approval_policy_changed')
		const terminalEvents = events.filter((event) =>
			['run_resuming', 'run_started', 'run_completed'].includes(event.type),
		)
		expect(terminalEvents.map((event) => event.type)).toEqual([
			'run_resuming',
			'run_started',
			'run_completed',
		])
		expect(terminalEvents.every((event) => event.generation === 9)).toBe(true)
		const persistedEvents = await runStore.readEvents()
		const persistedTerminal = persistedEvents.filter((event) =>
			['run_resuming', 'run_started', 'run_completed'].includes(event.type),
		)
		expect(persistedTerminal.every((event) => event.generation === 9)).toBe(true)
	})

	it('keeps cancellation authoritative when replay notification throws', async () => {
		const { ended } = recordSpanParents()
		const ids = identity()
		const runId = 'run_attachment_cancel_replay_callback' as RunId
		const checkpointId = 'ckpt_attachment_cancel_replay_callback' as CheckpointId
		const scope = { ...ids, runId }
		const checkpointStore = new InMemoryCheckpointStore()
		const checkpointUser = createUserMessage('durable history before reconnect')
		const checkpointAssistant = createAssistantMessage('durable answer before reconnect')
		const checkpointUsage = {
			promptTokens: 4,
			completionTokens: 2,
			totalTokens: 6,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		await checkpointStore.writeCheckpoint(scope, {
			id: checkpointId,
			runId,
			iteration: 1,
			messages: [checkpointUser, checkpointAssistant],
			tokenUsage: checkpointUsage,
			costInfo: {
				inputCostPer1M: 0,
				outputCostPer1M: 0,
				totalCost: 0,
				cacheDiscount: 0,
				unpricedTokens: 0,
			},
			guardState: { iterationCount: 1, elapsedMs: 100 },
			createdAt: Date.now(),
		})
		const queued = storedDocumentMessage()
		const topicStateStore = new InMemoryTopicStateStore()
		await topicStateStore.setQueuedMessages(ids.topicId, ids.tenantId, [queued], { revision: 0 })
		const runStore = new InMemoryRunStore()
		await runStore.initRun(runId)
		await runStore.appendEvent({
			type: 'approval_policy_changed',
			runId,
			from: 'historical-policy',
			to: 'replacement-policy',
			reason: 'persisted before reconnect',
		})
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const caller = new AbortController()
		caller.abort(new RunCancelled('user'))
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
		const events: RunEvent[] = []

		const pending = resumeRun({
			scope,
			checkpointStore,
			provider,
			tools: new ToolRegistry(),
			runConfig: {
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
			runStore,
			eventCursor: { sinceSeq: 0 },
			onEventReplay: () => {
				replayCallbacks++
				return heldReplay
			},
			listener: (event) => {
				events.push(event)
			},
			signal: caller.signal,
		})
		const safety = Symbol('replay observer pinned the cancelled run')
		let timer: ReturnType<typeof setTimeout> | undefined
		const result = await Promise.race([
			pending,
			new Promise<typeof safety>((resolve) => {
				timer = setTimeout(() => resolve(safety), 250)
			}),
		])
		if (timer) clearTimeout(timer)
		rejectReplay(replayFailure)
		if (result === safety) await pending
		await new Promise<void>((resolve) => setImmediate(resolve))
		process.off('unhandledRejection', recordUnhandledRejection)

		expect(result).not.toBe(safety)
		if (result === safety) return
		expect(replayCallbacks).toBe(1)
		expect(unhandledRejections).toEqual([])
		expect(result.resumed).toBe(true)
		if (!result.resumed) return
		expect(provider.requests).toHaveLength(0)
		expect(result.run.status).toBe('cancelled')
		expect(result.run.stopReason).toBe('cancelled')
		expect(result.replay?.status).toBe('replayed')
		expect(result.run.messages).toContainEqual(checkpointUser)
		expect(result.run.messages).toContainEqual(checkpointAssistant)
		expect(result.run.messages).toContainEqual(queued)
		expect(result.run.tokenUsage).toEqual(checkpointUsage)
		const persistedMessages = await runStore.readMessages()
		expect(persistedMessages.kind).toBe('available')
		if (persistedMessages.kind === 'available') {
			expect(persistedMessages.messages).toContainEqual(checkpointUser)
			expect(persistedMessages.messages).toContainEqual(checkpointAssistant)
			expect(persistedMessages.messages).toContainEqual(queued)
		}
		const persisted = await runStore.readEvents()
		expect(events.map((event) => event.type)).toEqual([
			'approval_policy_changed',
			'run_resuming',
			'run_started',
			'run_completed',
		])
		expect(persisted.map((event) => event.type)).toEqual([
			'approval_policy_changed',
			'run_resuming',
			'run_started',
			'run_completed',
		])
		expect(persisted).toContainEqual(
			expect.objectContaining({ type: 'run_completed', stopReason: 'cancelled' }),
		)
		expect(ended).toHaveLength(1)
	})
})
