import { describe, expect, it } from 'vitest'

import { createUserMessage } from '../../../types/message/index.js'
import type { Message, MessageAttachment } from '../../../types/message/index.js'
import {
	AttachmentMediaTypeMismatchError,
	AttachmentNotFoundError,
	type AttachmentStore,
	NoAttachmentStoreError,
	type StoredBytes,
	isStoredAttachment,
	resolveAttachment,
	resolveAttachments,
} from '../index.js'

/**
 * A message that carries a reference instead of the bytes.
 *
 * Inline base64 is fine for one screenshot and wrong for everything it
 * implies: the bytes land in the durable transcript, in every checkpoint,
 * in every compaction pass that walks the history, and — because a
 * conversation resends its history — on the wire once per turn. A 4 MB PDF
 * attached once is 4 MB per request for the rest of the run.
 *
 * Every failure here REFUSES. A message that quietly lost its image is a
 * model answering about a picture it never saw, confidently, with nothing
 * in the transcript saying why.
 */

function store(entries: Record<string, StoredBytes>): AttachmentStore {
	return {
		async put(bytes) {
			const ref = `ref_${Object.keys(entries).length}`
			entries[ref] = bytes
			return ref
		},
		async get(ref) {
			return entries[ref]
		},
	}
}

const stored = (over: Record<string, unknown> = {}): MessageAttachment =>
	({
		type: 'stored',
		ref: 'ref_a',
		mediaType: 'image/png',
		kind: 'image',
		...over,
	}) as MessageAttachment

describe('a stored attachment becomes an inline one', () => {
	it('resolves an image', async () => {
		const resolved = await resolveAttachment(
			stored(),
			store({ ref_a: { data: 'AAAA', mediaType: 'image/png' } }),
		)

		expect(resolved).toEqual({
			type: 'image',
			data: 'AAAA',
			mediaType: 'image/png',
		})
	})

	it('resolves a document, keeping name and citations', async () => {
		// Both are message-level decisions the store knows nothing about, so
		// dropping them would silently turn a citable named contract into an
		// anonymous blob.
		const resolved = await resolveAttachment(
			stored({
				kind: 'document',
				mediaType: 'application/pdf',
				name: 'contract.pdf',
				citations: true,
			}),
			store({ ref_a: { data: 'BBBB', mediaType: 'application/pdf' } }),
		)

		expect(resolved).toEqual({
			type: 'document',
			data: 'BBBB',
			mediaType: 'application/pdf',
			name: 'contract.pdf',
			citations: true,
		})
	})

	it('leaves an inline attachment exactly as it was', async () => {
		const inline: MessageAttachment = {
			type: 'image',
			data: 'CCCC',
			mediaType: 'image/png',
		}

		expect(await resolveAttachment(inline, store({}))).toBe(inline)
	})
})

describe('every failure refuses', () => {
	it('lets pre-cancellation outrank a missing store', async () => {
		const caller = new AbortController()
		const reason = new Error('attachment resolution cancelled')
		caller.abort(reason)

		await expect(resolveAttachment(stored(), undefined, { signal: caller.signal })).rejects.toBe(
			reason,
		)
	})

	it('does not publish bytes after authority is withdrawn at the await boundary', async () => {
		let release!: (bytes: StoredBytes) => void
		const held = new Promise<StoredBytes>((resolve) => {
			release = resolve
		})
		const caller = new AbortController()
		const reason = new Error('attachment authority withdrawn')
		const pending = resolveAttachment(
			stored(),
			{
				put: async () => 'unused',
				get: () => held,
			},
			{ signal: caller.signal },
		)

		release({ data: 'late-bytes', mediaType: 'image/png' })
		queueMicrotask(() => caller.abort(reason))

		await expect(pending).rejects.toBe(reason)
	})

	it('refuses a ref with no store', async () => {
		await expect(resolveAttachment(stored(), undefined)).rejects.toThrow(NoAttachmentStoreError)
	})

	it('refuses a ref the store does not hold', async () => {
		await expect(resolveAttachment(stored(), store({}))).rejects.toThrow(AttachmentNotFoundError)
	})

	it('refuses bytes that are not what the message said they were', async () => {
		// The declared type decides which content block is built and what the
		// provider is told the bytes are. Guessing which side is wrong sends
		// the provider bytes it cannot read while telling it otherwise.
		await expect(
			resolveAttachment(stored(), store({ ref_a: { data: 'X', mediaType: 'application/pdf' } })),
		).rejects.toThrow(AttachmentMediaTypeMismatchError)
	})

	it('names both media types in the refusal', async () => {
		try {
			await resolveAttachment(
				stored(),
				store({ ref_a: { data: 'X', mediaType: 'application/pdf' } }),
			)
			throw new Error('expected a refusal')
		} catch (err) {
			expect((err as Error).message).toContain('image/png')
			expect((err as Error).message).toContain('application/pdf')
		}
	})
})

