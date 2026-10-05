import { describe, expect, it, vi } from 'vitest'

import { createToolPresenter } from '../../registry/tool/presentation.js'
import { fixtureId } from '../../test-support/ids.js'
import { ToolManager } from '../../toolsets/manager.js'
import type { SessionEvent } from '../../types/session/events.js'
import { toAcpSessionUpdate, toAcpStopReason } from './update.js'

/**
 * The mapping, as a pure function over one event.
 *
 * Mirrors `bridge/sse/mapper.test.ts` and exists for the same reason: the
 * server's own tests reach this through a whole handshake, which proves the
 * two arms they happen to use and says nothing about the other eight. A
 * mapper is a table, and a table is tested entry by entry.
 */

const SID = fixtureId.session('acp')
const TID = fixtureId.turn('acp')
const MID = fixtureId.message('a')
const presenter = createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] }))

describe('what this protocol has a word for', () => {
	it('maps a text delta to an assistant chunk', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'text_delta',
					sessionId: SID,
					turnId: TID,
					iteration: 0,
					messageId: MID,
					text: 'hi',
				} as SessionEvent,
				presenter,
			),
		).toEqual({
			kind: 'agent_message_chunk',
			text: 'hi',
			messageId: MID,
			turnId: TID,
			iteration: 0,
		})
	})

	it('maps a reasoning delta to a THOUGHT chunk, not an assistant one', () => {
		// Kept apart because a client renders them differently — folded, dimmed,
		// or not at all. Collapsing the two would put the model's scratch work
		// in the answer.
		expect(
			toAcpSessionUpdate(
				{
					type: 'reasoning_delta',
					sessionId: SID,
					turnId: TID,
					iteration: 0,
					messageId: MID,
					blockIndex: 0,
					text: 'weighing it',
				} as SessionEvent,
				presenter,
			),
		).toEqual({
			kind: 'agent_thought_chunk',
			text: 'weighing it',
			messageId: MID,
			turnId: TID,
			iteration: 0,
			blockId: `${MID}:0`,
		})
	})

	it('maps a tool call to pending, carrying the provider tool-use id', () => {
		const update = toAcpSessionUpdate(
			{
				type: 'tool_executing',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'toolu_7',
				toolName: 'read_file',
				input: { path: 'a.txt' },
			} as SessionEvent,
			presenter,
		)
		expect(update).toMatchObject({
			kind: 'tool_call',
			toolCallId: 'toolu_7',
			status: 'pending',
		})
	})

	it('maps a completed tool call by isError, the field the event carries', () => {
		const ok = toAcpSessionUpdate(
			{
				type: 'tool_completed',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'toolu_7',
				toolName: 'read_file',
				result: 'contents',
			} as SessionEvent,
			presenter,
		)
		const failed = toAcpSessionUpdate(
			{
				type: 'tool_completed',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'toolu_8',
				toolName: 'read_file',
				result: 'nope',
				isError: true,
			} as SessionEvent,
			presenter,
		)
		expect(ok).toMatchObject({ status: 'completed' })
		expect(failed).toMatchObject({ status: 'failed' })
	})

	it('preserves a completed custom tool diff already presented with the real input and result', () => {
		const presentation = {
			kind: 'diff' as const,
			path: 'src/session.ts',
			before: 'old\n',
			after: 'new\n',
		}
		const fallback = vi.fn(presenter.presentResult)
		const update = toAcpSessionUpdate(
			{
				type: 'tool_completed',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'custom-diff',
				toolName: 'plugin-change',
				result: 'Updated file',
				isError: false,
				presentation,
			},
			{ ...presenter, presentResult: fallback },
		)
		expect(update).toEqual({
			kind: 'tool_call',
			toolCallId: 'custom-diff',
			title: 'plugin-change',
			status: 'completed',
			view: presentation,
		})
		expect(fallback).not.toHaveBeenCalled()
	})

	it('renders a non-string tool result rather than dropping it', () => {
		// `result` is typed loosely enough to carry a non-string, and a mapper
		// that only handled the string case would hand a client an empty view
		// for a call that produced something.
		const update = toAcpSessionUpdate(
			{
				type: 'tool_completed',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'toolu_9',
				toolName: 'count',
				result: 42,
			} as unknown as SessionEvent,
			presenter,
		)
		expect(JSON.stringify(update)).toContain('42')
	})

	it('renders a tool result of undefined as empty rather than the string "undefined"', () => {
		// A tool that returned nothing. `String(undefined)` puts the literal
		// word in front of the user, which reads as output the tool produced.
		const update = toAcpSessionUpdate(
			{
				type: 'tool_completed',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'toolu_x',
				toolName: 'noop',
			} as unknown as SessionEvent,
			presenter,
		)
		expect(JSON.stringify(update)).not.toContain('undefined')
	})

	it('maps a completed turn to a turn boundary carrying the reason', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'turn_completed',
					sessionId: SID,
					turnId: TID,
					stopReason: 'end_turn',
				} as SessionEvent,
				presenter,
			),
		).toEqual({ kind: 'turn_ended', stopReason: 'end_turn', reason: 'end_turn', turnId: TID })
	})

	it('maps a failed turn to a turn boundary of error', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'turn_failed',
					sessionId: SID,
					turnId: TID,
					error: 'boom',
				} as SessionEvent,
				presenter,
			),
		).toEqual({
			kind: 'turn_ended',
			stopReason: 'error',
			reason: 'error',
			turnId: TID,
			error: 'boom',
		})
	})
})

