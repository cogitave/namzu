import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ImageAttachment } from '@namzu/sdk'
import { formatSize, shortFileName } from '../shared/format-size.js'
import type { AttachmentInput, AttachmentView } from '../shared/protocol.js'

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024
export const MAX_ATTACHMENT_COUNT = 8
const MAX_TEXT_BYTES = 128 * 1024
const MAX_TOTAL_TEXT_BYTES = 256 * 1024
export interface AdmittedAttachment {
	view: AttachmentView
	image?: ImageAttachment
	text?: string
}
const quoted = (name: string) => `“${shortFileName(name)}”`
const NOT_ATTACHABLE = (name: string) =>
	`${quoted(name)} can’t be attached. Namzu reads images and text files.`
const TOO_BIG = (name: string, size: number) =>
	`${quoted(name)} is ${formatSize(size)}. Choose a file under ${formatSize(MAX_ATTACHMENT_BYTES)}.`
export const ATTACHMENT_COUNT_MESSAGE = `You can attach up to ${MAX_ATTACHMENT_COUNT} files to one message.`
export const ATTACHMENT_TOTAL_MESSAGE = `Attachments can add up to ${formatSize(MAX_ATTACHMENT_BYTES)} per message. Remove a file or choose smaller ones.`

export function admitAttachment(file: AttachmentInput): AdmittedAttachment {
	if (!file || typeof file.name !== 'string' || !(file.bytes instanceof Uint8Array))
		throw new Error('Choose an image or a text file.')
	const name =
		Array.from(basename(file.name), (char) =>
			char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char,
		)
			.join('')
			.slice(0, 180) || 'Attached file'
	if (!file.bytes.byteLength) throw new Error(`${quoted(name)} is empty. Choose another file.`)
	if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES)
		throw new Error(TOO_BIG(name, file.bytes.byteLength))
	const bytes = Buffer.from(file.bytes)
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
	if (bytes.byteLength > MAX_TEXT_BYTES)
		throw new Error(
			`${quoted(name)} is ${formatSize(bytes.byteLength)}. Text files can be up to ${formatSize(MAX_TEXT_BYTES)}. Choose a smaller file.`,
		)
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw new Error(NOT_ATTACHABLE(name))
	}
	if (
		bytes.some((byte) => byte < 32 && ![9, 10, 13].includes(byte)) ||
		bytes.subarray(0, 5).toString('ascii') === '%PDF-'
	)
		throw new Error(NOT_ATTACHABLE(name))
	return {
		view: { id: randomUUID(), name, kind: 'text', size: bytes.byteLength, mediaType: 'text/plain' },
		text,
	}
}
export function validateAttachmentBatch(files: readonly AdmittedAttachment[]): void {
	if (files.length > MAX_ATTACHMENT_COUNT) throw new Error(ATTACHMENT_COUNT_MESSAGE)
	if (files.reduce((total, file) => total + file.view.size, 0) > MAX_ATTACHMENT_BYTES)
		throw new Error(ATTACHMENT_TOTAL_MESSAGE)
	if (
		files.reduce((total, file) => total + (file.view.kind === 'text' ? file.view.size : 0), 0) >
		MAX_TOTAL_TEXT_BYTES
	)
		throw new Error(
			`Attached text can add up to ${formatSize(MAX_TOTAL_TEXT_BYTES)} per message. Remove a file or choose a smaller one.`,
		)
}
/** Only called with paths returned by the native dialog, never renderer paths. */
export async function readChosenFile(path: string): Promise<AttachmentInput> {
	const file = await open(path, 'r')
	try {
		const info = await file.stat()
		if (!info.isFile()) throw new Error(`${quoted(basename(path))} isn’t a file. Choose a file.`)
		if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(TOO_BIG(basename(path), info.size))
		const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
		let size = 0
		while (size < buffer.length) {
			const read = await file.read(buffer, size, buffer.length - size, null)
			if (!read.bytesRead) break
			size += read.bytesRead
		}
		if (size > MAX_ATTACHMENT_BYTES) throw new Error(TOO_BIG(basename(path), size))
		return { name: basename(path), bytes: buffer.subarray(0, size) }
	} finally {
		await file.close()
	}
}
