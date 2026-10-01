import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ImageAttachment } from '@namzu/sdk'
import type { AttachmentInput, AttachmentView } from '../shared/protocol.js'

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024
export const MAX_ATTACHMENT_COUNT = 8
const MAX_TEXT_BYTES = 128 * 1024
export interface AdmittedAttachment {
	view: AttachmentView
	image?: ImageAttachment
	text?: string
}
export function admitAttachment(file: AttachmentInput): AdmittedAttachment {
	if (!file || typeof file.name !== 'string' || !(file.bytes instanceof Uint8Array))
		throw new Error('Choose an image or UTF-8 text file.')
	if (!file.bytes.byteLength || file.bytes.byteLength > MAX_ATTACHMENT_BYTES)
		throw new Error('Keep attachments under 3 MiB per message.')
	const bytes = Buffer.from(file.bytes)
	const name =
		Array.from(basename(file.name), (char) =>
			char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char,
		)
			.join('')
			.slice(0, 180) || 'Attached file'
	let mediaType: string | undefined
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		mediaType = 'image/png'
	else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mediaType = 'image/jpeg'
	else if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')))
		mediaType = 'image/gif'
	else if (
		bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
		bytes.subarray(8, 12).toString('ascii') === 'WEBP'
	)
		mediaType = 'image/webp'
	if (mediaType) {
		const data = bytes.toString('base64')
		return {
			view: {
				id: randomUUID(),
				name,
				kind: 'image',
				size: bytes.byteLength,
				mediaType,
				preview: `data:${mediaType};base64,${data}`,
			},
			image: { type: 'image', data, mediaType },
		}
	}
	if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error('Keep each text file under 128 KiB.')
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw new Error('This file is not a supported image or UTF-8 text file.')
	}
	if (
		bytes.some((byte) => byte < 32 && ![9, 10, 13].includes(byte)) ||
		bytes.subarray(0, 5).toString('ascii') === '%PDF-'
	)
		throw new Error('This file is not a supported image or UTF-8 text file.')
	return {
		view: { id: randomUUID(), name, kind: 'text', size: bytes.byteLength, mediaType: 'text/plain' },
		text,
	}
}
export function validateAttachmentBatch(files: readonly AdmittedAttachment[]): void {
	if (files.length > MAX_ATTACHMENT_COUNT) throw new Error('Attach at most eight files.')
	if (files.reduce((total, file) => total + file.view.size, 0) > MAX_ATTACHMENT_BYTES)
		throw new Error('Keep attachments under 3 MiB per message.')
	if (
		files.reduce((total, file) => total + (file.view.kind === 'text' ? file.view.size : 0), 0) >
		256 * 1024
	)
		throw new Error('Keep attached text under 256 KiB per message.')
}
/** Only called with paths returned by the native dialog, never renderer paths. */
export async function readChosenFile(path: string): Promise<AttachmentInput> {
	const file = await open(path, 'r')
	try {
		const info = await file.stat()
		if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
			throw new Error('Choose files under 3 MiB each.')
		const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
		let size = 0
		while (size < buffer.length) {
			const read = await file.read(buffer, size, buffer.length - size, null)
			if (!read.bytesRead) break
			size += read.bytesRead
		}
		if (size > MAX_ATTACHMENT_BYTES) throw new Error('Choose files under 3 MiB each.')
		return { name: basename(path), bytes: buffer.subarray(0, size) }
	} finally {
		await file.close()
	}
}
