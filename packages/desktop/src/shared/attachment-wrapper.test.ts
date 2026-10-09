import { expect, it } from 'vitest'
import { splitAttachmentWrapper } from './attachment-wrapper.js'
import { emptyThread, restoreMessages } from './projection.js'

it('reads the wrapper back into the typed text and a chip, keeping Turkish names', () => {
	const prompt = `Ekimi gör\n\nAttached text file: ${JSON.stringify('Sözleşme İmzalı.txt')}\nek içerik`
	const split = splitAttachmentWrapper(prompt, 'h')
	expect(split.text).toBe('Ekimi gör')
	expect(split.attachments).toEqual([
		{
			id: 'h-0',
			name: 'Sözleşme İmzalı.txt',
			kind: 'text',
			size: new TextEncoder().encode('ek içerik').length,
			mediaType: 'text/plain',
		},
	])
})

it('handles several attachments and a message that is only attachments', () => {
	const prompt = 'Attached text file: "a.txt"\nline one\n\nline two\n\nAttached image: "b.png"'
	const split = splitAttachmentWrapper(prompt, 'h')
	expect(split.text).toBe('')
	expect(split.attachments.map((file) => [file.name, file.kind])).toEqual([
		['a.txt', 'text'],
		['b.png', 'image'],
	])
})

it('leaves ordinary text, and a half-typed marker, alone', () => {
	for (const text of ['hello', 'Attached text file: nope', 'x\n\nAttached image: "unterminated']) {
		expect(splitAttachmentWrapper(text, 'h')).toEqual({ text, attachments: [] })
	}
})

it('restores a reloaded user message as chips and never as file text', () => {
	const thread = restoreMessages(emptyThread(), [
		{ role: 'user', text: 'Bak\n\nAttached text file: "n.txt"\nsecret body' },
		{ role: 'assistant', text: 'Attached text file: "n.txt"' },
	])
	expect(thread.messages[0]?.text).toBe('Bak')
	expect(thread.messages[0]?.attachments?.[0]?.name).toBe('n.txt')
	expect(thread.messages[1]?.attachments).toBeUndefined()
})
