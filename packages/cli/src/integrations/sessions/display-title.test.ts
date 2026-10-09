import type { Message } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { displayConversationTitle, typedTextOf } from './display-title.js'
import { conversationTitle } from './store.js'

const user = (content: string) => ({ role: 'user', content }) as Message

describe('the wrapper the desktop app adds for an attached file', () => {
	it('is not part of what the person typed', () => {
		expect(typedTextOf('Ekimi gör\n\nAttached text file: "notes.txt"\nsecret body')).toEqual({
			text: 'Ekimi gör',
			firstFile: 'notes.txt',
		})
		expect(typedTextOf('Look\n\nAttached image: "a.png"')).toEqual({
			text: 'Look',
			firstFile: 'a.png',
		})
	})

	it('leaves an ordinary message alone', () => {
		expect(typedTextOf('Attached is my plan')).toEqual({ text: 'Attached is my plan' })
	})

	it('reads an escaped file name back as the person saw it', () => {
		const wrapped = `Attached text file: ${JSON.stringify('Sözleşme "son" ışık.txt')}\nbody`
		expect(typedTextOf(wrapped).firstFile).toBe('Sözleşme "son" ışık.txt')
	})
})

describe('a conversation title', () => {
	it('comes from the typed words, never from the attachment text', () => {
		const title = conversationTitle([
			user('Ekimi gör\n\nAttached text file: "Sözleşme.txt"\nek içerik çok uzun bir metin'),
		])
		expect(title).toBe('Ekimi gör')
		expect(title).not.toContain('Attached')
	})

	it('is the file name when only a file was sent', () => {
		expect(conversationTitle([user('Attached text file: "Sözleşme.txt"\nbody')])).toBe(
			'Sözleşme.txt',
		)
	})

	it('still shortens a long typed message', () => {
		expect(conversationTitle([user('a'.repeat(100))]).length).toBe(60)
	})

	it('keeps the scheduled prefix reading as before', () => {
		expect(displayConversationTitle('⏲ Daily · digest')).toBe('Scheduled: Daily · digest')
	})
})
