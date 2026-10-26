import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import {
	BACKGROUND_QUERY,
	backgroundFromColorFgBg,
	detectBackground,
	parseBackgroundReply,
	queryTerminalBackground,
} from '../theme-detect.js'

describe('COLORFGBG', () => {
	it.each([
		['0;15', 'light'],
		['15;0', 'dark'],
		['0;8', 'dark'],
		['7;6', 'dark'],
		['0;7', 'light'],
		['0;default;15', 'light'],
		['0;9', 'light'],
	])('%s is %s', (value, expected) => {
		expect(backgroundFromColorFgBg(value)).toBe(expected)
	})

	it.each([undefined, '', '0;', 'a;b', '0;16', '0;-1'])('ignores %s', (value) => {
		expect(backgroundFromColorFgBg(value)).toBeUndefined()
	})
})

describe('the terminal’s reply', () => {
	it('reads four-digit and two-digit channels', () => {
		expect(parseBackgroundReply('\x1b]11;rgb:ffff/ffff/ffff\x07')).toBe('light')
		expect(parseBackgroundReply('\x1b]11;rgb:0000/0000/0000\x07')).toBe('dark')
		expect(parseBackgroundReply('\x1b]11;rgb:ff/ff/ff\x1b\\')).toBe('light')
		expect(parseBackgroundReply('\x1b]11;rgb:1c/1c/1c\x07')).toBe('dark')
	})

	it('reads a hex colour', () => {
		expect(parseBackgroundReply('\x1b]11;#fdf6e3\x07')).toBe('light')
		expect(parseBackgroundReply('\x1b]11;#002b36\x07')).toBe('dark')
	})

	it('decides at half luminance', () => {
		expect(parseBackgroundReply('rgb:80/80/80')).toBe('light')
		expect(parseBackgroundReply('rgb:7f/7f/7f')).toBe('dark')
	})

	it('answers nothing for anything else', () => {
		expect(parseBackgroundReply('hello')).toBeUndefined()
		expect(parseBackgroundReply('rgb:zz/00/00')).toBeUndefined()
		expect(parseBackgroundReply('')).toBeUndefined()
	})
})

describe('the live query', () => {
	function streams(isTTY = true) {
		const input = Object.assign(new EventEmitter(), {
			isTTY,
			isRaw: false,
			raw: [] as boolean[],
			setRawMode(mode: boolean) {
				this.raw.push(mode)
			},
			pause() {},
			resume() {},
		})
		const written: string[] = []
		const output = { isTTY, write: (text: string) => written.push(text) }
		return { input, output, written }
	}

	it('asks once and reads the reply, putting raw mode back', async () => {
		const s = streams()
		const result = queryTerminalBackground(s, new Promise(() => undefined))
		expect(s.written).toEqual([BACKGROUND_QUERY])
		s.input.emit('data', Buffer.from('\x1b]11;rgb:ffff/'))
		s.input.emit('data', Buffer.from('ffff/ffff\x07'))
		await expect(result).resolves.toBe('light')
		expect(s.input.raw).toEqual([true, false])
		expect(s.input.listenerCount('data')).toBe(0)
	})

	it('gives up when told to, with nothing left listening', async () => {
		const s = streams()
		const giveUp: { resolve?: () => void } = {}
		const result = queryTerminalBackground(
			s,
			new Promise<void>((resolve) => {
				giveUp.resolve = resolve
			}),
		)
		giveUp.resolve?.()
		await expect(result).resolves.toBeUndefined()
		expect(s.input.listenerCount('data')).toBe(0)
	})

	it('does not ask when either side is not a terminal', async () => {
		const s = streams(false)
		await expect(queryTerminalBackground(s, new Promise(() => undefined))).resolves.toBeUndefined()
		expect(s.written).toEqual([])
	})
})

describe('detecting', () => {
	it('prefers the terminal’s report, then COLORFGBG, then dark', () => {
		expect(detectBackground('light', { COLORFGBG: '15;0' })).toBe('light')
		expect(detectBackground(undefined, { COLORFGBG: '0;15' })).toBe('light')
		expect(detectBackground(undefined, {})).toBe('dark')
	})
})
