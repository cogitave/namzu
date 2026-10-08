import { describe, expect, it } from 'vitest'
import { CONSOLE_INPUT_DEVICE, openConsoleInput } from './console-input.js'

const piped = { stdin: { isTTY: undefined }, stdout: { isTTY: true } }

function io() {
	const calls: string[] = []
	const destroyed: string[] = []
	const stream = { destroy: () => destroyed.push('destroyed') } as unknown as NodeJS.ReadStream
	return {
		calls,
		destroyed,
		stream,
		io: {
			open: (path: string) => {
				calls.push(`open ${path}`)
				return 7
			},
			close: (fd: number) => calls.push(`close ${fd}`),
			stream: (fd: number) => {
				calls.push(`stream ${fd}`)
				return stream
			},
		},
	}
}

describe('openConsoleInput', () => {
	it('opens the console input device when output is a terminal and input is not', () => {
		const fake = io()
		const input = openConsoleInput(piped, 'win32', fake.io)
		expect(CONSOLE_INPUT_DEVICE).toBe('\\\\.\\CONIN$')
		expect(fake.calls).toEqual([`open ${CONSOLE_INPUT_DEVICE}`, 'stream 7'])
		expect(input?.stream).toBe(fake.stream)
		input?.release()
		expect(fake.destroyed).toEqual(['destroyed'])
	})

	it.each([
		['off Windows', piped, 'linux' as const],
		[
			'when input is already a terminal',
			{ stdin: { isTTY: true }, stdout: { isTTY: true } },
			'win32' as const,
		],
		[
			'when output is not a terminal',
			{ stdin: { isTTY: undefined }, stdout: { isTTY: undefined } },
			'win32' as const,
		],
	])('does nothing %s', (_name, streams, platform) => {
		const fake = io()
		expect(openConsoleInput(streams, platform, fake.io)).toBeUndefined()
		expect(fake.calls).toEqual([])
	})

	it('falls back when the device cannot be opened', () => {
		const fake = io()
		fake.io.open = () => {
			throw Object.assign(new Error('no console'), { code: 'ENOENT' })
		}
		expect(openConsoleInput(piped, 'win32', fake.io)).toBeUndefined()
	})

	it('closes the handle and falls back when it is not a terminal', () => {
		const fake = io()
		fake.io.stream = () => {
			throw new Error('not a tty')
		}
		expect(openConsoleInput(piped, 'win32', fake.io)).toBeUndefined()
		expect(fake.calls).toEqual([`open ${CONSOLE_INPUT_DEVICE}`, 'close 7'])
	})
})
