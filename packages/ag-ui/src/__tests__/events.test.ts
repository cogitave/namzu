import { HttpAgent } from '@ag-ui/client'
import { type BaseEvent, EventSchemas, EventType } from '@ag-ui/core'
import { EventEncoder } from '@ag-ui/encoder'
import type { MessageId, RunEvent, RunId, StopReason, ToolUseId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { AGUIEventMapper, type AGUIEventMapperOptions } from '../events.js'

const RUN = '3f747aa4-e0fc-4278-ae40-f895280bb9fe' as RunId
const CHILD = 'b272c51e-296e-4d1f-ac1c-43b5e4b5e572' as RunId
const MESSAGE = 'native-message' as MessageId
const OTHER_MESSAGE = 'other-native-message' as MessageId
const TOOL = 'native-tool' as ToolUseId
const OTHER_TOOL = 'other-native-tool' as ToolUseId
const OPTIONS: AGUIEventMapperOptions = {
	threadId: 'thread:opaque/one',
	runId: '',
	nativeRunId: RUN,
}

function native<K extends RunEvent['type']>(
	type: K,
	fields: Omit<Extract<RunEvent, { type: K }>, 'type' | 'runId'>,
	runId = RUN,
): Extract<RunEvent, { type: K }> {
	return { type, runId, ...fields } as Extract<RunEvent, { type: K }>
}

function messageStarted(messageId = MESSAGE): RunEvent {
	return native('message_started', { messageId, iteration: 1 })
}

function textDelta(text: string, messageId = MESSAGE): RunEvent {
	return native('text_delta', { messageId, iteration: 1, text })
}

function messageCompleted(content?: string, messageId = MESSAGE): RunEvent {
	return native('message_completed', { messageId, iteration: 1, stopReason: 'end_turn', content })
}

function toolStarted(toolUseId = TOOL, messageId = MESSAGE): RunEvent {
	return native('tool_input_started', { toolUseId, messageId, iteration: 1, toolName: 'lookup' })
}

function runCompleted(stopReason?: StopReason, result = ''): RunEvent {
	return native('run_completed', { result, stopReason })
}

function mapAll(input: RunEvent[]): BaseEvent[] {
	const mapper = new AGUIEventMapper(OPTIONS)
	const events = [
		...mapper.start(),
		...input.flatMap((event) => mapper.map(event)),
		...mapper.finish(),
	]
	for (const event of events)
		expect(EventSchemas.safeParse(event).success, JSON.stringify(event)).toBe(true)
	return events
}

function ofType(events: BaseEvent[], type: EventType): BaseEvent[] {
	return events.filter((event) => event.type === type)
}

function text(events: BaseEvent[], messageId = MESSAGE): string {
	return ofType(events, EventType.TEXT_MESSAGE_CONTENT)
		.filter((event) => event.messageId === messageId)
		.map((event) => event.delta)
		.join('')
}

function args(events: BaseEvent[], toolCallId = TOOL): string {
	return ofType(events, EventType.TOOL_CALL_ARGS)
		.filter((event) => event.toolCallId === toolCallId)
		.map((event) => event.delta)
		.join('')
}

/** Exercise the official verifier and message reducer through its real SSE boundary. */
async function applyWithOfficialClient(events: BaseEvent[]) {
	const encoder = new EventEncoder()
	const agent = new HttpAgent({
		url: 'https://example.test/agent',
		threadId: OPTIONS.threadId,
		fetch: async () =>
			new Response(events.map((event) => encoder.encode(event)).join(''), {
				headers: { 'content-type': 'text/event-stream' },
			}),
	})
	const result = await agent.runAgent({ runId: OPTIONS.runId })
	return { agent, result }
}

describe('AGUIEventMapper', () => {
	it('preserves opaque wire IDs and emits one terminal lifecycle', () => {
		const mapper = new AGUIEventMapper(OPTIONS)
		expect(mapper.ended).toBe(false)
		expect(mapper.start()).toEqual([
			{ type: EventType.RUN_STARTED, threadId: 'thread:opaque/one', runId: '' },
		])
		expect(mapper.start()).toEqual([])
		expect(mapper.map(native('run_started', { systemPrompt: 'private' }))).toEqual([])
		expect(mapper.map(runCompleted())).toEqual([
			{
				type: EventType.RUN_FINISHED,
				threadId: OPTIONS.threadId,
				runId: '',
				result: '',
				outcome: { type: 'success' },
			},
		])
		expect(mapper.ended).toBe(true)
		expect(mapper.map(runCompleted())).toEqual([])
		expect(mapper.map(textDelta('late'))).toEqual([])
		expect(mapper.finish()).toEqual([])
		expect(mapper.fail('late error')).toEqual([])
		expect(mapper.start()).toEqual([])
	})

	it('does not duplicate streamed text with completed message content or the run result', async () => {
		const events = mapAll([
			native('iteration_started', { iteration: 1 }),
			messageStarted(),
			textDelta('Hello '),
			textDelta('world'),
			messageCompleted('Hello world'),
			messageCompleted('Hello world'),
			native('iteration_completed', { iteration: 1, hasToolCalls: false }),
			runCompleted('end_turn', 'Hello world'),
		])
		expect(text(events)).toBe('Hello world')
		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.STEP_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.STEP_FINISHED,
			EventType.RUN_FINISHED,
		])
		const { agent, result } = await applyWithOfficialClient(events)
		expect(agent.messages).toEqual([{ id: MESSAGE, role: 'assistant', content: 'Hello world' }])
		expect(result.result).toBe('Hello world')
	})

	it('recovers aggregate text when ephemeral deltas are unavailable and ignores late deltas', () => {
		const events = mapAll([
			messageCompleted('Recovered'),
			textDelta('late'),
			messageCompleted('Recovered'),
			runCompleted('end_turn', 'Recovered'),
		])
		expect(text(events)).toBe('Recovered')
		expect(ofType(events, EventType.TEXT_MESSAGE_START)).toHaveLength(1)
		expect(ofType(events, EventType.TEXT_MESSAGE_END)).toHaveLength(1)
	})

	it('recovers a missing trailing delta from the completed aggregate', () => {
		const events = mapAll([
			messageStarted(),
			textDelta('Retained '),
			messageCompleted('Retained prefix and missing suffix'),
			runCompleted(),
		])
		expect(text(events)).toBe('Retained prefix and missing suffix')
		expect(ofType(events, EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta)).toEqual([
			'Retained ',
			'prefix and missing suffix',
		])
	})

	it('reports a conflicting completion instead of silently appending incorrect text', () => {
		const events = mapAll([
			messageStarted(),
			textDelta('Wrong prefix'),
			messageCompleted('Different aggregate'),
			runCompleted(),
		])
		expect(text(events)).toBe('Wrong prefix')
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'NAMZU_MESSAGE_CONTENT_MISMATCH',
		})
		expect(ofType(events, EventType.TEXT_MESSAGE_END)).toHaveLength(1)
	})

	it('preserves equal consecutive deltas and deduplicates events only when a durable sequence exists', () => {
		const events = mapAll([
			messageStarted(),
			messageStarted(),
			textDelta('ha'),
			textDelta('ha'),
			{ ...textDelta('!'), seq: 7 },
			{ ...textDelta('!'), seq: 7 },
			messageCompleted('haha!'),
			runCompleted(),
		])
		expect(text(events)).toBe('haha!')
		expect(ofType(events, EventType.TEXT_MESSAGE_START)).toHaveLength(1)
	})

	it('keeps interleaved messages and tool arguments attached to their actual native identities', async () => {
		const events = mapAll([
			messageStarted(),
			textDelta('First '),
			toolStarted(),
			native('tool_input_delta', { toolUseId: TOOL, partialJson: '{"city":' }),
			messageStarted(OTHER_MESSAGE),
			textDelta('Second', OTHER_MESSAGE),
			toolStarted(OTHER_TOOL, OTHER_MESSAGE),
			native('tool_input_delta', { toolUseId: OTHER_TOOL, partialJson: '{"city":"Rome"}' }),
			textDelta('message'),
			native('tool_input_delta', { toolUseId: TOOL, partialJson: '"Paris"}' }),
			native('tool_input_completed', { toolUseId: TOOL, input: { city: 'Paris' } }),
			native('tool_input_completed', { toolUseId: OTHER_TOOL, input: { city: 'Rome' } }),
			messageCompleted('First message'),
			messageCompleted('Second', OTHER_MESSAGE),
			runCompleted(),
		])
		expect(text(events)).toBe('First message')
		expect(text(events, OTHER_MESSAGE)).toBe('Second')
		expect(args(events)).toBe('{"city":"Paris"}')
		expect(args(events, OTHER_TOOL)).toBe('{"city":"Rome"}')
		expect(ofType(events, EventType.TOOL_CALL_START)).toEqual([
			expect.objectContaining({ toolCallId: TOOL, parentMessageId: MESSAGE }),
			expect.objectContaining({ toolCallId: OTHER_TOOL, parentMessageId: OTHER_MESSAGE }),
		])
		const { agent } = await applyWithOfficialClient(events)
		expect(agent.messages).toEqual([
			expect.objectContaining({
				id: MESSAGE,
				content: 'First message',
				toolCalls: [expect.objectContaining({ id: TOOL })],
			}),
			expect.objectContaining({
				id: OTHER_MESSAGE,
				content: 'Second',
				toolCalls: [expect.objectContaining({ id: OTHER_TOOL })],
			}),
		])
	})

	it('announces tool-only assistant messages and sends complete input exactly once', async () => {
		const events = mapAll([
			toolStarted(),
			native('tool_input_completed', { toolUseId: TOOL, input: { city: 'Paris' } }),
			messageCompleted(),
			native('tool_executing', { toolUseId: TOOL, toolName: 'lookup', input: { city: 'Paris' } }),
			native('tool_completed', {
				toolUseId: TOOL,
				toolName: 'lookup',
				result: 'Sunny',
				isError: false,
			}),
			native('tool_completed', {
				toolUseId: TOOL,
				toolName: 'lookup',
				result: 'Sunny',
				isError: false,
			}),
			runCompleted(),
		])
		expect(args(events)).toBe('{"city":"Paris"}')
		expect(events[1]).toEqual({
			type: EventType.TEXT_MESSAGE_START,
			messageId: MESSAGE,
			role: 'assistant',
		})
		expect(ofType(events, EventType.TOOL_CALL_START)).toHaveLength(1)
		expect(ofType(events, EventType.TOOL_CALL_END)).toHaveLength(1)
		const results = ofType(events, EventType.TOOL_CALL_RESULT)
		expect(results).toHaveLength(1)
		expect(results[0]?.messageId).not.toBe(MESSAGE)
		expect(results[0]?.messageId).not.toBe(TOOL)
		const { agent } = await applyWithOfficialClient(events)
		expect(agent.messages).toEqual([
			expect.objectContaining({
				id: MESSAGE,
				role: 'assistant',
				toolCalls: [expect.objectContaining({ id: TOOL })],
			}),
			expect.objectContaining({
				id: results[0]?.messageId,
				role: 'tool',
				toolCallId: TOOL,
				content: 'Sunny',
			}),
		])
	})

	it('maps executor-only calls using an announced synthetic parent', async () => {
		const events = mapAll([
			native('tool_executing', { toolUseId: TOOL, toolName: 'lookup', input: {} }),
			native('tool_completed', {
				toolUseId: TOOL,
				toolName: 'lookup',
				result: 'Done',
				isError: false,
			}),
			runCompleted(),
		])
		const parent = ofType(events, EventType.TEXT_MESSAGE_START)[0]?.messageId
		expect(ofType(events, EventType.TOOL_CALL_START)[0]?.parentMessageId).toBe(parent)
		expect(ofType(events, EventType.TEXT_MESSAGE_END)[0]?.messageId).toBe(parent)
		expect(args(events)).toBe('{}')
		await applyWithOfficialClient(events)
	})

	it('does not close an existing native message when executor-only calls arrive', async () => {
		const events = mapAll([
			messageStarted(),
			native('tool_executing', { toolUseId: TOOL, toolName: 'lookup', input: {} }),
			textDelta('Kept'),
			messageCompleted('Kept'),
			runCompleted(),
		])
		expect(text(events)).toBe('Kept')
		await applyWithOfficialClient(events)
	})

	it('preserves a failed tool outcome without terminating a run that recovers', () => {
		const events = mapAll([
			toolStarted(),
			native('tool_input_completed', { toolUseId: TOOL, input: {} }),
			native('tool_completed', {
				toolUseId: TOOL,
				toolName: 'lookup',
				result: 'Unavailable',
				isError: true,
			}),
			messageCompleted(),
			messageStarted(OTHER_MESSAGE),
			textDelta('Try again later.', OTHER_MESSAGE),
			messageCompleted('Try again later.', OTHER_MESSAGE),
			runCompleted(),
		])
		expect(ofType(events, EventType.TOOL_CALL_RESULT)[0]).toMatchObject({
			content: 'Unavailable',
			metadata: { namzu: { isError: true } },
		})
		expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
	})

	it('counts per-message usage once and exposes only official token fields', () => {
		const completed = native('message_completed', {
			messageId: MESSAGE,
			iteration: 1,
			stopReason: 'end_turn',
			content: 'Done',
			usage: {
				promptTokens: 10,
				completionTokens: 4,
				totalTokens: 14,
				cachedTokens: 3,
				cacheWriteTokens: 2,
				reasoningTokens: 1,
			},
		})
		const events = mapAll([completed, completed, runCompleted()])
		expect(events.at(-1)?.usage).toEqual([
			{
				inputTokens: 10,
				outputTokens: 4,
				totalTokens: 14,
				cachedInputTokens: 3,
				reasoningTokens: 1,
			},
		])
	})

	it('ignores child content and terminals without consuming the root sequence', () => {
		const mapper = new AGUIEventMapper({ threadId: 'thread', runId: 'wire' })
		expect(
			mapper.map({ ...native('run_started', {}, CHILD), lineage: { depth: 1 } } as RunEvent),
		).toEqual([])
		expect(mapper.map(native('run_started', {}))).toHaveLength(1)
		expect(mapper.map({ ...textDelta('private child'), runId: CHILD, seq: 2 })).toEqual([])
		expect(
			mapper.map({ ...native('run_failed', { error: 'child failure' }, CHILD), seq: 3 }),
		).toEqual([])
		expect(mapper.map({ ...textDelta('Root'), seq: 2 })).toEqual([
			{ type: EventType.TEXT_MESSAGE_START, messageId: MESSAGE, role: 'assistant' },
			{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: MESSAGE, delta: 'Root' },
		])
		expect(mapper.ended).toBe(false)
		expect(mapper.map(runCompleted()).at(-1)?.type).toBe(EventType.RUN_FINISHED)
	})

	it('never projects system prompts, context, reasoning, raw events, or failure details', () => {
		const mapper = new AGUIEventMapper(OPTIONS)
		const privateEvents: RunEvent[] = [
			native('request_envelope', {
				iteration: 1,
				model: 'secret',
				systemPrompt: 'secret',
				toolNames: ['secret'],
				toolSchemaDigest: 'secret',
			}),
			native('reasoning_started', {
				iteration: 1,
				messageId: MESSAGE,
				blockIndex: 0,
				reasoningType: 'thinking',
			}),
			native('reasoning_delta', {
				iteration: 1,
				messageId: MESSAGE,
				blockIndex: 0,
				text: 'secret',
			}),
			native('reasoning_completed', {
				iteration: 1,
				messageId: MESSAGE,
				blockIndex: 0,
				text: 'secret',
				signed: true,
			}),
			native('compaction_shed', { iteration: 1, reason: 'threshold', messages: [] }),
		]
		for (const event of privateEvents) expect(mapper.map(event)).toEqual([])
		const events = [
			...mapper.map(native('run_started', { systemPrompt: 'secret' })),
			...mapper.map(native('run_failed', { error: 'secret token https://internal/path' })),
		]
		expect(JSON.stringify(events)).not.toContain('secret')
		expect(events.at(-1)).toEqual({
			type: EventType.RUN_ERROR,
			message: 'Namzu run failed.',
			code: 'NAMZU_RUN_ERROR',
		})
	})

	it.each([
		'token_budget',
		'cost_limit',
		'cost_unmeasurable',
		'timeout',
		'max_iterations',
		'cancelled',
		'plan_rejected',
		'stop_condition',
		'step_refused',
		'structured_output_failed',
		'answer_rejected',
		'input_guardrail',
		'output_guardrail',
		'paused',
		'error',
	] satisfies StopReason[])('reports %s as an unsuccessful terminal outcome', (stopReason) => {
		const events = mapAll([messageStarted(), textDelta('Partial'), runCompleted(stopReason)])
		expect(ofType(events, EventType.RUN_FINISHED)).toEqual([])
		expect(events.at(-2)).toEqual({ type: EventType.TEXT_MESSAGE_END, messageId: MESSAGE })
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: stopReason === 'paused' ? 'NAMZU_RUN_PAUSED' : `NAMZU_${stopReason.toUpperCase()}`,
		})
	})

	it('reports a pause with checkpoint metadata and a terminal error without claiming AG-UI resume', () => {
		const events = mapAll([
			native('run_paused', {
				checkpointId: 'checkpoint' as Extract<RunEvent, { type: 'run_paused' }>['checkpointId'],
				reason: 'private provider details',
			}),
		])
		expect(events).toEqual([
			{ type: EventType.RUN_STARTED, threadId: OPTIONS.threadId, runId: OPTIONS.runId },
			{ type: EventType.CUSTOM, name: 'namzu.run.paused', value: { checkpointId: 'checkpoint' } },
			{ type: EventType.RUN_ERROR, message: 'Namzu run paused.', code: 'NAMZU_RUN_PAUSED' },
		])
	})

	it('closes interleaved open tools, messages, and steps before reporting unexpected EOF', () => {
		const events = mapAll([
			native('iteration_started', { iteration: 1 }),
			messageStarted(),
			textDelta('Partial'),
			toolStarted(),
			native('tool_input_delta', { toolUseId: TOOL, partialJson: '{"open":' }),
			toolStarted(OTHER_TOOL, OTHER_MESSAGE),
		])
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'NAMZU_STREAM_INCOMPLETE',
		})
		expect(ofType(events, EventType.RUN_FINISHED)).toEqual([])
		expect(ofType(events, EventType.TOOL_CALL_END)).toEqual([
			{
				type: EventType.TOOL_CALL_END,
				toolCallId: TOOL,
				metadata: { namzu: { inputTruncated: true } },
			},
			{ type: EventType.TOOL_CALL_END, toolCallId: OTHER_TOOL },
		])
		expect(ofType(events, EventType.TEXT_MESSAGE_END).map((event) => event.messageId)).toEqual([
			MESSAGE,
			OTHER_MESSAGE,
		])
		expect(events.at(-2)).toEqual({ type: EventType.STEP_FINISHED, stepName: 'iteration-1' })
	})

	it('marks truncated tool arguments without emitting the normalized replacement object', () => {
		const events = mapAll([
			toolStarted(),
			native('tool_input_delta', { toolUseId: TOOL, partialJson: '{"text":"cut off' }),
			native('tool_input_completed', { toolUseId: TOOL, input: {}, inputTruncated: true }),
			native('tool_executing', { toolUseId: TOOL, toolName: 'lookup', input: {} }),
			native('tool_completed', {
				toolUseId: TOOL,
				toolName: 'lookup',
				result: 'Input was truncated.',
				isError: true,
			}),
			runCompleted(),
		])
		expect(args(events)).toBe('{"text":"cut off')
		expect(ofType(events, EventType.TOOL_CALL_END)).toEqual([
			{
				type: EventType.TOOL_CALL_END,
				toolCallId: TOOL,
				metadata: { namzu: { inputTruncated: true } },
			},
		])
		expect(ofType(events, EventType.TOOL_CALL_RESULT)[0]?.metadata).toEqual({
			namzu: { isError: true },
		})
	})

	it('does not invent arguments when a truncated call has no retained deltas', () => {
		const events = mapAll([
			toolStarted(),
			native('tool_input_completed', { toolUseId: TOOL, input: {}, inputTruncated: true }),
			runCompleted(),
		])
		expect(ofType(events, EventType.TOOL_CALL_ARGS)).toEqual([])
		expect(ofType(events, EventType.TOOL_CALL_END)[0]?.metadata).toEqual({
			namzu: { inputTruncated: true },
		})
	})

	it('does not hide malformed streamed arguments behind a valid completion object', () => {
		const events = mapAll([
			toolStarted(),
			native('tool_input_delta', { toolUseId: TOOL, partialJson: '{"incomplete":' }),
			native('tool_input_completed', { toolUseId: TOOL, input: { incomplete: 'normalized' } }),
			runCompleted(),
		])
		expect(args(events)).toBe('{"incomplete":')
		expect(ofType(events, EventType.TOOL_CALL_END)[0]?.metadata).toEqual({
			namzu: { inputTruncated: true },
		})
	})

	it('rejects arguments with no known call instead of inventing a tool identity', () => {
		const events = mapAll([native('tool_input_delta', { toolUseId: TOOL, partialJson: '{}' })])
		expect(ofType(events, EventType.TOOL_CALL_START)).toEqual([])
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'NAMZU_TOOL_LIFECYCLE' })
	})

	it('reports non-JSON complete input as an error and closes its opened lifecycle', () => {
		const input: Record<string, unknown> = {}
		input.circular = input
		const events = mapAll([
			toolStarted(),
			native('tool_input_completed', { toolUseId: TOOL, input }),
		])
		expect(ofType(events, EventType.TOOL_CALL_ARGS)).toEqual([])
		expect(ofType(events, EventType.TOOL_CALL_END)).toHaveLength(1)
		expect(ofType(events, EventType.TEXT_MESSAGE_END)).toHaveLength(1)
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'NAMZU_TOOL_INPUT_INVALID',
		})
	})

	it('supports final-result-only producers without sending the result twice', async () => {
		const events = mapAll([runCompleted('end_turn', 'Only result')])
		const { agent, result } = await applyWithOfficialClient(events)
		expect(agent.messages).toEqual([
			expect.objectContaining({ role: 'assistant', content: 'Only result' }),
		])
		expect(result.result).toBe('Only result')
	})

	it('returns the authoritative final result when output review changed the streamed answer', async () => {
		const events = mapAll([
			messageStarted(),
			textDelta('Draft answer'),
			messageCompleted('Draft answer'),
			runCompleted('end_turn', 'Reviewed answer'),
		])
		const { agent, result } = await applyWithOfficialClient(events)
		expect(agent.messages).toEqual([expect.objectContaining({ content: 'Draft answer' })])
		expect(result.result).toBe('Reviewed answer')
	})

	it('closes outstanding steps exactly once on success', async () => {
		const events = mapAll([
			native('iteration_started', { iteration: 1 }),
			native('iteration_started', { iteration: 1 }),
			native('iteration_completed', { iteration: 1, hasToolCalls: false }),
			native('iteration_completed', { iteration: 1, hasToolCalls: false }),
			native('iteration_started', { iteration: 2 }),
			runCompleted(),
		])
		expect(ofType(events, EventType.STEP_STARTED).map((event) => event.stepName)).toEqual([
			'iteration-1',
			'iteration-2',
		])
		expect(ofType(events, EventType.STEP_FINISHED).map((event) => event.stepName)).toEqual([
			'iteration-1',
			'iteration-2',
		])
		await applyWithOfficialClient(events)
	})
})
