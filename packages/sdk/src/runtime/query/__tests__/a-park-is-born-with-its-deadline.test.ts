import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { type RecordedPark, findPendingCheckpoint, readParks } from '../checkpoint.js'
import { type QueryParams, query } from '../index.js'
import { memorySession } from './support/session.js'

/**
 * `turnConfig.hitlParkTtlMs` reaches `CheckpointManager.setParkTtl` in exactly
 * one line, and nothing tested that line.
 *
 * The manager-level default is covered — `durable-park-and-trace.test.ts`
 * drives `setParkTtl` directly. What was not covered is the hop from a host's
 * config to that call. Delete it and every park a real run records becomes
 * immortal: the worker is redeployed, nobody answers, and the checkpoint
 * stays outstanding forever while every approval-queue reader keeps serving
 * it. The setting looks wired, the manager is correct, and nothing between
 * them carries the number — the same shape as the claim fence that was
 * complete except for its wire.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const TURN_ID = generateTurnId()

/** A destructive call no gate pre-approves, so it reaches a human. */
function reviewRegistry(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'deploy',
			description: 'a destructive call that needs a human',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			execute: async () => ({ success: true, output: 'deployed' }),
		}),
	)
	return tools
}

async function runUntilParked(options: { hitlParkTtlMs?: number }): Promise<{
	events: SessionEvent[]
	/**
	 * The parks as they stood while the run was still waiting — read before
	 * the abort, because a cancelled run resolves its own park on the way out
	 * and an outstanding-park assertion taken afterwards would be about the
	 * teardown rather than about the park.
	 */
	parked: RecordedPark[]
	/** What a host's approval queue would have been served, at that moment. */
	servedWhileParked?: RecordedPark | null
	session: ReturnType<typeof memorySession>
}> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-park-ttl-'))
	dirs.push(dir)
	const session = memorySession()
	const outstanding = async () =>
		(await readParks(session.sessionLog)).filter((park) => park.pending.resolvedAt === undefined)
	const events: SessionEvent[] = []
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ id: 'c1', name: 'deploy', args: {} }], finishReason: 'tool_calls' }],
	})

	// The handler never answers, so the park is still outstanding when the
	// test looks at it — and the run is cancelled from the outside once the
	// park is on the durable record.
	const caller = new AbortController()
	const drained = (async () => {
		const gen = query({
			provider,
			tools: reviewRegistry(),
			...session,
			agentId: 'agent_park_ttl',
			agentName: 'Park TTL agent',
			messages: [{ role: 'user', content: 'deploy it' }],
			workingDirectory: dir,
			turnId: TURN_ID,
			signal: caller.signal,
			// Records the park on the next macrotask rather than after the
			// default quarter second.
			parkRecordDelayMs: 0,
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
				...(options.hitlParkTtlMs !== undefined ? { hitlParkTtlMs: options.hitlParkTtlMs } : {}),
			},
			authorizationGate: {
				enabled: true,
				rules: [],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			resumeHandler: () => new Promise(() => {}),
		} as unknown as QueryParams)

		let next = await gen.next()
		while (!next.done) {
			events.push(next.value)
			next = await gen.next()
		}
		return next.value
	})()

	// Wait on the durable record, not on a duration: the park reaching the
	// store is exactly the fact under test.
	await vi.waitFor(async () => expect((await outstanding()).length).toBeGreaterThan(0))
	const parked = await outstanding()
	const servedWhileParked = await findPendingCheckpoint(session.sessionLog)
	caller.abort()
	await drained
	return { events, parked, servedWhileParked, session }
}

describe("a host's park time-to-live reaches the run that records the park", () => {
	it('stamps an ABSOLUTE deadline on the park a real run writes', async () => {
		const { parked: parkedList } = await runUntilParked({ hitlParkTtlMs: 60_000 })

		const parked = parkedList[0]
		expect(parked).toBeDefined()
		expect(parked?.pending.request.type).toBe('tool_review')
		// Absolute, so it survives the process that set it. Without the hop
		// from `turnConfig`, `setParkTtl` is never called, no deadline is
		// written, and this park is immortal — the manager would still be
		// right, and the run would still be wrong.
		expect(parked?.pending.deadlineAt).toBe((parked?.pending.parkedAt ?? 0) + 60_000)
	})

	it('writes no deadline when the host asked for none', async () => {
		// The default has to stay "no deadline": a host that never configured
		// one must not start losing approvals to a value the SDK invented.
		const { parked } = await runUntilParked({})

		// The premise, asserted rather than assumed: a park WAS recorded, so
		// its missing deadline is a fact about the config.
		expect(parked).toHaveLength(1)
		expect(parked[0]?.pending.deadlineAt).toBeUndefined()
	})
})

describe('the time-to-live the run writes is the one the store will enforce', () => {
	it('serves the park before the deadline and stops serving it after', async () => {
		const { parked, servedWhileParked, session } = await runUntilParked({ hitlParkTtlMs: 60_000 })
		const recorded = parked[0] as RecordedPark

		// Served while parked — which is what makes the second assertion a
		// statement about the deadline rather than about a park nobody ever
		// wrote.
		expect(servedWhileParked?.checkpointId).toBe(recorded.checkpointId)
		// And once the window has closed it is no longer served, so an
		// approval queue stops re-presenting a request nobody can answer.
		expect(
			await findPendingCheckpoint(session.sessionLog, {
				now: (recorded.pending.deadlineAt ?? 0) + 1,
			}),
		).toBeNull()
	})
})

describe('a park this run did not ask for', () => {
	it('is not made immortal by a time-to-live the run never got', async () => {
		// The negative control for the two cases above: with no TTL configured
		// there is no deadline to inherit, so nothing about this run's parks
		// can be expired — which is what makes the first case's positive
		// result a fact about the config rather than about parking at all.
		const { parked } = await runUntilParked({})
		expect(parked).toHaveLength(1)
		expect(parked[0]?.pending.deadlineAt).toBeUndefined()

		// Nothing had answered it either, which is the state the deadline
		// exists to bound.
		expect(parked[0]?.pending.resolvedAt).toBeUndefined()
	})
})
