import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { estimateMessagesTokens } from '../../../compaction/token-estimate.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import { isEphemeralEvent } from '../../../types/run/events.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Clearing oversized tool results is the most common context-relief path
 * and it was the only one that emitted nothing.
 *
 * It edits the conversation irrecoverably — `tool_result` bodies are
 * replaced in place — so a host reading `transcript.jsonl` saw results it
 * no longer has, with no record of why. Both summarization outcomes were
 * already on the wire; the cheap one that runs far more often was not, and
 * `ctx.log.info` was the whole of it, which every CLI entry point used to
 * silence.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A tool result big enough to be worth clearing, and old enough to qualify. */
function toolResult(id: string, chars: number): Message[] {
	return [
		{
			role: 'assistant',
			content: '',
			toolCalls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
		} as unknown as Message,
		{ role: 'tool', toolCallId: id, content: 'x'.repeat(chars) } as unknown as Message,
	]
}

async function runWith(opts: {
	readonly resultChars: number
	readonly filler: number
	readonly tokenBudget: number
}): Promise<{ events: RunEvent[]; messages: readonly Message[] }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-cleared-'))
	dirs.push(workingDirectory)

	const messages: Message[] = [
		...toolResult('t1', opts.resultChars),
		...toolResult('t2', opts.resultChars),
		...Array.from({ length: opts.filler }, (_, i) =>
			createUserMessage(`turn ${i}: ${'context '.repeat(200)}`),
		),
	]

	const seen: RunEvent[] = []
	const run = await drainQuery(
		{
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			tools: new ToolRegistry(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 20_000,
				tokenBudget: opts.tokenBudget,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			agentId: 'agent_c',
			agentName: 'Cleared',
			messages,
			workingDirectory,
			sessionId: 'fd031048-1d65-449b-b6f2-0a8f2ba6b99f' as SessionId,
			topicId: '7f2cf483-e642-4898-8ac3-316074ab3639' as TopicId,
			projectId: '8d8cdcf3-4c2c-484c-b208-54dcd1964be4' as ProjectId,
			tenantId: 'bdb9c2e1-6b7c-4ac5-8cbb-671454d33d89' as TenantId,
			retry: false,
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'structured',
				// Set explicitly. The trigger measures against the CONTEXT
				// WINDOW, not `tokenBudget` — a run that leaves this unset
				// falls back to the model table, which for a mock model is
				// large enough that no fixture of a sane size ever triggers.
				contextWindowTokens: opts.tokenBudget,
				triggerThreshold: 0.7,
				resetThreshold: 0.4,
				keepRecentMessages: 2,
				clearToolResults: true,
				keepRecentToolResults: 0,
				minToolResultCharsToClear: 1_000,
			}),
		},
		(event: RunEvent) => {
			seen.push(event)
		},
	)
	return { events: seen, messages: run.messages }
}

describe('clearing tool results is on the wire, not only in a log line', () => {
	it('reports the clear with an exact count when it relieves enough pressure', async () => {
		// Two oversized results and little else, so the clear alone brings the
		// context back under the trigger. Deleting the `emitEvent` call leaves
		// the run behaving identically and fails only here.
		const { events, messages } = await runWith({
			resultChars: 80_000,
			filler: 2,
			tokenBudget: 40_000,
		})

		const cleared = events.filter((e) => e.type === 'compaction_tool_results_cleared')

		expect(cleared).toHaveLength(1)
		const [event] = cleared as [Extract<RunEvent, { type: 'compaction_tool_results_cleared' }>]
		expect(event.clearedCount).toBe(2)
		// Both results, not one: a single 80k result cannot account for this.
		// Bounded above too — the clear leaves a placeholder behind, so a
		// number at or over the full 160k would mean it reported chars it did
		// not actually remove.
		expect(event.charsReclaimed).toBeGreaterThan(80_000)
		expect(event.charsReclaimed).toBeLessThan(160_000)
		// Token savings compare the actual messages before and after, using
		// the same rounding and modality costs as the live context estimate.
		const before = [...toolResult('t1', 80_000), ...toolResult('t2', 80_000)]
		const after = messages.filter((m) => m.role === 'tool')
		expect(event.reclaimedTokens).toBe(
			estimateMessagesTokens(before.filter((m) => m.role === 'tool')) -
				estimateMessagesTokens(after),
		)
		expect(event.reliefWasEnough).toBe(true)
	})

	it('reports the clear BEFORE the compaction it was not enough to prevent', async () => {
		// The branch that would have stayed silent under an
		// emit-only-when-relieved implementation. The history takes two edits
		// in one pass here, and a reader seeing only `compaction_completed`
		// would attribute the whole loss to summarization.
		const { events } = await runWith({ resultChars: 80_000, filler: 140, tokenBudget: 40_000 })

		const order = events
			.map((e) => e.type)
			.filter((t) => t === 'compaction_tool_results_cleared' || t === 'compaction_completed')

		expect(order[0], 'the clear did not come first').toBe('compaction_tool_results_cleared')
		expect(order).toContain('compaction_completed')

		const cleared = events.find((e) => e.type === 'compaction_tool_results_cleared') as Extract<
			RunEvent,
			{ type: 'compaction_tool_results_cleared' }
		>
		expect(cleared.reliefWasEnough).toBe(false)
	})

	it('is durable, not ephemeral, so the transcript records the edit', () => {
		// The event exists so `transcript.jsonl` can explain why a tool result
		// it shows is empty. Adding it to `EPHEMERAL_EVENT_TYPES` — where the
		// deltas and progress pings live — would keep every assertion above
		// green and delete it from the one record that outlives the run.
		expect(
			isEphemeralEvent({
				type: 'compaction_tool_results_cleared',
				runId: 'f4e0af37-43f7-48fd-82b0-f1b1c68881d3',
				iteration: 1,
				clearedCount: 1,
				charsReclaimed: 10,
				reclaimedTokens: 3,
				reliefWasEnough: true,
			} as never),
		).toBe(false)
	})
})
