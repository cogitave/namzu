import { expect, it, vi } from 'vitest'
import { MAX_COPY_TEXT_BYTES, copyTextPayload } from '../shared/clipboard-text.js'
import { ClipboardTextWriter } from './clipboard-text.js'

it('passes exact Unicode, URLs, spaces and line endings without interpreting them', async () => {
	const write = vi.fn(async (_text: string) => {})
	const text = '  Türkçe 🐇\r\n\r\nhttps://example.org/?x=%20#part\n\t  '
	await new ClipboardTextWriter(write).copy(text)
	expect(write).toHaveBeenCalledExactlyOnceWith(text)
	expect(copyTextPayload('')).toBe('')
})

it('refuses nontext, NUL, invalid Unicode and excess UTF-8 bytes without truncation', () => {
	for (const value of [
		{},
		null,
		'\0tail',
		'\ud800',
		'\udc00',
		'a'.repeat(MAX_COPY_TEXT_BYTES + 1),
		'€'.repeat(Math.floor(MAX_COPY_TEXT_BYTES / 3) + 1),
	])
		expect(() => copyTextPayload(value)).toThrow()
	expect(copyTextPayload('a'.repeat(MAX_COPY_TEXT_BYTES))).toHaveLength(MAX_COPY_TEXT_BYTES)
})

it('awaits asynchronous native success, propagates failure and allows an honest retry', async () => {
	let resolve!: () => void
	let entered!: () => void
	const started = new Promise<void>((done) => {
		entered = done
	})
	const write = vi.fn<(text: string) => Promise<void>>()
	write.mockImplementationOnce(
		() =>
			new Promise<void>((done) => {
				resolve = done
				entered()
			}),
	)
	write.mockRejectedValueOnce(new Error('clipboard unavailable'))
	write.mockResolvedValueOnce(undefined)
	const writer = new ClipboardTextWriter(write)
	let completed = false
	const first = writer.copy('first').then(() => {
		completed = true
	})
	await started
	expect(completed).toBe(false)
	resolve()
	await first
	await expect(writer.copy('second')).rejects.toThrow('clipboard unavailable')
	await writer.copy('second')
	expect(write.mock.calls.map(([text]) => text)).toEqual(['first', 'second', 'second'])
})

it('serializes at most four admitted writes and releases capacity after failure', async () => {
	let release!: () => void
	let entered!: () => void
	const started = new Promise<void>((resolve) => {
		entered = resolve
	})
	const first = new Promise<void>((resolve) => {
		release = resolve
	})
	const write = vi
		.fn<(text: string) => Promise<void>>()
		.mockImplementationOnce(() => {
			entered()
			return first
		})
		.mockResolvedValue(undefined)
	const writer = new ClipboardTextWriter(write)
	const requests = ['one', 'two', 'three', 'four'].map((text) => writer.copy(text))
	await started
	await expect(writer.copy('five')).rejects.toThrow('Copy is busy')
	expect(write).toHaveBeenCalledTimes(1)
	release()
	await Promise.all(requests)
	await writer.copy('five')
	expect(write.mock.calls.map(([text]) => text)).toEqual(['one', 'two', 'three', 'four', 'five'])
})
