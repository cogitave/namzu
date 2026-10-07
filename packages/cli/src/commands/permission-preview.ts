import { readFile, stat } from 'node:fs/promises'
import { type AcpFileChangePreview, dryRunEdit, resolveWithinAnyReal } from '@namzu/sdk'

/** Bigger than this and the card says nothing about the change, rather than shipping a megabyte per approval. */
export const PREVIEW_MAX_BYTES = 1024 * 1024

interface CallLike {
	readonly id: string
	readonly name: string
	readonly input: unknown
	readonly isDestructive: boolean
}

/**
 * What a pending `edit` or `write` would do to the file, worked out with the
 * SDK's own apply code against the file as it is now.
 *
 * `undefined` whenever there is nothing honest to show: another tool, a path
 * the tool would refuse, a missing file for an edit, a binary or oversized
 * file, a call the tool would reject. A preview must never be the reason an
 * approval fails, so every error ends here as "no preview".
 *
 * Reads the host disk. A conversation running inside a sandbox edits another
 * filesystem, so there the preview may describe a file the call will not touch.
 */
export async function buildFilePreview(
	call: { readonly name: string; readonly input: unknown },
	roots: readonly string[],
): Promise<AcpFileChangePreview | undefined> {
	if (call.name !== 'edit' && call.name !== 'write') return undefined
	const input = call.input
	if (typeof input !== 'object' || input === null) return undefined
	const requested = (input as { path?: unknown }).path
	if (typeof requested !== 'string' || requested.trim() === '') return undefined
	try {
		const path = await resolveWithinAnyReal(roots, requested)
		const before = await readCurrent(path)
		if (before === undefined) return undefined

		let after: string
		if (call.name === 'write') {
			const body =
				(input as { content?: unknown; newStr?: unknown }).content ??
				(input as { newStr?: unknown }).newStr
			if (typeof body !== 'string') return undefined
			after = body
		} else {
			// An edit has nothing to apply to when the file is not there.
			if (before === null) return undefined
			const result = dryRunEdit(before, input)
			if (!result.success) return undefined
			after = result.content
		}
		if (Buffer.byteLength(after) > PREVIEW_MAX_BYTES) return undefined
		if (before === after) return undefined
		return { path, before, after }
	} catch {
		return undefined
	}
}

/** The body, `null` when the file does not exist, `undefined` when it is too big or not text. */
async function readCurrent(path: string): Promise<string | null | undefined> {
	let size: number
	try {
		const info = await stat(path)
		if (!info.isFile()) return undefined
		size = info.size
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw err
	}
	if (size > PREVIEW_MAX_BYTES) return undefined
	const buffer = await readFile(path)
	// A NUL in the first block is the usual test for "not text".
	if (buffer.subarray(0, 8000).includes(0)) return undefined
	return buffer.toString('utf-8')
}

/** The four fields a review shows, plus the preview when there is one. */
export async function withPreviews(calls: readonly CallLike[], roots: readonly string[]) {
	return Promise.all(
		calls.map(async (call) => {
			const preview = await buildFilePreview(call, roots)
			return {
				id: call.id,
				name: call.name,
				input: call.input,
				isDestructive: call.isDestructive,
				...(preview ? { preview } : {}),
			}
		}),
	)
}