describe('resolving a whole conversation', () => {
	const withAttachments = (attachments: MessageAttachment[]): Message =>
		({ ...createUserMessage('look'), attachments }) as Message

	it('lets pre-cancellation outrank the unchanged fast path', async () => {
		const caller = new AbortController()
		const reason = new Error('conversation resolution cancelled')
		caller.abort(reason)

		await expect(
			resolveAttachments([createUserMessage('plain')], undefined, {
				signal: caller.signal,
			}),
		).rejects.toBe(reason)
	})

	it('returns the SAME array when nothing was stored', async () => {
		// So the common case costs one scan and no allocation, and so a caller
		// cannot tell resolved from unresolved by identity and get it wrong.
		const messages: Message[] = [
			createUserMessage('hello'),
			withAttachments([{ type: 'image', data: 'A', mediaType: 'image/png' }]),
		]

		expect(await resolveAttachments(messages, store({}))).toBe(messages)
	})

	it('resolves only the messages that need it', async () => {
		const plain = createUserMessage('hello')
		const messages: Message[] = [plain, withAttachments([stored()])]

		const resolved = await resolveAttachments(
			messages,
			store({ ref_a: { data: 'AAAA', mediaType: 'image/png' } }),
		)

		expect(resolved[0]).toBe(plain)
		expect(resolved[1]).not.toBe(messages[1])
		expect((resolved[1] as unknown as { attachments: MessageAttachment[] }).attachments[0]).toEqual(
			{
				type: 'image',
				data: 'AAAA',
				mediaType: 'image/png',
			},
		)
	})

	it('resolves a message that mixes stored and inline', async () => {
		const inline: MessageAttachment = {
			type: 'image',
			data: 'INLINE',
			mediaType: 'image/png',
		}
		const messages: Message[] = [withAttachments([inline, stored()])]

		const resolved = await resolveAttachments(
			messages,
			store({ ref_a: { data: 'FROM_STORE', mediaType: 'image/png' } }),
		)

		const attachments = (resolved[0] as unknown as { attachments: MessageAttachment[] }).attachments
		expect(attachments[0]).toBe(inline)
		expect((attachments[1] as { data: string }).data).toBe('FROM_STORE')
	})

	it('refuses the whole conversation when one ref cannot resolve', async () => {
		// Not "resolve what you can". A conversation missing one attachment is
		// a conversation the model will answer as though it were complete.
		const messages: Message[] = [
			withAttachments([stored()]),
			withAttachments([stored({ ref: 'gone' })]),
		]

		await expect(
			resolveAttachments(messages, store({ ref_a: { data: 'A', mediaType: 'image/png' } })),
		).rejects.toThrow(AttachmentNotFoundError)
	})

	it('leaves a conversation with no attachments alone, cheaply', async () => {
		const messages: Message[] = [createUserMessage('a'), createUserMessage('b')]

		expect(await resolveAttachments(messages, undefined)).toBe(messages)
	})
})

describe('the predicate', () => {
	it('recognises a stored attachment and nothing else', () => {
		expect(isStoredAttachment(stored())).toBe(true)
		expect(isStoredAttachment({ type: 'image', data: 'A', mediaType: 'image/png' })).toBe(false)
		expect(
			isStoredAttachment({
				type: 'document',
				data: 'A',
				mediaType: 'application/pdf',
			}),
		).toBe(false)
		// An attachment with no `type` is an image — that is what every
		// attachment was before documents existed.
		expect(isStoredAttachment({ data: 'A', mediaType: 'image/png' })).toBe(false)
	})
})
