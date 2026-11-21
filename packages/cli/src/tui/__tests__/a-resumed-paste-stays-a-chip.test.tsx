/**
 * A message sent with a pasted block shows the block as its chip while the
 * conversation is live. The saved message carries the pasted range, so a resumed
 * conversation draws the same chip, a rewind list names the message by it, and
 * the message itself (what the model reads and what a rewind puts back in the
 * box) keeps the whole text. A message saved without a range shows its text.
 */

import { type UserMessage, createUserMessage, newPasteNonce } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { Transcript } from '../Transcript.js'
import { editablePrompts } from '../edit-prompts.js'
import { chipPastedRanges, pasteChip, unchipPastedRanges } from '../paste-chips.js'
import { type Screen, renderToScreen } from './support/screen.js'

const typed = 'what is wrong here? '
const paste = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the log`).join('\n')
const content = typed + paste

function sent(): UserMessage {
	return {
		...createUserMessage(content),
		pasted: [{ start: typed.length, end: content.length, nonce: newPasteNonce(content) }],
	}
}

function ids() {
	let id = 0
	return () => `row-${++id}`
}

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

describe('a resumed conversation and a sent paste', () => {
	it('draws the paste as the chip the live row showed', () => {
		const live = chipPastedRanges(content, sent().pasted)
		expect(live).toBe(`${typed}${pasteChip(1, paste)}`)
		const rows = projectConversation([sent()], ids())
		expect(rows.map((row) => [row.role, row.content])).toEqual([['user', live]])
		expect(rows[0]?.content).toContain('[Pasted text #1 +39 lines]')
		expect(rows[0]?.content).not.toContain('line 2 of the log')
	})

	it('numbers several pastes in the order they stand', () => {
		const a = 'a\n'.repeat(5)
		const b = 'b\n'.repeat(7)
		const text = `x ${a} y ${b}`
		const message: UserMessage = {
			...createUserMessage(text),
			pasted: [
				{ start: 2, end: 2 + a.length, nonce: newPasteNonce(text) },
				{ start: 2 + a.length + 3, end: text.length, nonce: newPasteNonce(text) },
			],
		}
		const [row] = projectConversation([message], ids())
		expect(row?.content).toBe('x [Pasted text #1 +5 lines] y [Pasted text #2 +7 lines]')
	})

	it('shows the text of a message saved without a range', () => {
		const [row] = projectConversation([createUserMessage(content)], ids())
		expect(row?.content).toBe(content)
	})

	it('ignores a range that does not fit its message', () => {
		const message: UserMessage = {
			...createUserMessage('short'),
			pasted: [{ start: 2, end: 90, nonce: newPasteNonce('short') }],
		}
		const [row] = projectConversation([message], ids())
		expect(row?.content).toBe('short')
	})

	it('lists the message by its chip in a rewind and keeps the whole text behind it', () => {
		const message = sent()
		const rows = projectConversation([message], ids())
		const [prompt] = editablePrompts([message], rows)
		expect(prompt?.displayText).toBe(`${typed}[Pasted text #1 +39 lines]`)
		expect(prompt?.message.content).toBe(content)
		expect(prompt?.draftText).toBe(content)
		expect(prompt?.message.pasted).toEqual(message.pasted)
	})

	it('puts every chip back as its text, and leaves a chip that does not match', () => {
		const message = sent()
		const shown = chipPastedRanges(content, message.pasted)
		expect(unchipPastedRanges(shown, content, message.pasted)).toBe(content)
		expect(unchipPastedRanges('typed [Pasted text #1 +3 lines]', content, message.pasted)).toBe(
			'typed [Pasted text #1 +3 lines]',
		)
		expect(unchipPastedRanges('plain', content, undefined)).toBe('plain')
	})

	it('keeps the readable form of a mention and the whole paste in the box', () => {
		const text = 'read @a.md '
		const full = `${text}${paste}`
		const message: UserMessage = {
			...createUserMessage(`${full}\n\n[contents of a.md]`),
			pasted: [{ start: text.length, end: full.length, nonce: newPasteNonce(full) }],
		}
		// The live row keeps the mention as typed and the paste as its chip.
		const live = {
			id: 'u1',
			role: 'user' as const,
			content: 'read @a.md [Pasted text #1 +39 lines]',
		}
		const [prompt] = editablePrompts([message], [live])
		expect(prompt?.displayText).toBe('read @a.md [Pasted text #1 +39 lines]')
		expect(prompt?.draftText).toBe(full)
	})

	it('draws the chip row on screen', async () => {
		const rows = projectConversation([sent()], ids())
		const screen = await renderToScreen(
			<Transcript messages={[...rows]} pending={null} state="idle" settled={0} resetKey={0} />,
			{ cols: 80, rows: 20 },
		)
		screens.push(screen)
		await screen.waitForRender()
		const text = screen.scrollback().join('\n')
		expect(text).toContain('what is wrong here? [Pasted text #1 +39 lines]')
		expect(text).not.toContain('line 2 of the log')
	})
})
