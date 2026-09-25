import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TURN_LEASE_TTL_MS, TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionTokenBudgetStore } from '../../../store/budget/index.js'
import type { SessionCheckpointStore } from '../../../store/checkpoint/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { InMemoryTopicStateStore } from '../../../store/topic/index.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { prepareForkState } from '../fork/prepare.js'
import { type QueryParams, drainQuery } from '../index.js'
import { PreludeSessionLease } from '../prelude-lease.js'
import { resumeSession } from '../resume-session.js'

function scope() {
	return {
		sessionId: generateSessionId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
	}
}

type Scope = ReturnType<typeof scope>

function params(
	sessionLog: InMemorySessionLog,
	owner: Scope,
	provider = new MockLLMProvider({ responseText: 'ready' }),
): QueryParams {
	return {
		provider,
		resumeHandler: autoApproveHandler,
		toolsets: [],
		turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 5_000 },
		messages: [createUserMessage('private first-turn content')],
		workingDirectory: process.cwd(),
		agentId: 'scope-test',
		agentName: 'Scope test',
		sessionLog,
		...owner,
	}
}

function recorder(log: InMemorySessionLog, owner: Scope): TurnRecorder {
	return new TurnRecorder({
		...owner,
		turnId: generateTurnId(),
		agentId: 'scope-test',
		agentName: 'Scope test',
		turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 5_000 },
		providerId: 'mock',
		log: {
			info() {},
			warn() {},
			error() {},
			debug() {},
			child() {
				return this
			},
		} as never,
		sessionLog: log,
	})
}

async function openedSession(): Promise<{
	owner: Scope
	log: InMemorySessionLog
	turnId: ReturnType<typeof generateTurnId>
}> {
	const owner = scope()
	const log = new InMemorySessionLog({ sessionId: owner.sessionId })
	const turn = await drainQuery(params(log, owner))
	return { owner, log, turnId: turn.id }
}

function otherId(field: keyof Scope): Scope[keyof Scope] {
	switch (field) {
		case 'sessionId':
			return generateSessionId()
		case 'projectId':
			return generateProjectId()
		case 'tenantId':
			return generateTenantId()
		case 'topicId':
			return generateTopicId()
	}
}

function unreadCheckpointStore() {
	const list = vi.fn()
	const restore = vi.fn()
	return {
		store: { list, restore } as unknown as SessionCheckpointStore,
		list,
		restore,
	}
}

