import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../test-support/ids.js'

import { InMemoryCheckpointStore } from '../../store/run/checkpoint-memory.js'
import type { IterationCheckpoint } from '../../types/hitl/index.js'
import type { CheckpointId, ProjectId, RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { CheckpointRunScope } from '../../types/run/checkpoint-store.js'
import { drainRuns } from '../drain.js'

/**
 * `drain.ts` claims, in prose: "A supervisor, a daemon, or a scheduler.
 * There is no timer here, no process spawn, no retry backoff and no
 * `while (true)`."
 *
 * That claim has been cited as the kernel's position on a whole
 * capability, so it had better be true, and until this file nothing
 * checked it. A paragraph is not a check
 * ("a falsifiable comment is a test"): a later change
 * that added one `setTimeout` for a retry would leave the sentence
 * standing and reading as authoritative.
 *
 * Two halves, both mechanical. No timer is armed during a full pass, and
 * nothing reachable from this module can spawn a process.
 */

const TENANT = '1d173a44-e854-4ea4-84a0-2dbc12bb600b' as TenantId
const PROJECT = 'bc95b1e3-142f-4045-a846-c067c164684f' as ProjectId
const SESSION = '732ba7f1-a9eb-447f-913a-dfc2513a10cb' as SessionId

function scope(runId: string): CheckpointRunScope {
	return { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION, runId: runId as RunId }
}

function checkpoint(runId: string): IterationCheckpoint {
	return {
		id: fixtureUuid(`cp_${runId}`) as CheckpointId,
		runId: runId as RunId,
		iteration: 1,
		messages: [],
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0 } as IterationCheckpoint['costInfo'],
		guardState: { iterationCount: 1, elapsedMs: 10 },
		createdAt: 1_000,
		pending: {
			request: {
				type: 'tool_review',
				runId: runId as RunId,
				checkpointId: fixtureUuid(`cp_${runId}`) as CheckpointId,
				toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
			},
			parkedAt: 1_000,
		} satisfies IterationCheckpoint['pending'],
	}
}

describe('drainRuns makes one pass and arms nothing', () => {
	it('never schedules a timer across a full pass over several runs', async () => {
		// Several runs, so a per-run backoff would be caught as surely as a
		// per-pass one. Spied rather than faked: `vi.useFakeTimers` would
		// make an armed timer simply not fire, which is the opposite of what
		// is being asserted — the claim is that none is ARMED.
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

		try {
			const store = new InMemoryCheckpointStore()
			for (const id of [
				'90a466e2-f869-4a3c-b750-f2156342ff40',
				'fe818a89-6a50-4e51-8a91-5f108ad85280',
				'61d260b3-706f-452e-8528-f7fd5f736b18',
			]) {
				await store.writeCheckpoint(scope(id), checkpoint(id))
			}

			const result = await drainRuns({
				store,
				scope: { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION },
				holder: 'worker-1',
				ttlMs: 60_000,
				onRun: async () => {},
			})

			// The pass must actually have done something, or a `drainRuns`
			// that returned early would satisfy the timer assertions for the
			// wrong reason.
			expect(result.listed, 'the pass listed nothing, so it proved nothing').toBeGreaterThan(0)
			expect(result.drained.length + result.skipped.length).toBeGreaterThan(0)
			expect(setTimeoutSpy, 'drainRuns armed a timer').not.toHaveBeenCalled()
			expect(setIntervalSpy, 'drainRuns armed an interval').not.toHaveBeenCalled()
		} finally {
			setTimeoutSpy.mockRestore()
			setIntervalSpy.mockRestore()
		}
	})

	it('imports nothing that can spawn a process', () => {
		// The "no process spawn" half. Read from source rather than asserted
		// against behaviour, because a spawn on a path this test does not
		// take would still make the sentence false.
		const raw = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '..', 'drain.ts'),
			'utf8',
		)
		// Comments stripped first. The module's own prose SAYS `while (true)`
		// and `scheduler` in the course of ruling them out, so a bare
		// substring search over the whole file asserts the opposite of what
		// is meant — it fails precisely because the claim is documented.
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

		expect(code, 'drain.ts can spawn a process').not.toContain('child_process')
		expect(code, 'drain.ts has an unbounded loop').not.toContain('while (true)')
		expect(code, 'drain.ts arms an interval').not.toContain('setInterval')
		expect(code, 'drain.ts arms a timer').not.toContain('setTimeout')
	})
})
