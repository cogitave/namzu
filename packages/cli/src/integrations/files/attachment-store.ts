import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { BlobStore } from '@namzu/files'
import { LocalFsBlobStore } from '@namzu/files/local'
import type { AttachmentStore, StoredBytes } from '@namzu/sdk'

/**
 * The CLI's attachment store, content-addressed, over a real blob driver.
 *
 * `@namzu/files` shipped six drivers and had no consumer in this repo — a
 * package the estate could import and nothing here could point at. This is
 * the pointing: the local driver, wired to the seam the SDK added for
 * attachments, in the one host that actually attaches things.
 *
 * **Addressed by content AND media type**, not by content alone. The same
 * bytes declared `image/png` once and `application/pdf` later are two
 * different claims about what they are, and the SDK's resolver refuses a
 * ref whose stored media type disagrees with the message. Keying on bytes
 * alone would make the second `put` return the first ref, and every message
 * using it would then be refused — a dedup that manufactures the exact
 * mismatch the resolver exists to catch. Folding the media type into the
 * digest keeps dedup for the common case (the same file attached twice) and
 * gives an honest ref for the uncommon one.
 */

/** `<home>/.namzu/attachments`, beside the credential store. */
export function attachmentsDir(home: string = homedir()): string {
	return join(home, '.namzu', 'attachments')
}

export interface BlobAttachmentStoreOptions {
	/** Injectable for tests; defaults to the local driver under `~/.namzu`. */
	readonly blobs?: BlobStore
	readonly home?: string
}

export class BlobAttachmentStore implements AttachmentStore {
	private readonly blobs: BlobStore

	constructor(options: BlobAttachmentStoreOptions = {}) {
		this.blobs = options.blobs ?? new LocalFsBlobStore({ root: attachmentsDir(options.home) })
	}

	/**
	 * The key for these bytes under this media type.
	 *
	 * Two files rather than one: the bytes, and a sibling holding the media
	 * type. The blob store stores bytes and nothing else, and the SDK's
	 * resolver needs the store to be able to REPORT what it holds — a store
	 * that could only echo back what the caller claimed could never catch a
	 * mismatch, which is the check that keeps a PDF from being sent as a PNG.
	 */
	private key(mediaType: string, data: string): string {
		const digest = createHash('sha256').update(mediaType).update('\0').update(data).digest('hex')
		// Two levels, because a flat directory of every attachment a machine
		// has ever seen is a directory nothing enumerates twice.
		return `${digest.slice(0, 2)}/${digest.slice(2)}`
	}

	async put(bytes: StoredBytes): Promise<string> {
		const key = this.key(bytes.mediaType, bytes.data)
		// Written every time rather than checked first. A `get` before every
		// `put` doubles the syscalls to avoid rewriting identical bytes to an
		// identical path, and the write is what makes the ref valid — skipping
		// it on a stale "exists" answer is how a ref points at nothing.
		await this.blobs.put({
			key: `${key}.bin`,
			bytes: Buffer.from(bytes.data, 'base64'),
			mimeType: bytes.mediaType,
		})
		await this.blobs.put({
			key: `${key}.type`,
			bytes: Buffer.from(bytes.mediaType, 'utf-8'),
			mimeType: 'text/plain',
		})
		return key
	}

	async get(ref: string): Promise<StoredBytes | undefined> {
		// The blob store validates the key against path traversal, and this
		// passes the caller's ref through unchanged so that check is the one
		// that runs. Sanitising here as well would mean two rules that can
		// disagree, and the weaker one would be the one nobody reads.
		const [blob, type] = await Promise.all([
			this.blobs.get({ provider: 'local-fs', key: `${ref}.bin` }),
			this.blobs.get({ provider: 'local-fs', key: `${ref}.type` }),
		])
		if (!blob || !type) {
			// BOTH, or nothing. A ref with bytes and no media type is a
			// half-written attachment, and answering with a guessed type is how
			// a PDF reaches a provider labelled as an image.
			return undefined
		}
		return {
			data: Buffer.from(blob.bytes).toString('base64'),
			mediaType: Buffer.from(type.bytes).toString('utf-8'),
		}
	}
}