describe('progress and failure details', () => {
	it('keeps progress on the existing call shape without widening the update vocabulary', () => {
		const update = toAcpSessionUpdate(
			{
				type: 'tool_progress',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'p',
				toolName: 'custom-tool',
				message: 'Compiled 4 of 8 files',
				fraction: 0.5,
			} as SessionEvent,
			presenter,
		)
		expect(update).toMatchObject({
			kind: 'tool_call',
			toolCallId: 'p',
			status: 'pending',
			progress: { message: 'Compiled 4 of 8 files', fraction: 0.5 },
		})
	})
	it('carries the actual turn failure to a peer', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'turn_failed',
					sessionId: SID,
					turnId: TID,
					error: 'Provider is unavailable',
				} as SessionEvent,
				presenter,
			),
		).toEqual({
			kind: 'turn_ended',
			stopReason: 'error',
			reason: 'error',
			turnId: TID,
			error: 'Provider is unavailable',
		})
	})
})

describe('public message and reasoning lifecycle', () => {
	it('preserves actual public text-part identities and phases without inventing one', () => {
		const event = {
			type: 'text_delta' as const,
			sessionId: SID,
			turnId: TID,
			iteration: 2,
			messageId: MID,
			text: 'checking',
			textPart: { id: 'commentary-1', phase: 'commentary' as const },
		}
		expect(toAcpSessionUpdate(event, presenter)).toEqual({
			kind: 'agent_message_chunk',
			messageId: MID,
			turnId: TID,
			iteration: 2,
			text: 'checking',
			textPart: { id: 'commentary-1', phase: 'commentary' },
			phase: 'commentary',
		})
		const unphased = toAcpSessionUpdate({ ...event, textPart: { id: 'unphased' } }, presenter)
		expect(unphased).not.toHaveProperty('phase')
		expect(unphased).toHaveProperty('textPart', { id: 'unphased' })
	})

	it('carries settled final text and ordered original public items independently of raw commentary', () => {
		const commentary = { id: 'progress', phase: 'commentary' as const, text: 'I will check.' }
		const textParts = [
			commentary,
			{ id: 'answer', phase: 'final_answer' as const, text: 'Verified answer.' },
		]
		const update = toAcpSessionUpdate(
			{
				type: 'message_completed',
				sessionId: SID,
				turnId: TID,
				iteration: 2,
				messageId: MID,
				stopReason: 'end_turn',
				content: 'Verified answer.',
				textParts,
			},
			presenter,
		)
		expect(update).toEqual({
			kind: 'agent_message',
			status: 'completed',
			messageId: MID,
			turnId: TID,
			iteration: 2,
			stopReason: 'end_turn',
			content: 'Verified answer.',
			textParts,
		})
		commentary.text = 'mutated after mapping'
		expect(update).toHaveProperty('textParts.0.text', 'I will check.')
	})

	it('keeps a redacted reasoning block visible through boundaries without copying replay material', () => {
		const start = toAcpSessionUpdate(
			{
				type: 'reasoning_started',
				sessionId: SID,
				turnId: TID,
				iteration: 1,
				messageId: MID,
				blockIndex: 3,
				reasoningType: 'redacted_thinking',
				encrypted: 'private-encrypted',
			} as unknown as SessionEvent,
			presenter,
		)
		const end = toAcpSessionUpdate(
			{
				type: 'reasoning_completed',
				sessionId: SID,
				turnId: TID,
				iteration: 1,
				messageId: MID,
				blockIndex: 3,
				signed: true,
				text: 'private-completion',
				signature: 'private-signature',
				encrypted: 'private-encrypted',
			} as unknown as SessionEvent,
			presenter,
		)
		expect(start).toEqual({
			kind: 'agent_thought',
			status: 'pending',
			messageId: MID,
			turnId: TID,
			iteration: 1,
			blockId: `${MID}:3`,
		})
		expect(end).toEqual({ ...start, status: 'completed' })
		expect(JSON.stringify([start, end])).not.toContain('private')
	})

	it.each([
		['guardrail_rewritten', 'Corrected answer.', 'end_turn', 'end_turn'],
		['guardrail_blocked', '', 'output_guardrail', 'refused'],
	])(
		'carries authoritative %s output, including an empty blocked answer',
		(_source, result, reason, coarse) => {
			const update = toAcpSessionUpdate(
				{
					type: 'turn_completed',
					sessionId: SID,
					turnId: TID,
					result,
					stopReason: reason,
				} as SessionEvent,
				presenter,
			)
			expect(update).toEqual({
				kind: 'turn_ended',
				turnId: TID,
				stopReason: coarse,
				reason,
				result,
			})
		},
	)

	it('distinguishes a parked segment from an attributed cancellation', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'turn_paused',
					sessionId: SID,
					turnId: TID,
					checkpointId: fixtureId.checkpoint('acp'),
					reason: 'awaiting_review',
				},
				presenter,
			),
		).toEqual({ kind: 'turn_ended', turnId: TID, stopReason: 'cancelled', reason: 'paused' })
	})

	it.each([
		{
			failure: {
				code: 'provider_error',
				message: 'zen — could not reach the provider: model "space-bunny-free": request timed out',
				retryable: true,
			},
		},
		{
			providerError: {
				providerId: 'zen',
				kind: 'network',
				detail: 'request timed out',
			},
		},
	])(
		'preserves a checkpointed provider failure explanation without calling the turn cancelled',
		(fault) => {
			const reason =
				'zen — could not reach the provider: model "space-bunny-free": request timed out'
			expect(
				toAcpSessionUpdate(
					{
						type: 'turn_paused',
						sessionId: SID,
						turnId: TID,
						checkpointId: fixtureId.checkpoint('acp'),
						reason,
						...fault,
					} as SessionEvent,
					presenter,
				),
			).toEqual({
				kind: 'turn_ended',
				turnId: TID,
				stopReason: 'cancelled',
				reason: 'paused',
				error: reason,
			})
		},
	)

	it('keeps an ordinary user cancellation free of a manufactured provider error', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'turn_completed',
					sessionId: SID,
					turnId: TID,
					stopReason: 'cancelled',
					result: '',
				} as SessionEvent,
				presenter,
			),
		).toEqual({
			kind: 'turn_ended',
			turnId: TID,
			stopReason: 'cancelled',
			reason: 'cancelled',
			result: '',
		})
	})

	it('identifies the actual settled message rather than guessing from the last chunk', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'turn_completed',
					sessionId: SID,
					turnId: TID,
					result: 'Corrected answer.',
					stopReason: 'end_turn',
					settlement: { resultMessageId: MID },
				} as SessionEvent,
				presenter,
			),
		).toHaveProperty('messageId', MID)
	})

	it('preserves a measured zero duration rather than treating it as missing', () => {
		expect(
			toAcpSessionUpdate(
				{
					type: 'tool_completed',
					sessionId: SID,
					turnId: TID,
					toolUseId: 'fast',
					toolName: 'read_file',
					result: 'done',
					durationMs: 0,
				} as SessionEvent,
				presenter,
			),
		).toHaveProperty('durationMs', 0)
	})
})

