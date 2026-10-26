import { EventEmitter } from 'node:events'

import { render } from 'ink'
import { Box, Text, useInput } from 'ink'
import { createElement, useState } from 'react'
import { describe, expect, it } from 'vitest'

import {
	FOCUS_REPORTING_DISABLE,
	FOCUS_REPORTING_ENABLE,
	installFocusReporting,
	stripFocusReports,
} from './focus-reporting.js'

const ESC = '\u001b'

describe('stripping focus reports', () => {
	it('leaves ordinary input byte-identical', () => {
		for (const chunk of [
			'hello',
			ESC,
			`${ESC}[A`,
			`${ESC}[1;5C`,
			`${ESC}[200~[I${ESC}[201~`,
			'[I and [O typed as text',
			`${ESC}[`,
			`${ESC}[2`,
		]) {
			expect(stripFocusReports(chunk)).toEqual({ text: chunk, events: [] })
		}
	})

	it('removes a report at the start, the middle and the end of a chunk', () => {
		expect(stripFocusReports(`${ESC}[Iabc`)).toEqual({ text: 'abc', events: ['in'] })
		expect(stripFocusReports(`a${ESC}[Ob`)).toEqual({ text: 'ab', events: ['out'] })
		expect(stripFocusReports(`abc${ESC}[I`)).toEqual({ text: 'abc', events: ['in'] })
	})

	it('removes several reports in one chunk, in order, and keeps the keys between them', () => {
		expect(stripFocusReports(`${ESC}[O${ESC}[A${ESC}[I${ESC}[O`)).toEqual({
			text: `${ESC}[A`,
			events: ['out', 'in', 'out'],
		})
	})
})

class FakeStdin extends EventEmitter {
	isTTY = true
	rawCalls: boolean[] = []
	private queue: string[] = []
	read(): string | null {
		return this.queue.shift() ?? null
	}
	setEncoding(): void {}
	setRawMode(value: boolean): void {
		this.rawCalls.push(value)
	}
	ref(): void {}
	unref(): void {}
	resume(): void {}
	pause(): void {}
	press(input: string): void {
		this.queue.push(input)
		this.emit('readable')
	}
}

class FakeStdout extends EventEmitter {
	isTTY = true
	columns = 80
	rows = 24
	writes: string[] = []
	write(text: string): boolean {
		this.writes.push(text)
		return true
	}
}

describe('installing focus reporting', () => {
	it('switches the mode on with raw mode and off with it, and strips what is read', () => {
		const stdin = new FakeStdin()
		const stdout = new FakeStdout()
		const seen: boolean[] = []
		const restore = installFocusReporting(stdin, stdout, (focused) => seen.push(focused))

		stdin.setRawMode(true)
		stdin.setRawMode(true)
		expect(stdout.writes).toEqual([FOCUS_REPORTING_ENABLE])

		stdin.press(`${ESC}[Ox${ESC}[I`)
		expect(stdin.read()).toBe('x')
		expect(seen).toEqual([false, true])

		stdin.setRawMode(false)
		expect(stdout.writes).toEqual([FOCUS_REPORTING_ENABLE, FOCUS_REPORTING_DISABLE])
		expect(stdin.rawCalls).toEqual([true, true, false])

		restore()
		expect(stdout.writes.at(-1)).toBe(FOCUS_REPORTING_DISABLE)
	})

	it('puts the stream back as it found it', () => {
		const stdin = new FakeStdin()
		const originalRead = stdin.read
		const originalRaw = stdin.setRawMode
		const restore = installFocusReporting(stdin, new FakeStdout(), () => undefined)
		expect(stdin.read).not.toBe(originalRead)
		restore()
		expect(stdin.read).toBe(originalRead)
		expect(stdin.setRawMode).toBe(originalRaw)
	})

	it('writes nothing and changes nothing when either stream is not a terminal', () => {
		const stdin = new FakeStdin()
		const stdout = new FakeStdout()
		stdout.isTTY = false
		const originalRead = stdin.read
		const restore = installFocusReporting(stdin, stdout, () => undefined)
		stdin.setRawMode(true)
		restore()
		expect(stdout.writes).toEqual([])
		expect(stdin.read).toBe(originalRead)

		const piped = new FakeStdin()
		piped.isTTY = false
		const out = new FakeStdout()
		installFocusReporting(piped, out, () => undefined)()
		expect(out.writes).toEqual([])
	})

	it('survives a terminal that has gone away', () => {
		const stdin = new FakeStdin()
		const stdout = new FakeStdout()
		stdout.write = () => {
			throw new Error('EIO')
		}
		const restore = installFocusReporting(stdin, stdout, () => undefined)
		expect(() => stdin.setRawMode(true)).not.toThrow()
		expect(() => restore()).not.toThrow()
	})
})

describe('through the input layer', () => {
	function Typed({ onText }: { readonly onText: (text: string) => void }) {
		const [text, setText] = useState('')
		useInput((input) => {
			onText(input)
			setText((previous) => previous + input)
		})
		return createElement(Box, null, createElement(Text, null, `typed:${text}`))
	}

	function mount(filter: boolean) {
		const stdin = new FakeStdin()
		const stdout = new FakeStdout()
		const focus: boolean[] = []
		const typed: string[] = []
		const restore = filter
			? installFocusReporting(stdin, stdout, (focused) => focus.push(focused))
			: () => undefined
		const instance = render(createElement(Typed, { onText: (text) => typed.push(text) }), {
			stdout: stdout as unknown as NodeJS.WriteStream,
			stdin: stdin as unknown as NodeJS.ReadStream,
			stderr: stdout as unknown as NodeJS.WriteStream,
			patchConsole: false,
			exitOnCtrlC: false,
		})
		return {
			stdin,
			focus,
			typed,
			stop: () => {
				instance.unmount()
				restore()
			},
		}
	}

	it('never types a report into the composer, and says who gained and lost focus', () => {
		const { stdin, focus, typed, stop } = mount(true)
		stdin.press(`${ESC}[O`)
		stdin.press(`${ESC}[I`)
		stdin.press('a')
		stop()
		expect(focus).toEqual([false, true])
		expect(typed).toEqual(['a'])
	})

	it('would type them without the filter (the reason the filter exists)', () => {
		const { stdin, typed, stop } = mount(false)
		stdin.press(`${ESC}[O`)
		stop()
		expect(typed.join('')).toContain('[O')
	})
})
