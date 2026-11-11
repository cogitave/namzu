import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageAttachment } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import {
	attachmentDirOf,
	attachmentLine,
	attachmentPath,
	attachmentRows,
	ensureAttachmentFile,
} from './attachment-rows.js'

const png: MessageAttachment = {
	data: Buffer.from('not really a png').toString('base64'),
	mediaType: 'image/png',
	filename: 'shot.png',
} as unknown as MessageAttachment
const pasted: MessageAttachment = {
	data: Buffer.from('clipboard bytes').toString('base64'),
	mediaType: 'image/png',
	filename: 'Pasted image',
} as unknown as MessageAttachment
const pdf: MessageAttachment = {
	type: 'document',
	data: Buffer.from('%PDF-1.4').toString('base64'),
	mediaType: 'application/pdf',
	name: 'design.pdf',
}

const made: string[] = []
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-attachment-rows-'))
	made.push(dir)
	return join(dir, 'attachments')
}
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('attachment rows', () => {
	it('names each attachment by the number its message gives it, with name and size', () => {
		const rows = attachmentRows('compare [Image #3] with [Document #4]', [png, pdf], 0)
		expect(rows).toEqual([
			{ marker: '[Image #3]', name: 'shot.png', size: '16 B' },
			{ marker: '[Document #4]', name: 'design.pdf', size: '8 B' },
		])
		expect(rows.map(attachmentLine)).toEqual([
			'[Image #3] shot.png · 16 B',
			'[Document #4] design.pdf · 8 B',
		])
	})

	it('has no name for a clipboard image, which is not a file', () => {
		expect(attachmentRows('[Image #1]', [pasted], 0)).toEqual([
			{ marker: '[Image #1]', size: '15 B' },
		])
	})

	it('numbers a message from before markers were kept after the highest so far', () => {
		expect(attachmentRows('look at this', [png], 6).map((row) => row.marker)).toEqual([
			'[Image #7]',
		])
	})
})

describe('the copy of an attachment on disk', () => {
	it('is written once under the conversation folder, named by its bytes', () => {
		const dir = scratch()
		const first = ensureAttachmentFile(dir, png)
		const again = ensureAttachmentFile(dir, { ...png })
		expect(first).toBeDefined()
		expect(again).toBe(first)
		expect(first?.startsWith(dir)).toBe(true)
		expect(first?.endsWith('.png')).toBe(true)
		expect(readFileSync(first as string, 'utf8')).toBe('not really a png')
		// The same image under another name is the same file.
		expect(
			ensureAttachmentFile(dir, { ...png, filename: 'other.png' } as unknown as MessageAttachment),
		).toBe(first)
		expect(readdirSync(dir)).toHaveLength(1)
	})

	it('takes its extension from the media type, else the name, else bin', () => {
		const dir = scratch()
		expect(attachmentPath(dir, pdf)?.endsWith('.pdf')).toBe(true)
		const odd = {
			...pdf,
			mediaType: 'application/x-thing',
			name: 'notes.TXT2',
		} as unknown as MessageAttachment
		expect(attachmentPath(dir, odd)?.endsWith('.txt2')).toBe(true)
		const nameless = { ...pdf, mediaType: 'application/x-thing', name: '../../etc/x y' }
		expect(attachmentPath(dir, nameless)?.endsWith('.bin')).toBe(true)
	})

	it('never leaves the folder, whatever the file is called', () => {
		const dir = scratch()
		const evil = { ...png, filename: '../../escape.png' } as unknown as MessageAttachment
		const path = ensureAttachmentFile(dir, evil) as string
		expect(path.startsWith(`${dir}/`)).toBe(true)
		expect(existsSync(join(dir, '..', '..', 'escape.png'))).toBe(false)
	})

	it('gives the row a link only when the copy exists', () => {
		const dir = scratch()
		const [row] = attachmentRows('[Image #1]', [png], 0, dir)
		expect(row?.path).toBe(attachmentPath(dir, png))
		expect(existsSync(row?.path as string)).toBe(true)
		expect(attachmentRows('[Image #1]', [png], 0)[0]?.path).toBeUndefined()
	})

	it('writes nothing for an attachment held by a store', () => {
		const stored: MessageAttachment = {
			type: 'stored',
			ref: 'sha256:abc',
			mediaType: 'image/png',
			kind: 'image',
			name: 'kept.png',
		}
		const dir = scratch()
		expect(ensureAttachmentFile(dir, stored)).toBeUndefined()
		expect(attachmentRows('[Image #1]', [stored], 0, dir)).toEqual([
			{ marker: '[Image #1]', name: 'kept.png' },
		])
		expect(existsSync(dir)).toBe(false)
	})

	it('lives inside the conversation folder, so removing it removes the copies', () => {
		const sessions = {
			paths: { sessionDir: ({ sessionId }: { sessionId: string }) => `/h/p/${sessionId}` },
		}
		expect(attachmentDirOf(sessions as never, 'abc' as never)).toBe('/h/p/abc/attachments')
		expect(attachmentDirOf({} as never, 'abc' as never)).toBeUndefined()
	})
})
