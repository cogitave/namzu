/**
 * Current-code invariants asserted (2026-07-12, ses_015 Phase C):
 *
 *   `prepareReplayState` applies `repairDanglingMessages` AFTER
 *   `applyMutations`, so the returned history is provider-valid:
 *
 *   - A mutation that leaves an assistant tool call unmatched (e.g. injecting
 *     a result for only one of a two-call batch) → repair synthesizes an
 *     error placeholder for the remaining call, in `toolCalls` order.
 *   - A mutation that appends a result at the tail (past intervening non-tool
 *     messages) → repair canonicalizes it to sit immediately after its
 *     assistant message.
 *   - An already-valid, canonical checkpoint is returned value-equal.
 *
 *   NOTE: `Mutation` ships only the `injectToolResponse` variant (no delete),
 *   so the "missing result" scenario is modelled by a fork point whose
 *   checkpoint already lacks a result, which is exactly what an interrupted
 *   run persists.
 *
 *   `prepareResumeMessages` is a pure transform: it repairs dangling tool
 *   pairs, then excludes system-role messages (the resume caller pushes fresh
 *   system prompts separately). It never mutates its input.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CheckpointId, IterationCheckpoint } from '../../../../types/hitl/index.js'
import type { RunId, ToolCallId } from '../../../../types/ids/index.js'
import type { AssistantMessage, Message, ToolMessage } from '../../../../types/message/index.js'
import type { Mutation } from '../../../../types/run/replay.js'
import { prepareReplayState, prepareResumeMessages } from '../prepare.js'

const RUN_ID = 'run_source' as RunId
const MISSING = '[SYSTEM] Tool result missing: run was interrupted before this tool completed.'

function makeCheckpoint(messages: Message[]): IterationCheckpoint {
	return {
		id: 'cp_repair' as CheckpointId,
		runId: RUN_ID,
		iteration: 1,
		messages,
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
		guardState: { iterationCount: 1, elapsedMs: 0 },
		createdAt: Date.now(),
	}
}

function assistantWithCalls(callIds: string[], timestamp?: number): AssistantMessage {
	return {
		role: 'assistant',
		content: null,
		...(timestamp !== undefined && { timestamp }),
		toolCalls: callIds.map((id) => ({
			id,
			type: 'function',
			function: { name: 'noop', arguments: '{}' },
		})),
	}
}

describe('prepareReplayState — repair composition', () => {
	let baseDir: string

	beforeEach(async () => {
		const wrapper = await mkdtemp(join(tmpdir(), 'namzu-repair-composition-'))
		baseDir = join(wrapper, 'runs')
		await mkdir(baseDir, { recursive: true })
	})

	async function seed(cp: IterationCheckpoint): Promise<void> {
		const cpDir = join(baseDir, cp.runId, 'checkpoints')
		await mkdir(cpDir, { recursive: true })
		await writeFile(join(cpDir, `${cp.id}.json`), JSON.stringify(cp), 'utf-8')
	}

	it('synthesizes a result for a call the mutation left unmatched', async () => {
		await seed(
			makeCheckpoint([
				{ role: 'user', content: 'run tools' },
				assistantWithCalls(['call_a', 'call_b'], 1000),
			]),
		)

		const mutations: Mutation[] = [
			{
				type: 'injectToolResponse',
				toolCallId: 'call_a' as ToolCallId,
				response: { success: true, output: 'mocked-a' },
			},
		]

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: 'cp_repair' as CheckpointId,
			mutate: mutations,
		})

		expect(prepared.messages).toHaveLength(4)
		const [, , resultA, resultB] = prepared.messages as [Message, Message, ToolMessage, ToolMessage]
		expect(resultA.toolCallId).toBe('call_a')
		expect(resultA.content).toBe('mocked-a')
		expect(resultB.toolCallId).toBe('call_b')
		expect(resultB.content).toBe(MISSING)
		// Derived from the assistant timestamp, not wall-clock.
		expect(resultB.timestamp).toBe(1001)
	})

	it('relocates a tail-appended injected result to sit after its assistant', async () => {
		await seed(
			makeCheckpoint([
				{ role: 'user', content: 'run tool' },
				assistantWithCalls(['call_a']),
				{ role: 'user', content: 'after' },
			]),
		)

		const mutations: Mutation[] = [
			{
				type: 'injectToolResponse',
				toolCallId: 'call_a' as ToolCallId,
				response: { success: true, output: 'mocked-a' },
			},
		]

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: 'cp_repair' as CheckpointId,
			mutate: mutations,
		})

		// applyMutations appended the result at the tail (after 'after');
		// repair canonicalized it to immediately after the assistant.
		expect(prepared.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
		expect((prepared.messages[2] as ToolMessage).toolCallId).toBe('call_a')
		expect(prepared.messages[3]?.content).toBe('after')
	})

	it('leaves an already-valid checkpoint value-equal', async () => {
		const messages: Message[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'done' },
		]
		await seed(makeCheckpoint(messages))

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: 'cp_repair' as CheckpointId,
		})

		expect(prepared.messages).toEqual(messages)
	})
})

describe('prepareResumeMessages', () => {
	it('repairs a missing result and drops system messages', () => {
		const input: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'go' },
			assistantWithCalls(['call-1'], 42),
		]

		const out = prepareResumeMessages(input)

		expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
		const synth = out[2] as ToolMessage
		expect(synth.toolCallId).toBe('call-1')
		expect(synth.content).toBe(MISSING)
		expect(synth.timestamp).toBe(43)
	})

	it('drops orphaned tool results and system messages', () => {
		const input: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'go' },
			assistantWithCalls(['call-1']),
			{ role: 'tool', content: 'result', toolCallId: 'call-1' },
			{ role: 'tool', content: 'orphan', toolCallId: 'call-999' },
		]

		const out = prepareResumeMessages(input)

		expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
		expect(out.some((m) => m.role === 'tool' && m.toolCallId === 'call-999')).toBe(false)
	})

	it('drops only system messages when the history is already valid', () => {
		const input: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: 'ok' },
			{ role: 'user', content: 'more' },
		]

		const out = prepareResumeMessages(input)

		expect(out).toEqual([
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: 'ok' },
			{ role: 'user', content: 'more' },
		])
	})

	it('does not mutate its input', () => {
		const input: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'go' },
			assistantWithCalls(['call-1']),
		]
		const snapshot = input.map((m) => ({ ...m }))

		prepareResumeMessages(input)

		expect(input).toEqual(snapshot)
		expect(input).toHaveLength(3)
	})
})
