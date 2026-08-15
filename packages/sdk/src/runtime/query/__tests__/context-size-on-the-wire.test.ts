import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { type CompactionConfig, CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import { drainQuery } from '../index.js'

/**
 * Cumulative spend and current context size are different quantities, and a
 * host divided the first by a context window and shipped it.
 *
 * That indicator climbed toward full on any long run no matter how much room
 * the conversation actually had — most wrong exactly when someone needed it —
 * because `usage` is summed over every turn and never falls, while the context
 * is what is being sent right now and falls whenever a compaction sheds.
 *
 * The host had no better option: the correct numerator needs internals it
 * cannot see, and the correct denominator was a two-branch guess on a model
 * name. So both numbers are on the event, named so that reaching for the wrong
 * one is a visible mistake rather than a plausible guess.
 */

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

type UsageEvent = Extract<RunEvent, { type: 'token_usage_updated' }>

async function run(
	compaction: CompactionConfig | undefined,
	turns: unknown[],
): Promise<UsageEvent[]> {
	const seen: UsageEvent[] = []
	const dir = await mkdtemp(join(tmpdir(), 'namzu-ctxsize-'))
	workdirs.push(dir)

	await drainQuery(
		{
			provider: new MockLLMProvider({ turns: turns as never }),
			tools: new ToolRegistry(),
			runConfig: { model: 'mock-model', timeoutMs: 30_000, tokenBudget: 100_000, maxIterations: 3 },
			...(compaction ? { compactionConfig: compaction } : {}),
			agentId: 'agent_ctx',
			agentName: 'Context Agent',
			workingDirectory: dir,
			sessionId: 'ses_ctx',
			topicId: 'thd_ctx',
			projectId: 'prj_ctx',
			tenantId: 'tnt_ctx',
			messages: [createUserMessage('go')],
		},
		(event: RunEvent) => {
			if (event.type === 'token_usage_updated') seen.push(event)
		},
	)

	return seen
}

// Through the same schema `query()` resolves a host's config with, so the
// fixture carries production's defaults for the fifteen fields this test
// does not care about rather than a bare object shaped like none of them.
const COMPACTION = CompactionConfigSchema.parse({
	strategy: 'sliding-window',
	triggerThreshold: 0.9,
	contextWindowTokens: 50_000,
	keepRecentMessages: 4,
})

describe('a run reports how much room its context has', () => {
	it('carries the context size and the window together', async () => {
		const events = await run(COMPACTION, [{ text: 'done' }])

		expect(events.length).toBeGreaterThan(0)
		const event = events[0] as UsageEvent
		expect(event.contextTokens).toBeGreaterThan(0)
		expect(event.contextWindowTokens).toBe(50_000)
	})

	it('says whether each number was measured or guessed', async () => {
		// A fraction is only as honest as the weaker of its two terms, so a
		// surface rendering these owes a reader the distinction. It cannot
		// pass it on if it never receives it.
		const event = (await run(COMPACTION, [{ text: 'done' }]))[0] as UsageEvent

		expect(['provider', 'estimate']).toContain(event.contextMeasuredBy)
		// The window was stated in config here, so its provenance is not a guess.
		expect(event.windowSource).toBe('config')
	})

	it('keeps the context size distinct from cumulative spend', async () => {
		// The whole defect in one assertion, and this driver demonstrates it
		// more sharply than a real one would: it reports no usage at all, so
		// cumulative spend stays at zero while the context genuinely fills.
		//
		// A surface dividing spend by a window would show 0% here, for a
		// conversation that is really there. The same surface on a long run
		// shows 100% for a conversation that was compacted down to nothing.
		// Both directions, same category error — which is why the two numbers
		// are reported separately rather than left to be inferred from each
		// other.
		const events = await run(COMPACTION, [{ text: 'one' }, { text: 'two' }])
		const last = events[events.length - 1] as UsageEvent

		expect(last.contextTokens).toBeGreaterThan(0)
		expect(last.contextTokens).not.toBe(last.usage.totalTokens)
	})

	it('reports nothing rather than a guess when no window is configured', async () => {
		// Without a compaction config nothing resolves a window, and inventing
		// one would be the guess this replaces. Absent is a fact a surface can
		// act on; a fabricated default is not.
		const event = (await run(undefined, [{ text: 'done' }]))[0] as UsageEvent

		expect(event.contextTokens).toBeUndefined()
		expect(event.contextWindowTokens).toBeUndefined()
		expect(event.windowSource).toBeUndefined()
	})
})
