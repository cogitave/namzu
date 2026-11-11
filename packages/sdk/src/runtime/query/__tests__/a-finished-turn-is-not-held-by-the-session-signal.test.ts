import { getEventListeners } from 'node:events'
import { setImmediate as nextTurnOfTheLoop } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { InMemorySessionTokenBudgetStore } from '../../../store/budget/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { TurnContextFactory } from '../context.js'
import { checkpointStoreFor } from './support/session.js'

/**
 * A session's signal lives as long as the session. A turn that listened on
 * it with a closure over its own controller was held by the session for
 * ever: one finished turn's whole object graph more in memory per turn.
 */
setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const sessionId = 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede' as SessionId

function build(signal: AbortSignal, n: number) {
	const log = new InMemorySessionLog({ sessionId })
	return TurnContextFactory.build({
		agentId: 'a',
		agentName: 'a',
		turnConfig: { model: 'test', tokenBudget: 1_000, timeoutMs: 5_000 },
		provider: { id: 'mock', supports: () => true } as unknown as LLMProvider,
		messages: [],
		sessionId,
		topicId: '4bd72c65-bcc9-475c-8d7c-27d622df04e8' as TopicId,
		projectId: '08c9b09c-4412-478c-878b-dc94927c760f' as ProjectId,
		tenantId: 'a8e039fb-e8d3-4206-9ed8-4cb17d5d8222' as TenantId,
		turnId: `b1f6e0d4-2f0a-4a53-9d3c-6f3f6f3c${String(n).padStart(4, '0')}` as TurnId,
		storage: {
			log,
			paths: undefined,
			sessionDir: undefined,
			checkpoints: checkpointStoreFor(log),
			tokenBudget: new InMemorySessionTokenBudgetStore(),
			children: undefined,
		},
		signal,
	} as unknown as Parameters<typeof TurnContextFactory.build>[0])
}

/** Build `count` turns and return only weak references to their controllers. */
function buildAndDrop(signal: AbortSignal, count: number): WeakRef<AbortController>[] {
	return Array.from({ length: count }, (_, n) => new WeakRef(build(signal, n).abortController))
}

/**
 * Collect until `done()` holds, a fixed number of rounds at most. Reading a
 * `WeakRef` keeps its target alive until the end of the current job, so the
 * check is followed by a turn of the loop before the next collection.
 */
async function collectUntil(done: () => boolean): Promise<void> {
	for (let round = 0; round < 20; round++) {
		collect()
		await nextTurnOfTheLoop()
		if (done()) return
		await nextTurnOfTheLoop()
	}
}

describe('a turn built on a long-lived session signal', () => {
	it('does not stay reachable from the signal once it is dropped', async () => {
		const session = new AbortController()
		const refs = buildAndDrop(session.signal, 30)
		await collectUntil(() => refs.every((ref) => ref.deref() === undefined))
		expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
		// The listeners go with their turns: no count that grows with the turns.
		await collectUntil(() => getEventListeners(session.signal, 'abort').length === 0)
		expect(getEventListeners(session.signal, 'abort')).toHaveLength(0)
	})

	it('still cancels the turns that are alive, with the reason', () => {
		const session = new AbortController()
		const live = [build(session.signal, 1), build(session.signal, 2)]
		const reason = new Error('window closed')
		session.abort(reason)
		for (const ctx of live) {
			expect(ctx.abortController.signal.aborted).toBe(true)
			expect(ctx.abortController.signal.reason).toBe(reason)
		}
	})
})