describe('session attribution at durable read and write boundaries', () => {
	it.each(['sessionId', 'projectId', 'tenantId', 'topicId'] as const)(
		'refuses a new turn with a different %s before budget, queue or model work',
		async (field) => {
			const { owner, log } = await openedSession()
			const different = { ...owner, [field]: otherId(field) }
			const provider = new MockLLMProvider({ responseText: 'must not run' })
			const budgetStore = new InMemorySessionTokenBudgetStore()
			const loadBudget = vi.spyOn(budgetStore, 'load')
			const topicStore = new InMemoryTopicStateStore()
			await topicStore.setQueuedMessages(
				different.topicId,
				different.tenantId,
				[createUserMessage('queued secret')],
				{ revision: 0 },
			)
			const readTopic = vi.spyOn(topicStore, 'getState')
			const before = (await log.readAll()).entries.length

			await expect(
				drainQuery({
					...params(log, different, provider),
					tokenBudgetStore: budgetStore,
					topicStateStore: topicStore,
				}),
			).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: [field] },
			})

			expect(loadBudget).not.toHaveBeenCalled()
			expect(readTopic).not.toHaveBeenCalled()
			expect(provider.requests).toHaveLength(0)
			expect((await log.readAll()).entries).toHaveLength(before)
			readTopic.mockRestore()
			expect(
				(await topicStore.getState(different.topicId, different.tenantId))?.queuedMessages,
			).toHaveLength(1)
		},
	)

	it('rechecks under the claimed lease if the preflight saw an empty log', async () => {
		const { owner, log } = await openedSession()
		const before = await log.medium.size()
		await log.medium.append(Buffer.from('{"torn":'), before)
		const tornSize = await log.medium.size()
		const realReadAll = log.readAll.bind(log)
		let reads = 0
		vi.spyOn(log, 'readAll').mockImplementation(async (options) => {
			if (++reads === 1) {
				return {
					entries: [],
					intact: true,
					throughSeq: 0,
					head: null,
					tornBytes: 0,
				}
			}
			return realReadAll(options)
		})
		const different = { ...owner, tenantId: generateTenantId() }
		const budgetStore = new InMemorySessionTokenBudgetStore()
		const loadBudget = vi.spyOn(budgetStore, 'load')
		const provider = new MockLLMProvider({ responseText: 'must not run' })

		await expect(
			drainQuery({
				...params(log, different, provider),
				tokenBudgetStore: budgetStore,
			}),
		).rejects.toMatchObject({
			code: 'invalid_config',
			details: { fields: ['tenantId'] },
		})
		expect(loadBudget).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(await log.medium.size()).toBe(tornSize)
		const reclaimed = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
		expect(reclaimed).not.toBeNull()
		if (reclaimed) await log.release(reclaimed)
	})

	it('renews its writer lease while provider metadata is pending, then releases it after the turn', async () => {
		vi.useFakeTimers()
		try {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			let enteredLookup: () => void = () => undefined
			let finishLookup: (value: number) => void = () => undefined
			const entered = new Promise<void>((resolve) => {
				enteredLookup = resolve
			})
			const provider = Object.assign(new MockLLMProvider({ responseText: 'ready' }), {
				resolveContextWindow: () => {
					enteredLookup()
					return new Promise<number>((resolve) => {
						finishLookup = resolve
					})
				},
			})
			const pending = drainQuery({
				...params(log, owner, provider),
				turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 20 * 60_000 },
			})
			await entered
			const first = await log.lease()
			await vi.advanceTimersByTimeAsync(DEFAULT_TURN_LEASE_TTL_MS + 60_000)
			const renewed = await log.lease()
			expect(renewed?.fence).toBe(first?.fence)
			expect(renewed?.expiresAt).toBeGreaterThan(Date.now())
			finishLookup(16_000)
			expect((await pending).status).toBe('completed')
			expect(vi.getTimerCount()).toBe(0)
			const next = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
			expect(next).not.toBeNull()
			if (next) await log.release(next)
		} finally {
			vi.useRealTimers()
		}
	})

	it('renews the recorder lease while a project callback is pending after open', async () => {
		vi.useFakeTimers()
		try {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			let enterCallback: () => void = () => undefined
			let finishCallback: (value: null) => void = () => undefined
			const entered = new Promise<void>((resolve) => {
				enterCallback = resolve
			})
			const pending = drainQuery({
				...params(log, owner),
				turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 20 * 60_000 },
				projectInstructionContext: {
					prepareInitialSnapshot: () => {
						enterCallback()
						return new Promise<null>((resolve) => {
							finishCallback = resolve
						})
					},
					observeToolResult: () => undefined,
				},
			})
			await entered
			const first = await log.lease()
			await vi.advanceTimersByTimeAsync(DEFAULT_TURN_LEASE_TTL_MS + 60_000)
			const renewed = await log.lease()
			expect(renewed?.fence).toBe(first?.fence)
			expect(renewed?.expiresAt).toBeGreaterThan(Date.now())
			finishCallback(null)
			expect((await pending).status).toBe('completed')
			expect(vi.getTimerCount()).toBe(0)
			const next = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
			expect(next).not.toBeNull()
			if (next) await log.release(next)
		} finally {
			vi.useRealTimers()
		}
	})

	it('transfers its latest token while keeping the prelude heartbeat until recorder takeover', async () => {
		vi.useFakeTimers()
		try {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			const holding = await PreludeSessionLease.acquire(log, owner.sessionId, generateTurnId())
			const first = await log.lease()
			await vi.advanceTimersByTimeAsync(DEFAULT_TURN_LEASE_TTL_MS / 2)
			const transferred = await holding.transfer()
			expect(transferred.fence).toBe(first?.fence)
			expect(transferred.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0)
			expect(vi.getTimerCount()).toBe(1)
			await holding.stop()
			expect(vi.getTimerCount()).toBe(0)
			await log.release(transferred)
		} finally {
			vi.useRealTimers()
		}
	})

	it('observes a failed background renewal and frees its owned lease', async () => {
		vi.useFakeTimers()
		try {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			const holding = await PreludeSessionLease.acquire(log, owner.sessionId, generateTurnId())
			vi.spyOn(log, 'claim').mockRejectedValueOnce(new Error('renewal failed'))
			await vi.advanceTimersByTimeAsync(DEFAULT_TURN_LEASE_TTL_MS / 2)
			await expect(holding.assertCurrent()).rejects.toThrow('renewal failed')
			await holding.release()
			expect(vi.getTimerCount()).toBe(0)
			const next = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
			expect(next).not.toBeNull()
			if (next) await log.release(next)
		} finally {
			vi.useRealTimers()
		}
	})

	it('releases a newly minted lease when prelude renewal discovers a changed fence', async () => {
		vi.useFakeTimers()
		try {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			const holding = await PreludeSessionLease.acquire(log, owner.sessionId, generateTurnId())
			const first = await log.lease()
			if (!first) throw new Error('Could not claim prelude lease')
			await log.release(first)
			await vi.advanceTimersByTimeAsync(DEFAULT_TURN_LEASE_TTL_MS / 2)
			await expect(holding.assertCurrent()).rejects.toMatchObject({ code: 'invalid_config' })
			await holding.release()
			expect(vi.getTimerCount()).toBe(0)
			const next = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
			expect(next).not.toBeNull()
			if (next) await log.release(next)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not release a caller-supplied prelude lease', async () => {
		const owner = scope()
		const log = new InMemorySessionLog({ sessionId: owner.sessionId })
		const lease = await log.claim({ holder: 'caller', ttlMs: 60_000 })
		if (!lease) throw new Error('Could not claim caller lease')
		const holding = await PreludeSessionLease.acquire(log, owner.sessionId, generateTurnId(), lease)
		await holding.release()
		expect((await log.lease())?.fence).toBe(lease.fence)
		await log.release(lease)
	})

	it.each(['expired', 'foreign holder', 'displaced fence'] as const)(
		'refuses a %s caller lease before budget and queue work without releasing the holder',
		async (problem) => {
			const { owner, log } = await openedSession()
			const first = await log.claim({ holder: 'caller', ttlMs: 60_000 })
			if (!first) throw new Error('Could not claim caller lease')
			let held = first
			if (problem === 'displaced fence') {
				await log.release(first)
				const replacement = await log.claim({ holder: 'other writer', ttlMs: 60_000 })
				if (!replacement) throw new Error('Could not claim replacement lease')
				held = replacement
			}
			const presented =
				problem === 'expired'
					? { ...first, expiresAt: Date.now() - 1 }
					: problem === 'foreign holder'
						? { ...first, holder: 'foreign writer' }
						: first
			const budgetStore = new InMemorySessionTokenBudgetStore()
			const loadBudget = vi.spyOn(budgetStore, 'load')
			const topicStore = new InMemoryTopicStateStore()
			const readTopic = vi.spyOn(topicStore, 'getState')
			const provider = new MockLLMProvider({ responseText: 'must not run' })

			try {
				await expect(
					drainQuery({
						...params(log, owner, provider),
						lease: presented,
						tokenBudgetStore: budgetStore,
						topicStateStore: topicStore,
					}),
				).rejects.toMatchObject({ code: 'invalid_config' })
				expect(loadBudget).not.toHaveBeenCalled()
				expect(readTopic).not.toHaveBeenCalled()
				expect(provider.requests).toHaveLength(0)
				expect((await log.lease())?.fence).toBe(held.fence)
			} finally {
				await log.release(held)
			}
		},
	)

	it.each(['tenantId', 'topicId'] as const)(
		'refuses to continue a legacy log with no %s owner',
		async (missing) => {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			const lease = await log.claim({ holder: 'legacy writer', ttlMs: 60_000 })
			if (!lease) throw new Error('Could not claim legacy log')
			await log.append(lease, {
				type: 'session_started',
				projectId: owner.projectId,
				...(missing === 'tenantId' ? {} : { tenantId: owner.tenantId }),
				...(missing === 'topicId' ? {} : { topicId: owner.topicId }),
				cwd: process.cwd(),
				agent: { id: 'legacy', name: 'Legacy' },
			})
			await log.release(lease)
			const provider = new MockLLMProvider({ responseText: 'must not run' })
			await expect(drainQuery(params(log, owner, provider))).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: [missing] },
			})
			expect(provider.requests).toHaveLength(0)
			expect((await log.readAll()).entries).toHaveLength(1)
		},
	)

	it('a direct recorder releases its own lease after rejecting a foreign scope', async () => {
		const { owner, log } = await openedSession()
		const before = await log.medium.size()
		await log.medium.append(Buffer.from('{"torn":'), before)
		const tornSize = await log.medium.size()
		const recorder = new TurnRecorder({
			...owner,
			tenantId: generateTenantId(),
			turnId: generateTurnId(),
			agentId: 'scope-test',
			agentName: 'Scope test',
			turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 5_000 },
			providerId: 'mock',
			log: {
				info() {},
				warn() {},
				error() {},
				debug() {},
				child() {
					return this
				},
			} as never,
			sessionLog: log,
		})
		await expect(recorder.open({ session: { cwd: process.cwd() } })).rejects.toMatchObject({
			code: 'invalid_config',
			details: { fields: ['tenantId'] },
		})
		// A claim would heal this tail and append log_repaired, even if the
		// owner check later refused the turn.
		expect(await log.medium.size()).toBe(tornSize)
		const reclaimed = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
		expect(reclaimed).not.toBeNull()
		if (reclaimed) await log.release(reclaimed)
	})

	it('a direct recorder leaves a caller-supplied lease with its caller after refusal', async () => {
		const { owner, log } = await openedSession()
		const lease = await log.claim({ holder: 'caller', ttlMs: 60_000 })
		if (!lease) throw new Error('Could not claim caller lease')
		const recorder = new TurnRecorder({
			...owner,
			topicId: generateTopicId(),
			turnId: generateTurnId(),
			agentId: 'scope-test',
			agentName: 'Scope test',
			turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 5_000 },
			providerId: 'mock',
			log: {
				info() {},
				warn() {},
				error() {},
				debug() {},
				child() {
					return this
				},
			} as never,
			sessionLog: log,
		})
		await expect(recorder.open({ lease, session: { cwd: process.cwd() } })).rejects.toMatchObject({
			code: 'invalid_config',
			details: { fields: ['topicId'] },
		})
		expect((await log.lease())?.fence).toBe(lease.fence)
		await log.release(lease)
	})

	it('a direct recorder releases an owned transferred lease if preflight read fails', async () => {
		const { owner, log } = await openedSession()
		const lease = await log.claim({ holder: 'transferred', ttlMs: 60_000 })
		if (!lease) throw new Error('Could not claim transferred lease')
		vi.spyOn(log, 'readAll').mockRejectedValueOnce(new Error('preflight read failed'))
		await expect(
			recorder(log, owner).open({
				lease,
				ownLease: true,
				session: { cwd: process.cwd() },
			}),
		).rejects.toThrow('preflight read failed')
		const next = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
		expect(next).not.toBeNull()
		if (next) await log.release(next)
	})

	it.each(['tenantId', 'topicId'] as const)(
		'a direct recorder refuses an omitted %s before claiming an empty log',
		async (field) => {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			const recorder = new TurnRecorder({
				...owner,
				[field]: undefined as never,
				turnId: generateTurnId(),
				agentId: 'scope-test',
				agentName: 'Scope test',
				turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 5_000 },
				providerId: 'mock',
				log: {
					info() {},
					warn() {},
					error() {},
					debug() {},
					child() {
						return this
					},
				} as never,
				sessionLog: log,
			})
			await expect(recorder.open({ session: { cwd: process.cwd() } })).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: [field] },
			})
			expect((await log.readAll()).entries).toHaveLength(0)
			expect(await log.lease()).toBeNull()
		},
	)

	it('a direct recorder renews a short lease and releases its latest token after a heartbeat error', async () => {
		vi.useFakeTimers()
		try {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			const recorder = new TurnRecorder({
				...owner,
				turnId: generateTurnId(),
				agentId: 'scope-test',
				agentName: 'Scope test',
				turnConfig: { model: 'mock-model', tokenBudget: 1_000, timeoutMs: 5_000 },
				providerId: 'mock',
				log: {
					info() {},
					warn() {},
					error() {},
					debug() {},
					child() {
						return this
					},
				} as never,
				sessionLog: log,
			})
			await recorder.open({ leaseTtlMs: 1_000, session: { cwd: process.cwd() } })
			const first = await log.lease()
			await vi.advanceTimersByTimeAsync(1_500)
			const renewed = await log.lease()
			expect(renewed?.fence).toBe(first?.fence)
			expect(renewed?.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0)
			expect(renewed?.expiresAt).toBeGreaterThan(Date.now())
			vi.spyOn(log, 'claim').mockRejectedValueOnce(new Error('recorder heartbeat failed'))
			await vi.advanceTimersByTimeAsync(500)
			await expect(recorder.begin()).rejects.toThrow('recorder heartbeat failed')
			await recorder.release()
			expect(vi.getTimerCount()).toBe(0)
			const next = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
			expect(next).not.toBeNull()
			if (next) await log.release(next)
		} finally {
			vi.useRealTimers()
		}
	})

	it('a direct recorder releases a newly minted lease when heartbeat finds a changed fence', async () => {
		vi.useFakeTimers()
		try {
			const owner = scope()
			const log = new InMemorySessionLog({ sessionId: owner.sessionId })
			const holding = recorder(log, owner)
			await holding.open({ leaseTtlMs: 1_000, session: { cwd: process.cwd() } })
			const first = await log.lease()
			if (!first) throw new Error('Could not claim recorder lease')
			await log.release(first)
			await vi.advanceTimersByTimeAsync(500)
			await expect(holding.begin()).rejects.toMatchObject({ code: 'invalid_config' })
			await holding.release()
			expect(vi.getTimerCount()).toBe(0)
			const next = await log.claim({ holder: 'next writer', ttlMs: 60_000 })
			expect(next).not.toBeNull()
			if (next) await log.release(next)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each(['projectId', 'tenantId', 'topicId'] as const)(
		'resume refuses a foreign %s before checkpoint access',
		async (field) => {
			const { owner, log, turnId } = await openedSession()
			const different = { ...owner, [field]: otherId(field) }
			const checkpoint = unreadCheckpointStore()
			await expect(
				resumeSession({
					...params(log, different),
					sessionLog: log,
					scope: { ...different, turnId },
					checkpointStore: checkpoint.store,
				}),
			).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: [field] },
			})
			expect(checkpoint.list).not.toHaveBeenCalled()
			expect(checkpoint.restore).not.toHaveBeenCalled()
		},
	)

	it.each(['projectId', 'tenantId', 'topicId'] as const)(
		'fork refuses a foreign %s before checkpoint access',
		async (field) => {
			const { owner, log, turnId } = await openedSession()
			const different = { ...owner, [field]: otherId(field) }
			const checkpoint = unreadCheckpointStore()
			await expect(
				prepareForkState({
					sessionLog: log,
					checkpointStore: checkpoint.store,
					scope: { ...different, turnId },
					fromCheckpoint: 'latest',
				}),
			).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: [field] },
			})
			expect(checkpoint.list).not.toHaveBeenCalled()
			expect(checkpoint.restore).not.toHaveBeenCalled()
		},
	)

	it('fork refuses a runtime caller that omits the source topic before checkpoint access', async () => {
		const { owner, log, turnId } = await openedSession()
		const checkpoint = unreadCheckpointStore()
		const { topicId: _topicId, ...withoutTopic } = owner
		await expect(
			prepareForkState({
				sessionLog: log,
				checkpointStore: checkpoint.store,
				scope: { ...withoutTopic, turnId } as never,
				fromCheckpoint: 'latest',
			}),
		).rejects.toMatchObject({
			code: 'invalid_config',
			details: { fields: ['topicId'] },
		})
		expect(checkpoint.list).not.toHaveBeenCalled()
		expect(checkpoint.restore).not.toHaveBeenCalled()
	})
})
