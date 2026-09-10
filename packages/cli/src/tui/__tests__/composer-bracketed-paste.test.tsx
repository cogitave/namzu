import { expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'
import { renderToScreen } from './support/screen.js'

it('assembles a fragmented terminal paste once, counts characters and never submits its newlines', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, { cols: 100, rows: 24 })
	const prefix = 'İki subagent ile '
	const text = `${prefix}${'incele '.repeat(20)}\r\nSonuçları yaz 😀`
	const normalized = text.replace(/\r\n?/g, '\n')
	try {
		await screen.waitForRender()
		for (const chunk of ['\x1b[20', '0~', prefix, text.slice(prefix.length), '\x1b[201', '~']) {
			screen.press(chunk)
			await screen.waitForRender()
		}
		const frame = screen.viewport().join('\n')
		expect(frame).toContain(`Pasted text #1 · ${Array.from(normalized).length} chars`)
		expect(frame).not.toContain('Pasted text #2')
		expect(frame).not.toContain(prefix)
		expect(frame).not.toContain('000d')
		expect(onSubmit).not.toHaveBeenCalled()
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(normalized, undefined)
	} finally {
		await screen.unmount()
	}
})

it('inserts a short paste at the cursor without interpreting a pasted return as submit', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, { cols: 100, rows: 24 })
	try {
		await screen.waitForRender()
		screen.press('ab')
		await screen.waitForRender()
		screen.press('\x1b[D')
		await screen.waitForRender()
		screen.press('\x1b[200~İ😀\x1b[201~')
		await screen.waitForRender()
		expect(onSubmit).not.toHaveBeenCalled()
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith('aİ😀b', undefined)
	} finally {
		await screen.unmount()
	}
})
