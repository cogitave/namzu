import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { TurnRecorder } from '../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { InMemorySessionTokenBudgetStore } from '../../store/budget/index.js'
import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import { InMemoryTopicStateStore } from '../../store/topic/index.js'
import { testToolset } from '../../test-support/toolset.js'
import type {
	HarnessAdapter,
	HarnessBinding,
	HarnessConnection,
	HarnessEvent,
	HarnessEventSink,
	HarnessHistorySnapshot,
	HarnessNativeTurn,
	HarnessPrompt,
	HarnessReviewRequest,
	HarnessScope,
	HarnessSession,
	HarnessSessionOptions,
} from '../../types/harness/session.js'
import { autoApproveHandler } from '../../types/hitl/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { SessionEvent } from '../../types/session/events.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../utils/id.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { drainQuery } from '../query/index.js'
import { resumeSession } from '../query/resume-session.js'
import { createHarnessSession } from './index.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const sessions: HarnessSession[] = []
afterEach(async () => {
	for (const session of sessions.splice(0))
		if (session.status !== 'closed') await session.close().catch(() => undefined)
	vi.useRealTimers()
})
function fixture() {
	const scope: HarnessScope = {
		sessionId: generateSessionId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		cwd: '/owned/project',
	}
	const log = new InMemorySessionLog({ sessionId: scope.sessionId })
	const binding: HarnessBinding = {
		v: 1,
		engineId: 'fixture-engine',
		profileRef: 'owned-profile',
		nativeSessionId: 'native-thread',
		cwd: scope.cwd,
		initialModel: 'native-model',
	}
	const native: HarnessNativeTurn = {
		nativeSessionId: binding.nativeSessionId,
		nativeTurnId: 'native-turn',
	}
	let sink!: HarnessEventSink
	const dispatched = deferred<HarnessPrompt>()
	const events: SessionEvent[] = []
	const reviews: HarnessReviewRequest[] = []
	const connection: HarnessConnection = {
		binding,
		capabilities: {
			persistentSessions: true,
			history: 'snapshot',
			models: 'configured',
			permissions: 'interactive',
			interrupt: 'native-terminal',
			attachments: [],
			reviewModes: ['prompt', 'plan'],
		},
		models: vi.fn(async () => [{ id: 'native-model', label: 'Native model' }]),
		dispatch: vi.fn(async (input) => {
			dispatched.resolve(input)
			return native
		}),
		interrupt: vi.fn(async () => ({ requested: true as const })),
		respond: vi.fn(async () => ({ sent: true as const })),
		readHistory: vi.fn(
			async (): Promise<HarnessHistorySnapshot> => ({
				binding,
				events: [],
				pendingReviews: [],
				complete: true,
			}),
		),
		close: vi.fn(async () => ({ stopped: true as const })),
	}
	const adapter: HarnessAdapter = {
		engineId: binding.engineId,
		profileRef: binding.profileRef,
		open: vi.fn(async (_input, listener) => {
			sink = listener
			return connection
		}),
	}
	const authorize = vi.fn<HarnessSessionOptions['assertAdmission']>(async () => undefined)
	const make = () => {
		const session = createHarnessSession({
			scope,
			sessionLog: log,
			adapter,
			assertAdmission: authorize,
			onEvent: (e) => {
				events.push(e)
			},
			onReview: (r) => {
				reviews.push(r)
			},
		})
		sessions.push(session)
		return session
	}
	const session = make()
	return {
		scope,
		log,
		binding,
		native,
		connection,
		adapter,
		authorize,
		session,
		make,
		dispatched,
		events,
		reviews,
		emit: (event: HarnessEvent) => sink(event),
		prompt: {
			prompt: 'A real authored prompt',
			model: 'native-model',
			permissionMode: 'prompt' as const,
		},
	}
}
async function answer(f: ReturnType<typeof fixture>, id = 'native-answer', text = 'The answer') {
	await f.emit({ kind: 'message-started', ...f.native, nativeItemId: id })
	await f.emit({ kind: 'text-delta', ...f.native, nativeItemId: id, text: 'draft text' })
	await f.emit({
		kind: 'message-completed',
		...f.native,
		nativeItemId: id,
		content: text,
		stopReason: 'end_turn',
	})
}
async function complete(f: ReturnType<typeof fixture>, finalItemId = 'native-answer') {
	await f.emit({ kind: 'turn-completed', ...f.native, finalItemId, status: 'completed' })
}

