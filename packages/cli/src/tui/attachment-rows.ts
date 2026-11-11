/**
 * What a sent message shows for the files that went with it: one row per
 * attachment (its marker, its name, its size), and a copy of the file on disk
 * the row can link to.
 *
 * The copies live in the conversation's own folder, `<session>/attachments/`,
 * named by a hash of the bytes and a short extension: the same file attached
 * twice is one file, and deleting the conversation deletes them. Nothing here
 * writes anywhere else.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { MessageAttachment, SessionId } from '@namzu/sdk'

import type { CliSessions } from '../integrations/sessions/store.js'
import { attachmentChip, numberAttachments } from './paste-chips.js'
import { formatSize } from './person-terms.js'

/**
 * Where copies of a conversation's attached files are kept
 * (`<session-id>/attachments/`). It is inside the conversation's own folder, so
 * whatever removes the conversation removes them.
 */
export function attachmentDirOf(
	sessions: Pick<CliSessions, 'paths'>,
	sessionId: SessionId,
): string | undefined {
	try {
		return join(sessions.paths.sessionDir({ sessionId }), 'attachments')
	} catch {
		// A store with no folder for the conversation gives its rows no links.
		return undefined
	}
}

export interface AttachmentRow {
	/** `[Image #2]`: the text the message carries. */
	readonly marker: string
	/** The file's name, when it has one. */
	readonly name?: string
	/** `48 KB`, when the bytes are in the message. */
	readonly size?: string
	/** A copy of the file on disk, when one could be written. */
	readonly path?: string
}

export function attachmentKind(attachment: MessageAttachment): 'Image' | 'Document' {
	return attachment.type === 'document' ||
		(attachment.type === 'stored' && attachment.kind !== 'image')
		? 'Document'
		: 'Image'
}

/** The name a person gave the file, or none: a clipboard image has no file name. */
export function attachmentName(attachment: MessageAttachment): string | undefined {
	const named = attachment as { readonly filename?: unknown; readonly name?: unknown }
	const name = typeof named.filename === 'string' ? named.filename : named.name
	if (typeof name !== 'string') return undefined
	const trimmed = name.trim()
	return trimmed === '' || trimmed === 'Pasted image' ? undefined : trimmed
}

function byteLength(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

const EXTENSIONS: Readonly<Record<string, string>> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/heic': 'heic',
	'image/bmp': 'bmp',
	'application/pdf': 'pdf',
	'text/plain': 'txt',
	'text/markdown': 'md',
}

/** A short, safe extension: from the media type, else from the file's own name, else `bin`. */
function extensionOf(attachment: MessageAttachment & { readonly mediaType: string }): string {
	const known = EXTENSIONS[attachment.mediaType]
	if (known) return known
	const own = extname(attachmentName(attachment) ?? '')
		.slice(1)
		.toLowerCase()
	return /^[a-z0-9]{1,8}$/.test(own) ? own : 'bin'
}

/** Where the copy of `attachment` lives under `directory`, or none when its bytes are not in the message. */
export function attachmentPath(
	directory: string,
	attachment: MessageAttachment,
): string | undefined {
	if (attachment.type === 'stored') return undefined
	const digest = createHash('sha256').update(attachment.data, 'base64').digest('hex').slice(0, 32)
	return join(directory, `${digest}.${extensionOf(attachment)}`)
}

/**
 * Make sure the copy exists and return its path; `undefined` when there is
 * nothing to copy or the write failed (the row then has no link, which is all
 * that changes). Written to a temporary name and renamed, so a half-written
 * file is never at the final path.
 */
export function ensureAttachmentFile(
	directory: string,
	attachment: MessageAttachment,
): string | undefined {
	const path = attachmentPath(directory, attachment)
	if (path === undefined || attachment.type === 'stored') return undefined
	try {
		if (existsSync(path)) return path
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		const temporary = `${path}.${process.pid}.tmp`
		writeFileSync(temporary, Buffer.from(attachment.data, 'base64'), { mode: 0o600 })
		renameSync(temporary, path)
		return path
	} catch {
		return undefined
	}
}

/** The row as plain text: marker, name, size. */
export function attachmentLine(row: AttachmentRow): string {
	return `${row.marker}${row.name ? ` ${row.name}` : ''}${row.size ? ` · ${row.size}` : ''}`
}

/**
 * The rows for the attachments of one sent message. `text` is what the
 * message says (it names them by number), `floor` the highest number used
 * before it; `directory`, when given, is where copies are kept.
 */
export function attachmentRows(
	text: string,
	attachments: readonly MessageAttachment[],
	floor: number,
	directory?: string,
): readonly AttachmentRow[] {
	const kinds = attachments.map(attachmentKind)
	const numbers = numberAttachments(text, kinds, floor)
	return attachments.map((attachment, index) => {
		const name = attachmentName(attachment)
		const path = directory ? ensureAttachmentFile(directory, attachment) : undefined
		return {
			marker: attachmentChip(kinds[index] as 'Image' | 'Document', numbers[index] as number),
			...(name ? { name } : {}),
			...(attachment.type === 'stored' ? {} : { size: formatSize(byteLength(attachment.data)) }),
			...(path ? { path } : {}),
		}
	})
}
