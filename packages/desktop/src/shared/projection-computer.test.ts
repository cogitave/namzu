import { expect, it } from 'vitest'
import { type ComputerFrameView, MAX_COMPUTER_FRAMES } from './computer-protocol.js'
import { applyEvent, emptyThread } from './projection.js'

const frame = (n: number): ComputerFrameView => ({
	sessionId: 's',
	toolCallId: `call-${n}`,
	frameId: `s${n}`,
	action: 'Click',
	mimeType: 'image/png',
	data: 'AAAA',
	width: 4,
	height: 4,
	point: { x: 0.5, y: 0.5 },
})

it('keeps what the model saw after its newest computer actions, and no more than a few', () => {
	let thread = emptyThread()
	for (let n = 0; n < MAX_COMPUTER_FRAMES + 4; n++)
		thread = applyEvent(thread, { kind: 'computer-frame', sessionId: 's', frame: frame(n) })
	expect(thread.computerFrames).toHaveLength(MAX_COMPUTER_FRAMES)
	expect(thread.computerFrames?.[0]?.toolCallId).toBe('call-4')
	expect(thread.computerFrames?.at(-1)?.toolCallId).toBe(`call-${MAX_COMPUTER_FRAMES + 3}`)
})

it('holds the applications a conversation allowed and used', () => {
	const thread = applyEvent(emptyThread(), {
		kind: 'computer-apps',
		sessionId: 's',
		granted: ['Notepad'],
		used: ['Notepad', 'Edge'],
	})
	expect(thread.computerApps).toEqual({ granted: ['Notepad'], used: ['Notepad', 'Edge'] })
})
