import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'
import { MARKER_ONLY_PREFIX_MS, SHARED_PREFIX_MS } from '../paste-marker-guard.js'
import { renderToScreen } from './support/screen.js'

// Only the two timer calls are faked: the screen's own settling runs on setImmediate.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
	vi.useRealTimers()
})

const START = '\x1b[200~'
const END = '\x1b[201~'

// Pauses well past the 20 ms after which Ink flushes an incomplete sequence as typed text,
// and up to the longest the guard waits for that prefix.
const cases = [
	...[2, 3, 4, 5].map((at) => ({ which: 'start', at })),
	...[2, 3, 4, 5].map((at) => ({ which: 'end', at })),
] as const

it.each(cases)(
	'a paste whose $which marker is split after $at bytes with a pause is one chip and submits nothing',
	async ({ which, at }) => {
		const onSubmit = vi.fn()
		const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
			cols: 100,
			rows: 24,
		})
		const body = 'first line\r\nsecond line\r\nthird\r\nfourth'
		const marker = which === 'start' ? START : END
		const pause = at >= 4 ? MARKER_ONLY_PREFIX_MS - 1 : SHARED_PREFIX_MS - 1
		const step = async (chunk: string, wait = 0) => {
			screen.press(chunk)
			await screen.waitForRender()
			if (wait > 0) {
				await vi.advanceTimersByTimeAsync(wait)
				await screen.waitForRender()
			}
		}
		try {
			await screen.waitForRender()
			if (which === 'start') {
				await step(marker.slice(0, at), pause)
				await step(`${marker.slice(at)}${body}${END}`)
			} else {
				await step(`${START}${body}${marker.slice(0, at)}`, pause)
				await step(marker.slice(at))
			}
			const frame = screen.viewport().join('\n')
			expect(frame).toContain('❯ [Pasted text #1 +3 lines]')
			expect(frame).not.toContain('[200~')
			expect(frame).not.toContain('[201~')
			expect(frame).not.toContain('first line')
			expect(onSubmit).not.toHaveBeenCalled()
			await step('\r')
			expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
				body.replace(/\r\n?/g, '\n'),
				undefined,
				'submit',
				expect.objectContaining({ source: 'composer' }),
			)
		} finally {
			await screen.unmount()
		}
	},
)

it('a short paste whose start marker is split with a pause is inserted as text, with no marker characters', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	try {
		await screen.waitForRender()
		screen.press('\x1b[20')
		await screen.waitForRender()
		await vi.advanceTimersByTimeAsync(500)
		screen.press('0~hello\x1b[201~')
		await screen.waitForRender()
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('❯ hello')
		expect(frame).not.toContain('[200~')
		expect(frame).not.toContain('[201~')
		expect(onSubmit).not.toHaveBeenCalled()
	} finally {
		await screen.unmount()
	}
})
