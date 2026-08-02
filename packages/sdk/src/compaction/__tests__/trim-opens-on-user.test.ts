import { describe, expect, it } from 'vitest'

import type { Message } from '../../types/message/index.js'
import { findSafeTrimIndex } from '../dangling.js'

/**
 * After compaction the kept tail IS the conversation: the summary is
 * written as a system message and every driver hoists system messages into
 * their own request parameter, so the first kept message becomes the first
 * message on the wire. A conversation that opens on an assistant turn is
 * rejected.
 *
 * `findSafeTrimIndex` advanced past an orphaned `tool` message and never
 * past an `assistant` one. How often that bit depends on the shape of the
 * history, and the shape that matters most is the worst: in a multi-step
 * turn — the agent working through several tool calls without the user
 * speaking in between — the tail alternates assistant/tool with no user
 * message in it at all, so essentially every boundary landed wrong.
 *
 * The failure was unrecoverable, too. The resulting rejection is not
 * classified as an overflow, so relief never fires and the run dies —
 * compaction, whose whole job is keeping a long run alive, becoming the
 * thing that ends it.
 */

const user = (text: string): Message => ({ role: 'user', content: text })
const answer = (text: string): Message => ({ role: 'assistant', content: text })
const calls = (id: string): Message => ({
	role: 'assistant',
	content: null,
	toolCalls: [{ id, type: 'function', function: { name: 't', arguments: '{}' } }],
})
const result = (id: string): Message => ({ role: 'tool', toolCallId: id, content: 'ok' })

/** user → assistant(call) → tool → assistant(answer), repeated. */
function conversational(turns: number): Message[] {
	const out: Message[] = []
	for (let i = 0; i < turns; i++) {
		out.push(user(`q${i}`), calls(`c${i}`), result(`c${i}`), answer(`a${i}`))
	}
	return out
}

/** One user turn, then the agent working alone — the normal agentic shape. */
function multiStep(steps: number): Message[] {
	const out: Message[] = [user('go')]
	for (let i = 0; i < steps; i++) out.push(calls(`c${i}`), result(`c${i}`))
	out.push(answer('done'))
	return out
}

/** Two tool calls per turn, which shifts the parity of every boundary. */
function wideTurns(turns: number): Message[] {
	const out: Message[] = []
	for (let i = 0; i < turns; i++) {
		out.push(user(`q${i}`), {
			role: 'assistant',
			content: null,
			toolCalls: [
				{ id: `c${i}a`, type: 'function', function: { name: 't', arguments: '{}' } },
				{ id: `c${i}b`, type: 'function', function: { name: 't', arguments: '{}' } },
			],
		})
		out.push(result(`c${i}a`), result(`c${i}b`), answer(`a${i}`))
	}
	return out
}

describe('the kept tail opens the way a conversation opens', () => {
	it.each([
		['one tool call per turn', conversational(6)],
		['two tool calls per turn', wideTurns(6)],
		['a multi-step turn with no user in between', multiStep(6)],
	])('%s', (_name, messages) => {
		for (let keep = 1; keep <= Math.min(12, messages.length); keep++) {
			const index = findSafeTrimIndex(messages, messages.length - keep)
			const kept = messages.slice(index)
			if (kept.length === 0) continue
			expect(kept[0]?.role).toBe('user')
		}
	})

	it('is wrong at every boundary in a multi-step turn without the guard', () => {
		// Recorded so the regression is legible: this shape has exactly one
		// user message, at the front, and the whole tail after it alternates
		// assistant and tool. Any boundary inside it lands on the wrong role.
		const messages = multiStep(6)
		const userTurns = messages.filter((m) => m.role === 'user')
		expect(userTurns).toHaveLength(1)
		expect(messages.indexOf(userTurns[0] as Message)).toBe(0)

		for (let keep = 1; keep < messages.length; keep++) {
			const index = findSafeTrimIndex(messages, messages.length - keep)
			// The only valid boundary in this shape is the very front.
			expect(index).toBe(0)
		}
	})
})

describe('when no boundary can satisfy both invariants', () => {
	it('does not re-admit an orphaned result to reach a user turn', () => {
		// Already unsendable: the results have no call anywhere. Falling back
		// to the user message at the front would satisfy "opens on user" by
		// breaking "no orphaned result", which is not a fix.
		const messages: Message[] = [user('test'), result('missing-1'), result('missing-2')]
		const kept = messages.slice(findSafeTrimIndex(messages, 1))
		expect(kept).toHaveLength(0)
	})

	it('declines to trim rather than invent a different broken conversation', () => {
		const messages: Message[] = [user('a'), answer('b')]
		const index = findSafeTrimIndex(messages, 1)
		// Index 1 is the assistant. Forward reaches the end; back reaches the
		// user at 0, whose tail is clean — so it keeps more than asked.
		expect(index).toBe(0)
		expect(messages.slice(index)[0]?.role).toBe('user')
	})
})