describe('what it has no word for', () => {
	it.each([
		'iteration_started',
		'iteration_completed',
		'token_usage_updated',
		'message_started',
		'compaction_completed',
		'plan_ready',
		'activity_created',
	])('returns null for %s rather than inventing a shape', (type) => {
		// `null`, not a throw: a turn emits far more than any one peer surface
		// renders, and "this protocol does not carry that" is an ordinary
		// answer. Forwarding them as a generic blob would put text on a
		// client's screen that nothing there knows how to lay out.
		expect(
			toAcpSessionUpdate(
				{ type, sessionId: SID, turnId: TID } as unknown as SessionEvent,
				presenter,
			),
		).toBeNull()
	})
})

describe('the stop-reason table', () => {
	it.each([
		['end_turn', 'end_turn'],
		['stop_condition', 'end_turn'],
		['max_iterations', 'max_turns'],
		['max_tokens', 'max_turns'],
		['token_budget', 'max_turns'],
		['cost_limit', 'max_turns'],
		['cost_unmeasurable', 'error'],
		['timeout', 'error'],
		['cancelled', 'cancelled'],
		['canceled', 'cancelled'],
		['aborted', 'cancelled'],
		['paused', 'cancelled'],
		['guardrail_blocked', 'refused'],
		['input_guardrail', 'refused'],
		['output_guardrail', 'refused'],
		['step_refused', 'refused'],
		['plan_rejected', 'refused'],
		['answer_rejected', 'refused'],
		['structured_output_failed', 'error'],
		['error', 'error'],
		['provider_error', 'error'],
	])('maps %s to %s', (from, to) => {
		expect(toAcpStopReason(from)).toBe(to)
	})

	it('maps an unrecognised reason to error rather than forwarding it', () => {
		// A peer receiving a word its own union does not contain cannot render
		// it, so forwarding is worse than admitting this bridge does not know.
		expect(toAcpStopReason('something_new')).toBe('error')
	})

	it('treats an absent reason as a normal end', () => {
		// A turn that settled without naming a reason ended normally; calling
		// that `error` would report a failure that did not happen.
		expect(toAcpStopReason(undefined)).toBe('end_turn')
	})

	it('never maps a cancellation spelling to error', () => {
		// Both spellings exist in this tree and a bridge that knew only one
		// would report a user's own cancel as a fault.
		for (const spelling of ['cancelled', 'canceled']) {
			expect(toAcpStopReason(spelling)).toBe('cancelled')
		}
	})
})
