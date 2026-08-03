import { describe, expect, it, vi } from 'vitest'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { RunMemoryCandidate } from '../../../types/run/memory-promotion.js'
import { memoryCandidateFor } from '../../../types/run/memory-promotion.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateThreadId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * namzu could STORE a memory and could not FORM one. `MemoryStore` and
 * its disk implementation have been here all along, and the only path
 * into them was the model calling `save_memory` — so a run that worked
 * out a durable fact and never thought to write it down lost it at
 * settle, along with everything the compaction pass had already
 * extracted and structured on the way.
 */

registerMock()

function run(opts: {
	promoteMemory?: (candidate: RunMemoryCandidate) => void | Promise<void>
	failing?: boolean
	compaction?: boolean
}) {
	return drainQuery({
		provider: new MockLLMProvider({
			turns: opts.failing ? [{ error: { message: 'provider is down' } }] : [{ text: 'done' }],
		}),
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'ship the invoice job' }],
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 2 },
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		threadId: generateThreadId(),
		tenantId: generateTenantId(),
		...(opts.compaction === false ? {} : { compactionConfig: { strategy: 'structured' } }),
		...(opts.promoteMemory ? { promoteMemory: opts.promoteMemory } : {}),
	} as never)
}

describe('what a finished run leaves behind', () => {
	it('offers the extracted state when the run settles', async () => {
		const promote = vi.fn()
		await run({ promoteMemory: promote })

		expect(promote).toHaveBeenCalledTimes(1)
		const candidate = promote.mock.calls[0]?.[0] as RunMemoryCandidate
		expect(candidate.runId).toMatch(/^run_/)
		expect(candidate.task).toContain('invoice')
	})

	it('offers it after a FAILED run too', async () => {
		// A run that fell over still discovered things, and the approach that
		// failed is exactly what a later run should not pay for twice.
		const promote = vi.fn()
		await run({ promoteMemory: promote, failing: true }).catch(() => {})

		expect(promote).toHaveBeenCalledTimes(1)
	})

	it('does not retract an answer when the host throws', async () => {
		// A memory that failed to form must not fail a run that already
		// produced its answer.
		const settled = await run({
			promoteMemory: () => {
				throw new Error('the memory store is unreachable')
			},
		})

		expect(settled.status).toBe('completed')
		expect(settled.result).toBe('done')
	})

	it('awaits an async host before the run returns', async () => {
		// Fire-and-forget would race a one-shot process exiting, and the
		// write would be lost precisely on the runs that are shortest.
		// Asserted as an ORDER, not a flag: a flag checked after the run
		// passes whenever the run happens to be slower than the write, which
		// makes the test a race rather than a check.
		const order: string[] = []
		await run({
			promoteMemory: async () => {
				await new Promise((resolve) => setTimeout(resolve, 50))
				order.push('promoted')
			},
		})
		order.push('returned')

		expect(order).toEqual(['promoted', 'returned'])
	})

	it('is not consulted when no host asked for it', async () => {
		const settled = await run({})

		expect(settled.status).toBe('completed')
	})

	it('is not consulted when nothing extracted the state', async () => {
		const promote = vi.fn()
		await run({ promoteMemory: promote, compaction: false })

		expect(promote).not.toHaveBeenCalled()
	})
})

describe('whether there is anything to offer', () => {
	// Tested apart from the run because inside the `try` the decision and
	// the catch that swallows its failure look identical from outside: drop
	// the guard and the candidate throws, the catch logs, and the run-level
	// assertion still holds for the wrong reason.

	it('is nothing at all without an extractor', () => {
		// Inventing an empty candidate would ask a host to store a record of
		// nothing.
		expect(memoryCandidateFor('run_1' as never, undefined)).toBeUndefined()
	})

	it('projects the state rather than handing it over', () => {
		const state = {
			task: 'ship it',
			decisions: ['use the queue'],
			discoveries: [],
			userRequirements: ['never bill twice'],
			failures: [],
			environment: [],
			files: new Map([['src/a.ts', {}]]),
			evicted: { decisions: 2 },
		}
		const candidate = memoryCandidateFor('run_1' as never, { getState: () => state })

		expect(candidate?.files).toEqual(['src/a.ts'])
		expect(candidate?.userRequirements).toEqual(['never bill twice'])
		// Copied, so a host holding the candidate cannot edit the run's state.
		expect(candidate?.decisions).not.toBe(state.decisions)
		// Carried rather than hidden: a host deciding whether this is worth
		// storing should know it is looking at a truncated record.
		expect(candidate?.evicted).toEqual({ decisions: 2 })
	})
})
