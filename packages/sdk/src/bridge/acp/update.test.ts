import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../registry/tool/execute.js'
import { createToolPresenter } from '../../registry/tool/presentation.js'
import { fixtureId } from '../../test-support/ids.js'
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
const presenter = createToolPresenter(new ToolRegistry())

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
		).toEqual({ kind: 'agent_message_chunk', text: 'hi' })
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
		).toEqual({ kind: 'agent_thought_chunk', text: 'weighing it' })
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
		expect(update).toMatchObject({ kind: 'tool_call', toolCallId: 'toolu_7', status: 'pending' })
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
		).toEqual({ kind: 'turn_ended', stopReason: 'end_turn' })
	})

	it('maps a failed turn to a turn boundary of error', () => {
		expect(
			toAcpSessionUpdate(
				{ type: 'turn_failed', sessionId: SID, turnId: TID, error: 'boom' } as SessionEvent,
				presenter,
			),
		).toEqual({ kind: 'turn_ended', stopReason: 'error' })
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
		['cancelled', 'cancelled'],
		['canceled', 'cancelled'],
		['aborted', 'cancelled'],
		['paused', 'cancelled'],
		['guardrail_blocked', 'refused'],
		['plan_rejected', 'refused'],
		['answer_rejected', 'refused'],
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
