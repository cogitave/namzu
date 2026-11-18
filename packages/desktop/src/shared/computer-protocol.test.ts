import { describe, expect, it } from 'vitest'
import {
	MAX_COMPUTER_FRAMES,
	MAX_COMPUTER_FRAME_CHARS,
	appKey,
	appLabel,
	keepFrames,
	readComputerFrame,
} from './computer-protocol.js'

const body = (extra: Record<string, unknown> = {}) => ({
	sessionId: 's1',
	toolUseId: 'call-1',
	frameId: 's3',
	action: 'Click left at (812, 403)',
	app: 'Notepad',
	mimeType: 'image/png',
	data: 'iVBORw0KGgo=',
	width: 640,
	height: 360,
	point: { x: 0.5, y: 0.25 },
	...extra,
})

describe('the computer frame a host announces', () => {
	it('reads a picture with the call it belongs to and where a click landed', () => {
		expect(readComputerFrame(body())).toMatchObject({
			toolCallId: 'call-1',
			app: 'Notepad',
			point: { x: 0.5, y: 0.25 },
		})
	})

	it('keeps a click point inside the picture', () => {
		expect(readComputerFrame(body({ point: { x: 4, y: -2 } }))?.point).toEqual({ x: 1, y: 0 })
	})

	it('refuses what does not read: not a PNG, not base64, too big, no size', () => {
		expect(readComputerFrame(body({ mimeType: 'image/svg+xml' }))).toBeUndefined()
		expect(readComputerFrame(body({ data: '<script>' }))).toBeUndefined()
		expect(
			readComputerFrame(body({ data: 'A'.repeat(MAX_COMPUTER_FRAME_CHARS + 1) })),
		).toBeUndefined()
		expect(readComputerFrame(body({ width: 0 }))).toBeUndefined()
		expect(readComputerFrame(null)).toBeUndefined()
	})

	it('keeps the newest few and replaces the picture of the same call', () => {
		let frames: ReturnType<typeof keepFrames> = []
		for (let i = 0; i < MAX_COMPUTER_FRAMES + 3; i++) {
			const frame = readComputerFrame(body({ toolUseId: `call-${i}`, frameId: `s${i}` }))
			if (frame) frames = keepFrames(frames, frame)
		}
		expect(frames).toHaveLength(MAX_COMPUTER_FRAMES)
		expect(frames[0]?.toolCallId).toBe('call-3')
		const again = readComputerFrame(body({ toolUseId: 'call-5', frameId: 'sX' }))
		if (again) frames = keepFrames(frames, again)
		expect(frames.filter((frame) => frame.toolCallId === 'call-5')).toHaveLength(1)
		expect(frames.at(-1)?.frameId).toBe('sX')
	})

	it('compares application names without case or .exe', () => {
		expect(appKey(' Notepad.EXE ')).toBe('notepad')
	})

	it('shows a process name the way a person reads it', () => {
		expect(appLabel('notepad')).toBe('Notepad')
		expect(appLabel('notepad.exe')).toBe('Notepad')
		expect(appLabel('Notepad++')).toBe('Notepad++')
		expect(appLabel('ApplicationFrameHost')).toBe('ApplicationFrameHost')
	})
})
