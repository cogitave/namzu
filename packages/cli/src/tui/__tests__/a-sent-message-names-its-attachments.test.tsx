/**
 * A message the person sent keeps each marker where they put it, and one quiet
 * row under it names every file that went with it: marker, name, size. The same
 * rows are drawn from the log when a conversation is resumed.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, type MessageAttachment, createUserMessage } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { Transcript } from '../Transcript.js'
import { transcriptLines } from '../live-window.js'
import type { TranscriptMessage } from '../types.js'

const ESC = String.fromCodePoint(0x1b)
const png = (name?: string, body = 'png bytes'): MessageAttachment =>
	({
		data: Buffer.from(body).toString('base64'),
		mediaType: 'image/png',
		...(name ? { filename: name } : {}),
	}) as MessageAttachment

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ids() {
	let id = 0
	return () => `row-${++id}`
}

describe('a sent row under its message', () => {
	const message: TranscriptMessage = {
		id: 'u1',
		role: 'user',
		content: 'compare [Image #1] with [Image #2]',
		attachments: [
			{ marker: '[Image #1]', name: 'before.png', size: '12 KB', path: '/h/before.png' },
			{ marker: '[Image #2]', size: '3.5 KB' },
		],
	}

	it('keeps the words as sent and draws one row per file', () => {
		const harness = render(
			<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
		)
		try {
			const frame = harness.lastFrame() ?? ''
			expect(frame).toContain('compare [Image #1] with [Image #2]')
			expect(frame).toContain('[Image #1] before.png · 12 KB')
			expect(frame).toContain('[Image #2] · 3.5 KB')
			expect(frame).not.toContain('attachment')
			expect(frame).not.toContain(ESC)
		} finally {
			harness.unmount()
		}
	})

	it('is a link to the copy where the terminal takes links, plain text where it does not', () => {
		const plain = render(
			<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
		)
		const linked = render(
			<Transcript
				messages={[message]}
				pending={null}
				state="idle"
				settled={0}
				resetKey={0}
				hyperlinks
			/>,
		)
		try {
			expect(plain.lastFrame()).not.toContain(']8;;')
			const frame = linked.lastFrame() ?? ''
			expect(frame).toContain(`${ESC}]8;;file:///h/before.png${ESC}\\`)
			// Only the row with a copy is a link.
			expect(frame.match(/\]8;;file:/g)).toHaveLength(1)
		} finally {
			plain.unmount()
			linked.unmount()
		}
	})

	it('counts its rows when the live window is sized', () => {
		const without = transcriptLines([{ ...message, attachments: undefined }], false)
		expect(transcriptLines([message], false)).toHaveLength(without.length + 2)
	})
})

describe('a resumed conversation', () => {
	const conversation = (): readonly Message[] => [
		createUserMessage('look at [Image #1]', [png('a.png', 'one')]),
		createUserMessage('and [Image #3] and [Document #4]', [
			png('c.png', 'three'),
			{
				type: 'document',
				data: Buffer.from('pdf').toString('base64'),
				mediaType: 'application/pdf',
				name: 'd.pdf',
			},
		]),
	]

	it('draws the same rows from the log, with the numbers the messages name', () => {
		const rows = projectConversation(conversation(), ids())
		expect(rows.map((row) => row.content)).toEqual([
			'look at [Image #1]',
			'and [Image #3] and [Document #4]',
		])
		expect(rows.map((row) => row.attachments?.map((a) => `${a.marker} ${a.name}`))).toEqual([
			['[Image #1] a.png'],
			['[Image #3] c.png', '[Document #4] d.pdf'],
		])
	})

	it('numbers a message from before markers were kept after the ones before it', () => {
		const rows = projectConversation(
			[
				createUserMessage('first [Image #2]', [png('a.png', 'one')]),
				createUserMessage('older message, no marker', [png('b.png', 'two')]),
			],
			ids(),
		)
		expect(rows[1]?.attachments?.map((a) => a.marker)).toEqual(['[Image #3]'])
	})

	it('writes the copies under the conversation folder and links them', () => {
		const dir = join(mkdtempSync(join(tmpdir(), 'namzu-resume-rows-')), 'attachments')
		made.push(join(dir, '..'))
		const rows = projectConversation(conversation(), ids(), [], { attachmentDir: dir })
		const paths = rows.flatMap((row) => row.attachments ?? []).map((a) => a.path)
		expect(paths).toHaveLength(3)
		for (const path of paths) {
			expect(path?.startsWith(`${dir}/`)).toBe(true)
			expect(existsSync(path as string)).toBe(true)
		}
	})
})
