import { describe, expect, it } from 'vitest'

import type { Message } from '../../../types/message/index.js'
import { SteeringBinding, attachSteering, formatSteeringNote } from '../steering.js'

/**
 * `AgentManager.queueMessage` / `drainMessages` have existed for a while and
 * nothing in the iteration loop ever read them — the type says so outright.
 * So a host watching a run go wrong could cancel it, throwing away every tool
 * result already paid for, or reject through the review gate, which only
 * works when a call happens to be pending approval and says "no" when the
 * host meant "yes, but read this first".
 *
 * The delivery is the interesting part. A `tool_use` block must be answered
 * by a `tool_result` with the same id, so there is no legal slot for a user
 * message mid-batch; this codebase had already worked that out for denials,
 * which carry their reason inside the `tool_result` precisely because that is
 * where the model looks.
 */

const toolMessage = (id: string, content: string): Message =>
	({ role: 'tool', content, toolCallId: id, timestamp: 1 }) as unknown as Message

const assistantMessage = (content: string): Message =>
	({ role: 'assistant', content, timestamp: 1 }) as unknown as Message

describe('steering a running turn', () => {
	it('appends the guidance to the last tool result', () => {
		const channel = new SteeringBinding()
		channel.steer('check the tests too')

		const out = attachSteering([toolMessage('a', 'first'), toolMessage('b', 'second')], channel)

		expect(out[0]?.content).toBe('first')
		// The LAST one: it is the final thing the model reads before deciding
		// what to do next, where the first would be buried under every later
		// result.
		expect(out[1]?.content).toContain('second')
		expect(out[1]?.content).toContain('check the tests too')
	})

	it('labels the guidance as the operator speaking, not the tool', () => {
		const channel = new SteeringBinding()
		channel.steer('stop and ask me first')

		const out = attachSteering([toolMessage('a', 'output')], channel)

		// Unlabelled it would read as something `bash` said.
		expect(out[0]?.content).toContain('[Message from the operator')
	})

	it('accumulates repeated calls in order rather than replacing', () => {
		const channel = new SteeringBinding()
		channel.steer('first correction')
		channel.steer('second correction')

		const out = attachSteering([toolMessage('a', 'output')], channel)

		const text = String(out[0]?.content)
		expect(text.indexOf('first correction')).toBeLessThan(text.indexOf('second correction'))
	})

	it('ignores empty and whitespace-only guidance', () => {
		const channel = new SteeringBinding()
		channel.steer('   ')
		channel.steer('')

		expect(channel.pending).toBe(false)
		expect(attachSteering([toolMessage('a', 'output')], channel)[0]?.content).toBe('output')
	})

	it('drains the channel, so guidance is delivered once', () => {
		const channel = new SteeringBinding()
		channel.steer('once')

		attachSteering([toolMessage('a', 'output')], channel)
		const second = attachSteering([toolMessage('b', 'later')], channel)

		expect(channel.pending).toBe(false)
		expect(second[0]?.content).toBe('later')
	})

	it('keeps guidance queued when the batch has no tool result to carry it', () => {
		const channel = new SteeringBinding()
		channel.steer('for the next turn')

		const out = attachSteering([assistantMessage('just text')], channel)

		expect(out[0]?.content).toBe('just text')
		// Not dropped. A turn that called no tools has nothing in flight, so
		// the guidance belongs to the next one.
		expect(channel.pending).toBe(true)
	})

	it('leaves non-text tool content alone and re-queues rather than corrupting it', () => {
		const channel = new SteeringBinding()
		channel.steer('guidance')
		const structured = {
			role: 'tool',
			content: [{ type: 'image', source: 'x' }],
			toolCallId: 'a',
			timestamp: 1,
		} as unknown as Message

		const out = attachSteering([structured], channel)

		expect(out[0]?.content).toEqual([{ type: 'image', source: 'x' }])
		expect(channel.pending).toBe(true)
	})

	it('does nothing at all without a channel', () => {
		const messages = [toolMessage('a', 'output')]

		expect(attachSteering(messages, undefined)).toBe(messages)
	})

	it('formats a note that names who is speaking', () => {
		expect(formatSteeringNote('hello')).toContain('operator')
		expect(formatSteeringNote('hello')).toContain('hello')
	})
})
