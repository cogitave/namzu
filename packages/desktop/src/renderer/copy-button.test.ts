import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { CopyAction, CopyButton, type CopyState, copyPlainText } from './copy-button.js'

afterEach(() => vi.unstubAllGlobals())

it('uses only the narrow write bridge and passes the original reply literally', async () => {
	const copyText = vi.fn(async (_text: string) => {})
	const openExternal = vi.fn()
	vi.stubGlobal('window', { namzu: { copyText, openExternal } })
	const text = '**Raw reply**\r\n\r\n`https://example.org/`\n  Türkçe 🐇  '
	await copyPlainText(text)
	expect(copyText).toHaveBeenCalledExactlyOnceWith(text)
	expect(openExternal).not.toHaveBeenCalled()
	vi.stubGlobal('window', { namzu: {} })
	await expect(copyPlainText(text)).rejects.toThrow('Copy is unavailable')
})

it('does not claim success before a deferred write and allows retry after rejection', async () => {
	let reject!: (error: Error) => void
	const write = vi.fn<(text: string) => Promise<void>>()
	write.mockImplementationOnce(
		() =>
			new Promise<void>((_resolve, fail) => {
				reject = fail
			}),
	)
	write.mockResolvedValueOnce(undefined)
	const states: CopyState[] = []
	const action = new CopyAction(write, (state) => states.push(state))
	action.activate()
	const pending = action.copy('first')
	expect(states).toEqual(['idle', 'pending'])
	await action.copy('duplicate')
	expect(write).toHaveBeenCalledExactlyOnceWith('first')
	reject(new Error('private clipboard error'))
	await pending
	expect(states.at(-1)).toBe('error')
	await action.copy('first')
	expect(states.slice(-2)).toEqual(['pending', 'copied'])
	expect(write.mock.calls).toEqual([['first'], ['first']])
})

it('fences late results after text changes, unmount and StrictMode effect remount', async () => {
	let resolve!: () => void
	const write = vi
		.fn<(text: string) => Promise<void>>()
		.mockImplementationOnce(
			() =>
				new Promise<void>((done) => {
					resolve = done
				}),
		)
		.mockResolvedValue(undefined)
	const states: CopyState[] = []
	const action = new CopyAction(write, (state) => states.push(state))
	action.activate()
	const pending = action.copy('old reply')
	action.reset()
	await action.copy('new reply')
	expect(write).toHaveBeenCalledTimes(1)
	resolve()
	await pending
	expect(states).not.toContain('copied')
	expect(states.at(-1)).toBe('idle')
	await action.copy('new reply')
	expect(states.at(-1)).toBe('copied')
	action.dispose()
	await action.copy('closed reply')
	expect(write).toHaveBeenCalledTimes(2)
	action.activate()
	await action.copy('mounted reply')
	expect(states.at(-1)).toBe('copied')
})

it('keeps a fixed icon slot, accessible stable action name and polite feedback region', () => {
	const html = renderToStaticMarkup(createElement(CopyButton, { text: 'answer' }))
	expect(html).toContain('aria-label="Copy reply"')
	expect(html).toContain('data-copy-state="idle"')
	expect(html).toContain('size-6')
	expect(html).toContain('aria-live="polite"')
	expect(html).not.toContain('aria-pressed')
	expect(html).not.toContain('Copied to clipboard.')
})
