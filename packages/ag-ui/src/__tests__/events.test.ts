import { HttpAgent } from '@ag-ui/client'
import { type BaseEvent, EventSchemas, EventType } from '@ag-ui/core'
import { EventEncoder } from '@ag-ui/encoder'
import type {
	MessageId,
	SessionEvent,
	SessionId,
	StopReason,
	ToolUseId,
	TurnId,
	TurnSettlement,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { AGUIEventMapper, type AGUIEventMapperOptions } from '../events.js'

const SESSION = '0199b3a0-0000-7000-8000-0000000000e1' as SessionId
const TURN = '3f747aa4-e0fc-4278-ae40-f895280bb9fe' as TurnId
/** A child session, and its turn: delegated work whose events reach the parent's listener. */
const CHILD_SESSION = '0199b3a0-0000-7000-8000-0000000000e2' as SessionId
const CHILD = 'b272c51e-296e-4d1f-ac1c-43b5e4b5e572' as TurnId
const SETTLEMENT: TurnSettlement = {
	status: 'completed',
	iterations: 1,
	usage: {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	},
	cost: {
		inputCostPer1M: 0,
		outputCostPer1M: 0,
		totalCost: 0,
		cacheDiscount: 0,
		unpricedTokens: 0,
	},
	durationMs: 0,
	resultSource: 'model',
	abandonedTaskIds: [],
	abandonedJobIds: [],
}
const FAILED: TurnSettlement = { ...SETTLEMENT, status: 'failed' }
/** The fields `turn_started` requires and these tests do not look at. */
const STARTED = {
	userMessageId: 'native-prompt' as MessageId,
	config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
}
const MESSAGE = 'native-message' as MessageId
const OTHER_MESSAGE = 'other-native-message' as MessageId
const TOOL = 'native-tool' as ToolUseId
const OTHER_TOOL = 'other-native-tool' as ToolUseId
const OPTIONS: AGUIEventMapperOptions = {
	threadId: 'thread:opaque/one',
	runId: '',
	sessionId: SESSION,
	turnId: TURN,
}

function native<K extends SessionEvent['type']>(
	type: K,
	fields: Omit<Extract<SessionEvent, { type: K }>, 'type' | 'sessionId' | 'turnId'>,
	turnId: TurnId = TURN,
	sessionId: SessionId = SESSION,
): Extract<SessionEvent, { type: K }> {
	return { type, sessionId, turnId, ...fields } as Extract<SessionEvent, { type: K }>
}

function messageStarted(messageId = MESSAGE): SessionEvent {
	return native('message_started', { messageId, iteration: 1 })
}

function textDelta(text: string, messageId = MESSAGE): SessionEvent {
	return native('text_delta', { messageId, iteration: 1, text })
}

function messageCompleted(content?: string, messageId = MESSAGE): SessionEvent {
	return native('message_completed', { messageId, iteration: 1, stopReason: 'end_turn', content })
}

function toolStarted(toolUseId = TOOL, messageId = MESSAGE): SessionEvent {
	return native('tool_input_started', { toolUseId, messageId, iteration: 1, toolName: 'lookup' })
}

function turnCompleted(stopReason?: StopReason, result = ''): SessionEvent {
	return native('turn_completed', { result, stopReason, settlement: SETTLEMENT })
}

function mapAll(input: SessionEvent[]): BaseEvent[] {
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
		expect(mapper.map(native('turn_started', { ...STARTED, systemPrompt: 'private' }))).toEqual([])
		expect(mapper.map(turnCompleted())).toEqual([
			{
				type: EventType.RUN_FINISHED,
				threadId: OPTIONS.threadId,
				runId: '',
				result: '',
				outcome: { type: 'success' },
			},
		])
		expect(mapper.ended).toBe(true)
		expect(mapper.map(turnCompleted())).toEqual([])
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
			turnCompleted('end_turn', 'Hello world'),
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
			turnCompleted('end_turn', 'Recovered'),
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
			turnCompleted(),
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
			turnCompleted(),
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
			turnCompleted(),
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
			turnCompleted(),
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
			turnCompleted(),
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
			turnCompleted(),
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
			turnCompleted(),
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
			turnCompleted(),
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
		const events = mapAll([completed, completed, turnCompleted()])
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
			mapper.map({
				...native('turn_started', STARTED, CHILD, CHILD_SESSION),
				lineage: { depth: 1 },
			} as SessionEvent),
		).toEqual([])
		expect(mapper.map(native('turn_started', STARTED))).toHaveLength(1)
		expect(
			mapper.map({
				...textDelta('private child'),
				sessionId: CHILD_SESSION,
				turnId: CHILD,
				seq: 2,
			}),
		).toEqual([])
		expect(
			mapper.map({
				...native(
					'turn_failed',
					{ error: 'child failure', settlement: FAILED },
					CHILD,
					CHILD_SESSION,
				),
				seq: 3,
			}),
		).toEqual([])
		expect(mapper.map({ ...textDelta('Root'), seq: 2 })).toEqual([
			{ type: EventType.TEXT_MESSAGE_START, messageId: MESSAGE, role: 'assistant' },
			{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: MESSAGE, delta: 'Root' },
		])
		expect(mapper.ended).toBe(false)
		expect(mapper.map(turnCompleted()).at(-1)?.type).toBe(EventType.RUN_FINISHED)
	})

	it('never projects system prompts, context, reasoning, raw events, or failure details', () => {
		const mapper = new AGUIEventMapper(OPTIONS)
		const privateEvents: SessionEvent[] = [
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
			...mapper.map(native('turn_started', { ...STARTED, systemPrompt: 'secret' })),
			...mapper.map(
				native('turn_failed', { error: 'secret token https://internal/path', settlement: FAILED }),
			),
		]
		expect(JSON.stringify(events)).not.toContain('secret')
		expect(events.at(-1)).toEqual({
			type: EventType.RUN_ERROR,
			message: 'Namzu turn failed.',
			code: 'NAMZU_TURN_ERROR',
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
		const events = mapAll([messageStarted(), textDelta('Partial'), turnCompleted(stopReason)])
		expect(ofType(events, EventType.RUN_FINISHED)).toEqual([])
		expect(events.at(-2)).toEqual({ type: EventType.TEXT_MESSAGE_END, messageId: MESSAGE })
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: stopReason === 'paused' ? 'NAMZU_TURN_PAUSED' : `NAMZU_${stopReason.toUpperCase()}`,
		})
	})

	it('reports a pause nobody turned into interrupts as an error, without leaking the checkpoint', () => {
		const events = mapAll([
			native('turn_paused', {
				checkpointId: 'checkpoint' as Extract<
					SessionEvent,
					{ type: 'turn_paused' }
				>['checkpointId'],
				reason: 'private provider details',
			}),
		])
		expect(events).toEqual([
			{ type: EventType.RUN_STARTED, threadId: OPTIONS.threadId, runId: OPTIONS.runId },
			{ type: EventType.RUN_ERROR, message: 'Namzu turn paused.', code: 'NAMZU_TURN_PAUSED' },
		])
		expect(JSON.stringify(events)).not.toContain('checkpoint')
	})

	it('holds a pause open for the interrupts that end the run', () => {
		const mapper = new AGUIEventMapper(OPTIONS)
		const events = [
			...mapper.start(),
			...[messageStarted(), textDelta('Checking'), toolStarted()].flatMap((event) =>
				mapper.map(event),
			),
			...mapper.map(
				native('turn_paused', {
					checkpointId: 'checkpoint' as Extract<
						SessionEvent,
						{ type: 'turn_paused' }
					>['checkpointId'],
					reason: 'Sign in first.',
					handoff: { kind: 'human-required', reason: 'Sign in first.' },
				}),
			),
		]
		expect(mapper.ended).toBe(true)
		expect(mapper.paused).toEqual({
			checkpointId: 'checkpoint',
			reason: 'Sign in first.',
			handoff: { kind: 'human-required', reason: 'Sign in first.' },
		})
		// Nothing after the pause is mapped.
		expect(mapper.map(textDelta('late'))).toEqual([])
		const closing = mapper.interrupt([
			{ id: 'int-1', reason: 'namzu:handoff', message: 'Sign in first.' },
		])
		for (const event of [...events, ...closing])
			expect(EventSchemas.safeParse(event).success, JSON.stringify(event)).toBe(true)
		expect(closing.map((event) => event.type)).toEqual([
			EventType.TOOL_CALL_END,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		])
		expect(closing.at(-1)).toEqual({
			type: EventType.RUN_FINISHED,
			threadId: OPTIONS.threadId,
			runId: OPTIONS.runId,
			outcome: {
				type: 'interrupt',
				interrupts: [{ id: 'int-1', reason: 'namzu:handoff', message: 'Sign in first.' }],
			},
		})
		// One terminal event per run.
		expect(mapper.interrupt([{ id: 'int-2', reason: 'x' }])).toEqual([])
		expect(mapper.finish()).toEqual([])
	})

	it('ends a run with its frontend calls unanswered as a completed run', () => {
		const mapper = new AGUIEventMapper(OPTIONS)
		const events = [
			...mapper.start(),
			...mapper.announceTool(TOOL, 'pick_color', { palette: 'warm' }),
			// A call already announced is not announced twice.
			...mapper.announceTool(TOOL, 'pick_color', { palette: 'warm' }),
			...mapper.yieldToClient(),
		]
		for (const event of events)
			expect(EventSchemas.safeParse(event).success, JSON.stringify(event)).toBe(true)
		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.RUN_FINISHED,
		])
		expect(events.at(-1)).toMatchObject({ outcome: { type: 'success' } })
		expect(events.at(-1)).not.toHaveProperty('result')
		expect(ofType(events, EventType.TOOL_CALL_RESULT)).toEqual([])
		expect(ofType(events, EventType.TOOL_CALL_ARGS)).toEqual([
			{ type: EventType.TOOL_CALL_ARGS, toolCallId: TOOL, delta: '{"palette":"warm"}' },
		])
	})

	it('continues carried calls with their result only, and leaves client-produced results to the client', () => {
		const mapper = new AGUIEventMapper({
			...OPTIONS,
			carriedToolCalls: [TOOL, OTHER_TOOL],
			suppressedResults: [OTHER_TOOL],
		})
		const events = [
			...mapper.start(),
			...[
				native('tool_executing', { toolUseId: TOOL, toolName: 'approve_me', input: {} }),
				native('tool_completed', {
					toolUseId: TOOL,
					toolName: 'approve_me',
					result: 'done',
					isError: false,
				}),
				native('tool_executing', { toolUseId: OTHER_TOOL, toolName: 'client_tool', input: {} }),
				native('tool_completed', {
					toolUseId: OTHER_TOOL,
					toolName: 'client_tool',
					result: 'the client said so',
					isError: false,
				}),
			].flatMap((event) => mapper.map(event)),
		]
		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.TOOL_CALL_RESULT,
		])
		expect(events.at(-1)).toMatchObject({ toolCallId: TOOL, content: 'done' })
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
			turnCompleted(),
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
			turnCompleted(),
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
			turnCompleted(),
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
		const events = mapAll([turnCompleted('end_turn', 'Only result')])
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
			turnCompleted('end_turn', 'Reviewed answer'),
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
			turnCompleted(),
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
