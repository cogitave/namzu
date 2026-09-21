import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { isClearedToolResult } from '../../../../compaction/tool-result-editing.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import { TurnRecorder } from '../../../../manager/session/turn-recorder.js'
import { SessionQuery } from '../../../../session-query/index.js'
import { InMemorySessionLog } from '../../../../store/session-log/index.js'
import type { SessionId, TurnId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

const BODY = `${'head '.repeat(500)}ACCOUNT_EVIDENCE_IN_THE_MIDDLE${' tail'.repeat(500)}`

async function context(
	options: {
		strategy?: 'structured' | 'salience'
		force?: boolean
		recordShedHistory?: boolean
		refuseArchive?: boolean
	} = {},
) {
	const config = CompactionConfigSchema.parse({
		strategy: options.strategy ?? 'structured',
		contextWindowTokens: 6_000,
		triggerThreshold: 0.7,
		keepRecentMessages: options.force ? 8 : 2,
		keepRecentToolResults: 0,
		llmVerification: false,
		recordShedHistory: options.recordShedHistory ?? true,
	})
	const manager = new WorkingStateManager(config)
	manager.setTask('Continue the current job.')
	const messages: Message[] = [
		{ role: 'system', content: 'policy '.repeat(1_000) },
		{ role: 'user', content: 'old job' },
		{
			role: 'assistant',
			content: '',
			toolCalls: [{ id: 'job-1', type: 'function', function: { name: 'job', arguments: '{}' } }],
		},
		{ role: 'tool', toolCallId: 'job-1', content: BODY },
		{ role: 'user', content: 'current job' },
		{ role: 'assistant', content: 'working' },
	]
	// The turn's session log, recording the events the compaction phase emits.
	const turnId = '70f44a33-f56a-4b59-bf2e-d722397f9382' as TurnId
	const sessionId = '5c1f0d2e-8b7a-4e3c-9d21-6f4a3b2c1d0e' as SessionId
	const log = new InMemorySessionLog({ sessionId })
	const sink = new TurnRecorder({
		turnId,
		agentId: 'a',
		agentName: 'A',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log: NOOP_LOGGER,
		sessionId,
		topicId: '0f0e0d0c-0b0a-4908-8706-050403020100',
		projectId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
		tenantId: '9e8d7c6b-5a49-4838-a726-150403f2e1d0',
		sessionLog: log,
		// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
	} as any)
	await sink.open({ session: { cwd: '/tmp' } })
	await sink.begin({})
	const archiveSawOriginal = vi.fn()
	const invalidate = vi.fn()
	const ctx = {
		turnConfig: { model: 'mock' },
		compactionConfig: config,
		workingStateManager: manager,
		tools: { toLLMTools: () => [] },
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		recorder: {
			turnId,
			currentIteration: 3,
			messages,
			lastPromptTokens: 4_500,
			lastPromptMessageCount: messages.length,
			clearLastPromptTokens: invalidate,
		},
		emitEvent: async (event: SessionEvent) => {
			if (event.type === 'compaction_shed') {
				archiveSawOriginal(messages[3]?.content === BODY)
				if (options.refuseArchive) throw new Error('archive write refused')
			}
			await sink.appendEvent({ ...event, sessionId, turnId } as SessionEvent)
		},
	} as unknown as IterationContext
	/** The compaction records the turn holds, in order. */
	const compactionRecords = async () =>
		(await log.readAll()).entries
			.map((entry) => entry.record)
			.filter((record) => record.type !== 'session_started' && record.type !== 'turn_started')
	return { ctx, messages, log, compactionRecords, archiveSawOriginal, invalidate }
}

describe('clear-only compaction preserves recoverable original evidence', () => {
	it.each([
		{ strategy: 'structured' as const, force: false },
		{ strategy: 'salience' as const, force: false },
		{ strategy: 'structured' as const, force: true },
	])('archives before $strategy clearing (overflow=$force)', async (options) => {
		const { ctx, messages, log, compactionRecords, archiveSawOriginal } = await context(options)
		await runCompactionCheck(ctx, { force: options.force })
		expect(isClearedToolResult(messages[3]?.content)).toBe(true)
		expect(messages[3]?.content).not.toContain('ACCOUNT_EVIDENCE_IN_THE_MIDDLE')
		expect(archiveSawOriginal).toHaveBeenCalledExactlyOnceWith(true)
		expect((await compactionRecords()).map((record) => record.type)).toEqual([
			'compaction_shed',
			'compaction_tool_results_cleared',
			'token_usage_updated',
		])
		const query = new SessionQuery({ log })
		expect(await query.shedHistory()).toMatchObject([
			{
				reason: options.force ? 'overflow' : 'threshold',
				messages: [{ role: 'tool', toolCallId: 'job-1', content: BODY }],
			},
		])
		const full = await query.fullTranscript(messages)
		expect(full.filter((message) => message.content === BODY)).toHaveLength(1)
		expect(full).toContainEqual(messages[3])
	})

	it('honors the explicit archive opt-out', async () => {
		const { ctx, messages, log, archiveSawOriginal } = await context({ recordShedHistory: false })
		await runCompactionCheck(ctx)
		expect(isClearedToolResult(messages[3]?.content)).toBe(true)
		expect(archiveSawOriginal).not.toHaveBeenCalled()
		expect(await new SessionQuery({ log }).shedHistory()).toEqual([])
	})

	it('keeps the original live history when its archive cannot be recorded', async () => {
		const { ctx, messages, compactionRecords, invalidate } = await context({ refuseArchive: true })
		const original = [...messages]
		await expect(runCompactionCheck(ctx)).rejects.toThrow('archive write refused')
		expect(messages).toEqual(original)
		expect(messages[3]?.content).toBe(BODY)
		expect(invalidate).not.toHaveBeenCalled()
		expect(await compactionRecords()).toEqual([])
	})
})