describe('durable external harness sessions', () => {
	it('refuses kernel query before provider, tools, budget, queue or writer work while external history remains readable', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await answer(f)
		await complete(f)
		const completed = await run
		await f.session.close()
		const before = await f.log.readAll()
		const claim = vi.spyOn(f.log, 'claim')
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'effect', args: {} }] }, { text: 'must not run' }],
		})
		const execute = vi.fn(async () => ({ success: true, output: 'must not execute' }))
		const budgetStore = new InMemorySessionTokenBudgetStore()
		const loadBudget = vi.spyOn(budgetStore, 'load')
		const topicStore = new InMemoryTopicStateStore()
		await topicStore.setQueuedMessages(
			f.scope.topicId,
			f.scope.tenantId,
			[createUserMessage('queued')],
			{ revision: 0 },
		)
		const readTopic = vi.spyOn(topicStore, 'getState')
		await expect(
			drainQuery({
				...f.scope,
				workingDirectory: f.scope.cwd,
				sessionLog: f.log,
				provider,
				resumeHandler: autoApproveHandler,
				toolsets: [
					testToolset({
						name: 'effect',
						description: 'An actual tool effect',
						inputSchema: z.object({}),
						execute,
					}),
				],
				turnConfig: { model: 'mock-model', timeoutMs: 5000, tokenBudget: 1000 },
				agentId: 'kernel',
				agentName: 'Kernel',
				messages: [createUserMessage('A newly authored kernel prompt')],
				tokenBudgetStore: budgetStore,
				topicStateStore: topicStore,
			}),
		).rejects.toMatchObject({ code: 'invalid_config', details: { fields: ['harness'] } })
		expect(provider.requests).toHaveLength(0)
		expect(execute).not.toHaveBeenCalled()
		expect(loadBudget).not.toHaveBeenCalled()
		expect(readTopic).not.toHaveBeenCalled()
		expect(claim).not.toHaveBeenCalled()
		expect(await f.log.readAll()).toEqual(before)
		const reopened = f.make()
		expect(await reopened.history()).toEqual(completed.messages)
		expect(f.adapter.open).toHaveBeenCalledTimes(1)
		expect(f.connection.dispatch).toHaveBeenCalledTimes(1)
	})
	it.each(['query', 'recorder'] as const)(
		'rechecks external binding under the writer after an empty %s preflight and releases its lease',
		async (entry) => {
			const f = fixture()
			const run = f.session.run(f.prompt)
			await f.dispatched.promise
			await answer(f)
			await complete(f)
			await run
			await f.session.close()
			const before = await f.log.medium.size()
			const readAll = f.log.readAll.bind(f.log)
			vi.spyOn(f.log, 'readAll')
				.mockResolvedValueOnce({
					entries: [],
					intact: true,
					throughSeq: 0,
					head: null,
					tornBytes: 0,
				})
				.mockImplementation(readAll)
			const provider = new MockLLMProvider({ responseText: 'must not run' })
			const config = {
				...f.scope,
				turnId: generateTurnId(),
				sessionLog: f.log,
				agentId: 'kernel',
				agentName: 'Kernel',
				turnConfig: { model: 'mock-model', timeoutMs: 5000, tokenBudget: 1000 },
			}
			const attempt =
				entry === 'query'
					? drainQuery({
							...config,
							workingDirectory: f.scope.cwd,
							provider,
							toolsets: [],
							resumeHandler: autoApproveHandler,
							messages: [createUserMessage('new kernel prompt')],
						})
					: new TurnRecorder({ ...config, providerId: provider.id, log: NOOP_LOGGER }).open({
							session: { cwd: f.scope.cwd },
						})
			await expect(attempt).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: ['harness'] },
			})
			expect(provider.requests).toHaveLength(0)
			expect(await f.log.medium.size()).toBe(before)
			const next = await f.log.claim({ holder: 'next writer', ttlMs: 60000 })
			expect(next).not.toBeNull()
			if (next) await f.log.release(next)
		},
	)
	it('refuses kernel resume before checkpoint access and direct recorder before claiming an external journal', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await answer(f)
		await complete(f)
		const completed = await run
		await f.session.close()
		const before = await f.log.medium.size()
		const claim = vi.spyOn(f.log, 'claim')
		const list = vi.fn()
		const restore = vi.fn()
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const config = {
			...f.scope,
			sessionLog: f.log,
			agentId: 'kernel',
			agentName: 'Kernel',
			turnConfig: { model: 'mock-model', timeoutMs: 5000, tokenBudget: 1000 },
		}
		await expect(
			resumeSession({
				...config,
				provider,
				toolsets: [],
				resumeHandler: autoApproveHandler,
				workingDirectory: f.scope.cwd,
				scope: { ...f.scope, turnId: completed.turnId },
				checkpointStore: { list, restore } as unknown as SessionCheckpointStore,
			}),
		).rejects.toMatchObject({ code: 'invalid_config', details: { fields: ['harness'] } })
		await expect(
			new TurnRecorder({
				...config,
				turnId: generateTurnId(),
				providerId: provider.id,
				log: NOOP_LOGGER,
			}).open({ session: { cwd: f.scope.cwd } }),
		).rejects.toMatchObject({ code: 'invalid_config', details: { fields: ['harness'] } })
		expect(provider.requests).toHaveLength(0)
		expect(list).not.toHaveBeenCalled()
		expect(restore).not.toHaveBeenCalled()
		expect(claim).not.toHaveBeenCalled()
		expect(await f.log.medium.size()).toBe(before)
	})
	it('records owned binding, authored prompt and operation before native dispatch; live and durable answer IDs match', async () => {
		const f = fixture()
		vi.mocked(f.connection.dispatch).mockImplementation(async (input) => {
			const records = (await f.log.readAll()).entries.map((e) => e.record)
			expect(records[0]).toMatchObject({ type: 'session_started', harness: f.binding })
			expect(records.find((r) => r.type === 'message')).toMatchObject({
				role: 'user',
				content: { content: f.prompt.prompt },
			})
			expect(records.at(-1)).toMatchObject({
				type: 'session_updated',
				harness: { kind: 'dispatch-prepared', operationId: input.operationId },
			})
			f.dispatched.resolve(input)
			return f.native
		})
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await answer(f)
		await complete(f)
		const result = await run
		expect(result.status).toBe('completed')
		expect(result.messages.map((m) => m.content)).toEqual([f.prompt.prompt, 'The answer'])
		const live = f.events.find((e) => e.type === 'message_completed')
		expect(result.messages[1]?.id).toBe(
			live?.type === 'message_completed' ? live.messageId : undefined,
		)
		expect(
			f.events.some((e) => e.type === 'tool_calls_admitted' || e.type === 'iteration_started'),
		).toBe(false)
	})
	it('preserves two legitimate identical texts with distinct native item identity and applies authoritative correction to one item', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await answer(f, 'commentary', 'same')
		await answer(f, 'native-answer', 'same')
		await f.emit({
			kind: 'message-completed',
			...f.native,
			nativeItemId: 'native-answer',
			content: 'corrected',
			stopReason: 'end_turn',
		})
		await complete(f)
		const messages = (await run).messages
		expect(messages.map((m) => m.content)).toEqual([f.prompt.prompt, 'same', 'corrected'])
		expect(messages[1]?.id).not.toBe(messages[2]?.id)
	})
	it('handles genuine terminal before dispatch acknowledgement without resurrecting the turn', async () => {
		const f = fixture()
		vi.mocked(f.connection.dispatch).mockImplementation(async (input) => {
			f.dispatched.resolve(input)
			await answer(f)
			await complete(f)
			return f.native
		})
		expect((await f.session.run(f.prompt)).status).toBe('completed')
		expect(f.session.status).toBe('idle')
		expect(f.session.currentTurnId).toBeUndefined()
		await f.emit({
			kind: 'text-delta',
			...f.native,
			nativeItemId: 'native-answer',
			text: 'stale tail',
		})
		expect((await f.session.history()).at(-1)?.content).toBe('The answer')
	})
	it('requires current admission before launching or sending and captures host ports instead of mutable options', async () => {
		const f = fixture()
		f.authorize.mockRejectedValue(new Error('denied'))
		await expect(f.session.run(f.prompt)).rejects.toThrow('denied')
		expect(f.adapter.open).not.toHaveBeenCalled()
		expect(f.connection.dispatch).not.toHaveBeenCalled()
		expect((await f.log.readAll()).entries).toHaveLength(0)
	})
	it('refuses foreign attribution and ordinary Namzu journal conversion before claim or launch', async () => {
		const f = fixture()
		const lease = await f.log.claim({ holder: 'seed', ttlMs: 60000 })
		if (!lease) throw new Error('fixture writer missing')
		await f.log.append(lease, {
			type: 'session_started',
			projectId: f.scope.projectId,
			tenantId: f.scope.tenantId,
			topicId: f.scope.topicId,
			cwd: f.scope.cwd,
			agent: { id: 'namzu', name: 'Namzu' },
		})
		await f.log.release(lease)
		const claim = vi.spyOn(f.log, 'claim')
		await expect(f.session.run(f.prompt)).rejects.toThrow('immutable harness')
		expect(claim).not.toHaveBeenCalled()
		expect(f.adapter.open).not.toHaveBeenCalled()
	})
	it('persists exact native review reservation and rejects altered, duplicate and revoked approvals before wire effects', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		const request: HarnessReviewRequest = {
			...f.native,
			requestId: 'request',
			nativeItemId: 'tool',
			kind: 'command',
			title: 'Run command',
			input: { command: 'pwd' },
			decisions: ['approve-once', 'reject'],
		}
		await f.emit({ kind: 'review-requested', request })
		await expect(
			f.session.respond({ ...request, input: { command: 'other' } }, { kind: 'approve-once' }),
		).rejects.toThrow('altered')
		f.authorize.mockRejectedValueOnce(new Error('revoked'))
		await expect(f.session.respond(request, { kind: 'approve-once' })).rejects.toThrow('revoked')
		expect(f.connection.respond).not.toHaveBeenCalled()
		await f.session.respond(request, { kind: 'approve-once' })
		expect(f.connection.respond).toHaveBeenCalledTimes(1)
		expect(f.session.status).toBe('waiting') // send ACK does not mean native resolution
		await expect(f.session.respond(request, { kind: 'approve-once' })).rejects.toThrow(
			'already decided',
		)
		await f.emit({ kind: 'review-resolved', ...f.native, requestId: request.requestId })
		expect(f.session.status).toBe('running')
		await answer(f)
		await complete(f)
		await run
		const transitions = (await f.log.readAll()).entries.flatMap(({ record }) =>
			record.type === 'session_updated' && record.harness ? [record.harness.kind] : [],
		)
		expect(transitions).toContain('review-decided')
		expect(transitions).toContain('review-resolved')
	})
	it('waits for correlated native terminal after Stop ACK; stale Stop cannot cancel next work', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await f.emit({ kind: 'turn-started', ...f.native })
		const turnId = f.session.currentTurnId
		if (!turnId) throw new Error('turn missing')
		const interrupted = deferred<void>()
		vi.mocked(f.connection.interrupt).mockImplementation(async () => {
			interrupted.resolve()
			return { requested: true }
		})
		let settled = false
		const stop = f.session.cancel(turnId).then(() => {
			settled = true
		})
		await interrupted.promise
		expect(settled).toBe(false)
		await f.emit({ kind: 'turn-completed', ...f.native, status: 'cancelled' })
		await stop
		expect((await run).status).toBe('cancelled')
		await expect(f.session.cancel(turnId)).rejects.toThrow('current admitted turn')
	})
	it('never automatically resends an unknown dispatch; incomplete history remains blocked across fresh host', async () => {
		const f = fixture()
		vi.mocked(f.connection.dispatch).mockRejectedValue(new Error('lost ACK'))
		await expect(f.session.run(f.prompt)).rejects.toThrow('lost ACK')
		expect(f.session.status).toBe('reconciliation-required')
		await expect(f.session.run(f.prompt)).rejects.toThrow('must be reconciled')
		await f.session.close()
		const reopened = f.make()
		await expect(reopened.run(f.prompt)).rejects.toThrow('will not be resent')
		expect(f.connection.dispatch).toHaveBeenCalledTimes(1)
		await expect(reopened.reconnect()).rejects.toThrow('unacknowledged dispatch')
	})
	it('reconciles exact complete native history without resending prompt or duplicating durable messages', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await f.emit({ kind: 'turn-started', ...f.native })
		await answer(f)
		await f.emit({ kind: 'connection-lost', code: 'eof', mayBeRunning: true })
		await expect(run).rejects.toThrow('connection was lost')
		vi.mocked(f.connection.readHistory).mockResolvedValue({
			binding: f.binding,
			complete: true,
			pendingReviews: [],
			events: [
				{
					kind: 'message-completed',
					...f.native,
					nativeItemId: 'native-answer',
					content: 'The answer',
					stopReason: 'end_turn',
				},
				{ kind: 'turn-completed', ...f.native, status: 'completed', finalItemId: 'native-answer' },
			],
		})
		await f.session.reconnect()
		expect(f.connection.dispatch).toHaveBeenCalledTimes(1)
		expect(f.session.status).toBe('idle')
		expect((await f.session.history()).map((m) => m.content)).toEqual([
			f.prompt.prompt,
			'The answer',
		])
	})
	it('retains writer and owned cleanup handle when close fails, and retries confirmed stop before release', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await f.emit({ kind: 'turn-started', ...f.native })
		vi.mocked(f.connection.close).mockRejectedValueOnce(new Error('owned process stop unknown'))
		await expect(f.session.close()).rejects.toThrow('stop unknown')
		expect(await f.log.lease()).not.toBeNull()
		expect(f.session.status).not.toBe('closed')
		await f.session.close()
		expect((await run).status).toBe('cancelled')
		expect(f.connection.close).toHaveBeenCalledTimes(2)
		expect(f.session.status).toBe('closed')
	})
	it('scopes operation-source native correlation to the persisted SDK operation, and rejects forged turn IDs', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await expect(
			f.emit({
				kind: 'turn-started',
				nativeSessionId: f.binding.nativeSessionId,
				nativeTurnId: 'invented',
				turnIdSource: 'operation',
			}),
		).rejects.toThrow('dispatch operation')
		await expect(run).rejects.toThrow('dispatch operation')
		expect(f.session.status).toBe('reconciliation-required')
	})
	it('reads durable history without launching a native process', async () => {
		const f = fixture()
		expect(await f.session.history()).toEqual([])
		expect(f.adapter.open).not.toHaveBeenCalled()
	})
	it('aborting before dispatch ACK waits for actual correlation and terminal, with listener cleanup', async () => {
		const f = fixture()
		const ack = deferred<HarnessNativeTurn>()
		vi.mocked(f.connection.dispatch).mockImplementation(async (input) => {
			f.dispatched.resolve(input)
			return ack.promise
		})
		const abort = new AbortController()
		const remove = vi.spyOn(abort.signal, 'removeEventListener')
		const interrupted = deferred<void>()
		vi.mocked(f.connection.interrupt).mockImplementation(async () => {
			interrupted.resolve()
			return { requested: true }
		})
		const run = f.session.run({ ...f.prompt, signal: abort.signal })
		await f.dispatched.promise
		abort.abort()
		expect(f.connection.interrupt).not.toHaveBeenCalled()
		ack.resolve(f.native)
		await interrupted.promise
		await f.emit({ kind: 'turn-completed', ...f.native, status: 'cancelled' })
		expect((await run).status).toBe('cancelled')
		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
	})
	it('admission revoked after prompt persistence records a known unsent failure and permits a later authored turn', async () => {
		const f = fixture()
		f.authorize.mockImplementation(async ({ kind }) => {
			if (kind === 'run' && (await f.log.activeTurn()))
				throw new Error('revoked before native send')
		})
		await expect(f.session.run(f.prompt)).rejects.toThrow('revoked before native send')
		expect(f.connection.dispatch).not.toHaveBeenCalled()
		expect(await f.log.activeTurn()).toBeNull()
		expect(f.session.status).toBe('idle')
		f.authorize.mockResolvedValue(undefined)
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await answer(f)
		await complete(f)
		expect((await run).status).toBe('completed')
	})
	it('renewal and current writer check prevent native effects after a writer takeover', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await f.emit({ kind: 'turn-started', ...f.native })
		const request: HarnessReviewRequest = {
			...f.native,
			requestId: 'request',
			kind: 'command',
			title: 'Run',
			input: { command: 'pwd' },
			decisions: ['approve-once'],
		}
		await f.emit({ kind: 'review-requested', request })
		vi.setSystemTime(Date.now() + 120000)
		const foreign = new InMemorySessionLog({
			sessionId: f.scope.sessionId,
			medium: f.log.medium,
			leases: f.log.leaseStore,
			spills: f.log.spillStore,
		})
		expect(
			await foreign.claim({ holder: 'new-writer', ttlMs: 60000, repairTornTail: false }),
		).not.toBeNull()
		await expect(f.session.respond(request, { kind: 'approve-once' })).rejects.toThrow(
			'writer lease was lost',
		)
		expect(f.connection.respond).not.toHaveBeenCalled()
		await f.session.close().catch(() => undefined)
		void run.catch(() => undefined)
	})
	it('rejects overlapping prompt admission before another native dispatch', async () => {
		const f = fixture()
		const admission = deferred<void>()
		const entered = deferred<void>()
		f.authorize.mockImplementationOnce(async () => {
			entered.resolve()
			await admission.promise
		})
		const run = f.session.run(f.prompt)
		await entered.promise
		await expect(f.session.run(f.prompt)).rejects.toThrow('operation is pending')
		admission.resolve()
		await f.dispatched.promise
		await answer(f)
		await complete(f)
		await run
		expect(f.connection.dispatch).toHaveBeenCalledTimes(1)
	})
	it('captures adapter open and admission callback at factory entry across suspended authorization', async () => {
		const f = fixture()
		const admission = deferred<void>()
		const entered = deferred<void>()
		const allowed = vi.fn(async () => {
			entered.resolve()
			await admission.promise
		})
		const options = {
			scope: f.scope,
			sessionLog: f.log,
			adapter: f.adapter,
			assertAdmission: allowed,
			onEvent: () => undefined,
			onReview: () => undefined,
		}
		const session = createHarnessSession(options)
		sessions.push(session)
		const run = session.run(f.prompt)
		await entered.promise
		options.assertAdmission = vi.fn(async () => {
			throw new Error('replacement callback')
		})
		f.adapter.open = vi.fn(async () => {
			throw new Error('replacement native process')
		})
		admission.resolve()
		await f.dispatched.promise
		await answer(f)
		await complete(f)
		expect((await run).status).toBe('completed')
		expect(allowed.mock.calls.length).toBeGreaterThan(1)
		expect(options.assertAdmission).not.toHaveBeenCalled()
		expect(f.adapter.open).not.toHaveBeenCalled()
	})
	it('a fatal event append latches queued native terminal and prevents another paid dispatch until validated recovery', async () => {
		const f = fixture()
		const run = f.session.run(f.prompt)
		await f.dispatched.promise
		await f.emit({ kind: 'turn-started', ...f.native })
		const original = f.log.append.bind(f.log)
		vi.spyOn(f.log, 'append').mockImplementation(async (lease, draft) => {
			if (draft.type === 'message_started') throw new Error('append rejected')
			return original(lease, draft)
		})
		const first = f.emit({ kind: 'message-started', ...f.native, nativeItemId: 'answer' })
		const terminal = f.emit({
			kind: 'turn-completed',
			...f.native,
			status: 'completed',
			finalItemId: 'answer',
		})
		await expect(first).rejects.toThrow('append rejected')
		await expect(terminal).rejects.toThrow('append rejected')
		await expect(run).rejects.toThrow('append rejected')
		expect(f.session.status).toBe('reconciliation-required')
		expect(
			(await f.log.readAll()).entries.some(({ record }) => record.type === 'turn_completed'),
		).toBe(false)
		await expect(f.session.run(f.prompt)).rejects.toThrow('must be reconciled')
		expect(f.connection.dispatch).toHaveBeenCalledTimes(1)
	})
})
