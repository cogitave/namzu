import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveAttachment } from '@namzu/sdk'
import type { MessageAttachment } from '@namzu/sdk'

import { BlobAttachmentStore, attachmentsDir } from '../attachment-store.js'

/**
 * Attachments on disk, addressed by what they are.
 *
 * `@namzu/files` shipped six drivers and had no consumer in this repo — a
 * package the estate could import and nothing here could point at. This is
 * the pointing, and the properties that make it worth pointing at: the same
 * file attached twice is stored once, and a store that could only echo back
 * what a caller claimed could never catch the mismatch the SDK's resolver
 * exists to refuse.
 *
 * Process-level: every claim here is about real files on a real disk.
 */

const dirs: string[] = []

afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true })
	dirs.length = 0
})

async function store(): Promise<BlobAttachmentStore> {
	const home = await mkdtemp(join(tmpdir(), 'namzu-attach-'))
	dirs.push(home)
	return new BlobAttachmentStore({ home })
}

const PNG = { data: Buffer.from('the image bytes').toString('base64'), mediaType: 'image/png' }

describe('the same file attached twice is stored once', () => {
	it('returns the same ref', async () => {
		const s = await store()

		expect(await s.put(PNG)).toBe(await s.put(PNG))
	})

	it('gives DIFFERENT refs to the same bytes under different media types', async () => {
		// Two different claims about what the bytes are. Keying on content
		// alone would make the second put return the first ref, and every
		// message using it would then be refused by the resolver — a dedup
		// that manufactures the exact mismatch the check exists to catch.
		const s = await store()

		const asPng = await s.put(PNG)
		const asPdf = await s.put({ data: PNG.data, mediaType: 'application/pdf' })

		expect(asPng).not.toBe(asPdf)
		expect((await s.get(asPng))?.mediaType).toBe('image/png')
		expect((await s.get(asPdf))?.mediaType).toBe('application/pdf')
	})

	it('round-trips the bytes exactly', async () => {
		const s = await store()

		const ref = await s.put(PNG)

		expect(await s.get(ref)).toEqual(PNG)
	})

	it('answers undefined for a ref it never minted', async () => {
		const s = await store()

		expect(await s.get('00/deadbeef')).toBeUndefined()
	})
})

describe('what it reports is what it holds', () => {
	it('reports the STORED media type, not one a caller claimed', async () => {
		// A store that echoed the caller could never catch a mismatch, which
		// is the check that keeps a PDF from reaching a provider labelled as
		// an image.
		const s = await store()
		const ref = await s.put({ data: PNG.data, mediaType: 'application/pdf' })

		const stored = await s.get(ref)

		expect(stored?.mediaType).toBe('application/pdf')
	})

	it('lets the SDK resolver refuse a message that disagrees with it', async () => {
		// The seam and the driver, working together — the thing neither could
		// demonstrate alone.
		const s = await store()
		const ref = await s.put({ data: PNG.data, mediaType: 'application/pdf' })
		const attachment = {
			type: 'stored',
			ref,
			mediaType: 'image/png',
			kind: 'image',
		} as MessageAttachment

		await expect(resolveAttachment(attachment, s)).rejects.toThrow(/declared image\/png/)
	})

	it('resolves a message that agrees with it', async () => {
		const s = await store()
		const ref = await s.put(PNG)
		const attachment = {
			type: 'stored',
			ref,
			mediaType: 'image/png',
			kind: 'image',
		} as MessageAttachment

		expect(await resolveAttachment(attachment, s)).toEqual({
			type: 'image',
			data: PNG.data,
			mediaType: 'image/png',
		})
	})
})

describe('where it puts things', () => {
	it('lives beside the credential store, under the home directory', async () => {
		expect(attachmentsDir('/home/somebody')).toBe('/home/somebody/.namzu/attachments')
	})

	it('shards by the first byte of the digest', async () => {
		// A flat directory of every attachment a machine has ever seen is a
		// directory nothing enumerates twice.
		const home = await mkdtemp(join(tmpdir(), 'namzu-attach-'))
		dirs.push(home)
		const s = new BlobAttachmentStore({ home })

		const ref = await s.put(PNG)

		expect(ref).toMatch(/^[0-9a-f]{2}\//)
		const shards = await readdir(attachmentsDir(home))
		expect(shards).toEqual([ref.slice(0, 2)])
	})

	it('is missing BOTH halves or neither', async () => {
		// A ref with bytes and no media type is a half-written attachment, and
		// answering with a guessed type is how a PDF reaches a provider
		// labelled as an image.
		const home = await mkdtemp(join(tmpdir(), 'namzu-attach-'))
		dirs.push(home)
		const s = new BlobAttachmentStore({ home })
		const ref = await s.put(PNG)

		await rm(join(attachmentsDir(home), `${ref}.type`))

		expect(await s.get(ref)).toBeUndefined()
	})
})
