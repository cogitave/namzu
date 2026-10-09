import { describe, expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
import { turnNotice } from './transcript-layout.js'
import { livePhaseLabel } from './transcript-motion.js'
import { redirectNotes } from './transcript.js'

const started = () => {
	const thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Clean up',
	})
	return applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: {
			kind: 'tool_call',
			toolCallId: 'c1',
			title: 'bash',
			status: 'pending',
			view: { kind: 'terminal', command: 'rm -rf build', output: '' },
		},
	})
}
const ended = (thread: ReturnType<typeof started>) => ({
	...thread,
	running: false,
	stopReason: 'cancelled',
})

describe('the notice under a stopped turn', () => {
	it('says an action that was waiting for an answer did not run', () => {
		let thread = applyEvent(started(), {
			kind: 'permission',
			request: {
				id: 'r1',
				sessionId: 's',
				projectId: 'p',
				calls: [
					{ id: 'c1', name: 'bash', input: { command: 'rm -rf build' }, isDestructive: true },
				],
			},
		})
		thread = applyEvent(thread, { kind: 'permission-cleared', sessionId: 's' })
		expect(turnNotice(ended(thread))).toBe(
			'Stopped. The command waiting for your answer was not run.',
		)
	})

	it('stays a bare Stopped when nothing was waiting', () => {
		expect(turnNotice(ended(started()))).toBe('Stopped.')
	})

	it('names the cause when the window was closed under the reply', () => {
		expect(turnNotice(ended(started()), true)).toBe('Stopped because Namzu was closed.')
		expect(turnNotice({ ...ended(started()), stopReason: 'end_turn' }, true)).toBeUndefined()
	})
})

describe('what a person said when they declined and asked for something else', () => {
	it('is listed so the transcript can show it in their words', () => {
		const thread = applyEvent(
			applyEvent(emptyThread(), {
				kind: 'prompt',
				sessionId: 's',
				prompt: 'Make a page',
			}),
			{
				kind: 'update',
				sessionId: 's',
				projectId: 'p',
				update: {
					kind: 'tool_call',
					toolCallId: 'c9',
					title: 'write',
					status: 'failed',
					view: { kind: 'generic', label: 'index.html', declined: { note: 'call it home.html' } },
				},
			},
		)
		expect(redirectNotes(thread, thread.timeline)).toEqual([
			expect.objectContaining({ text: 'call it home.html' }),
		])
	})
})

describe('the live line before the first action', () => {
	it('says Namzu is reading the message, then names the work once there is some', () => {
		const sent = applyEvent(
			applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Make a page' }),
			{ kind: 'state', sessionId: 's', running: true, queued: [] },
		)
		expect(livePhaseLabel(sent)).toBe('Reading your message')
		expect(
			livePhaseLabel(
				applyEvent(started(), { kind: 'state', sessionId: 's', running: true, queued: [] }),
			),
		).toBe('Working')
	})
})
