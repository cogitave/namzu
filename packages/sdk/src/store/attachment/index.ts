import type { Message, MessageAttachment } from '../../types/message/index.js'

/**
 * Where an attachment's bytes live when the message does not carry them.
 *
 * Every attachment was inline base64 on the message. That is fine for one
 * screenshot and wrong for everything else it implies: the bytes are copied
 * into the run's durable transcript, into every checkpoint, into every
 * compaction pass that walks the history, and — because a conversation
 * resends its history — into every subsequent request. A 4 MB PDF attached
 * once is 4 MB in the transcript and 4 MB on the wire per turn for the rest
 * of the run.
 *
 * So a message may carry a REFERENCE instead. The kernel treats `ref` as
 * opaque: this seam says nothing about whether it is a hash, a path, or a
 * URL, because the store that minted it is the only thing that can answer.
 * A content-addressed store gets deduplication for free and this interface
 * neither requires nor prevents that.
 */

/** An attachment whose bytes are held by a store. */
export interface StoredAttachment {
	readonly type: 'stored'
	/**
	 * Opaque to the kernel, meaningful to the store that minted it.
	 *
	 * Never parsed here. A ref that the kernel could interpret is a ref the
	 * kernel could construct, and a model-authored one would then be a path
	 * into whatever the store can reach.
	 */
	readonly ref: string
	/**
	 * What the provider is told this is.
	 *
	 * Declared on the message rather than read from the store, because it
	 * decides which content block gets built and that decision has to be
	 * makeable without a round trip. `resolveAttachment` checks it against
	 * what the store reports and refuses a mismatch.
	 */
	readonly mediaType: string
	/** Which kind of block to build once the bytes arrive. */
	readonly kind: 'image' | 'document'
	/** Shown to the model, for a document it can refer to by name. */
	readonly name?: string
	/** See {@link DocumentAttachment.citations}. Ignored for an image. */
	readonly citations?: boolean
}

export interface StoredBytes {
	readonly data: string
	readonly mediaType: string
}

export interface AttachmentStore {
	/**
	 * Take bytes, return a ref.
	 *
	 * `mediaType` is stored alongside, so `get` can report what it holds and
	 * a caller can be caught claiming something else.
	 */
	put(bytes: StoredBytes): Promise<string>
	/** `undefined` for a ref this store does not hold. */
	get(ref: string): Promise<StoredBytes | undefined>
}

/** A reference nothing could resolve. */
export class AttachmentNotFoundError extends Error {
	readonly details: { ref: string }

	constructor(details: { ref: string }) {
		super(`No attachment for ref "${details.ref}".`)
		this.name = 'AttachmentNotFoundError'
		this.details = details
	}
}

/** A message that carries a ref, in a run with nowhere to resolve it. */
export class NoAttachmentStoreError extends Error {
	readonly details: { ref: string }

	constructor(details: { ref: string }) {
		super(
			`A message carries a stored attachment ("${details.ref}") but this run has no attachment store.`,
		)
		this.name = 'NoAttachmentStoreError'
		this.details = details
	}
}

/** A store whose bytes are not what the message said they were. */
export class AttachmentMediaTypeMismatchError extends Error {
	readonly details: { ref: string; declared: string; stored: string }

	constructor(details: { ref: string; declared: string; stored: string }) {
		super(
			`Attachment "${details.ref}" was declared ${details.declared} but the store holds ${details.stored}.`,
		)
		this.name = 'AttachmentMediaTypeMismatchError'
		this.details = details
	}
}

export const isStoredAttachment = (
	attachment: MessageAttachment,
): attachment is MessageAttachment & StoredAttachment =>
	(attachment as { type?: string }).type === 'stored'

/**
 * Turn a stored attachment into an inline one, or refuse.
 *
 * Every failure here REFUSES rather than dropping the attachment. A message
 * that quietly lost its image is a model answering a question about a
 * picture it never saw, confidently, and nothing in the transcript says
 * why — the worst available outcome, and the reason none of these three
 * branches returns the message unchanged.
 */
export async function resolveAttachment(
	attachment: MessageAttachment,
	store: AttachmentStore | undefined,
): Promise<MessageAttachment> {
	if (!isStoredAttachment(attachment)) return attachment
	if (!store) throw new NoAttachmentStoreError({ ref: attachment.ref })

	const bytes = await store.get(attachment.ref)
	if (!bytes) throw new AttachmentNotFoundError({ ref: attachment.ref })

	if (bytes.mediaType !== attachment.mediaType) {
		// The declared type decides which content block is built and what the
		// provider is told the bytes are. A store holding a PDF under a ref
		// declared `image/png` means one of the two is wrong, and guessing
		// which sends the provider bytes it cannot read while telling it
		// otherwise.
		throw new AttachmentMediaTypeMismatchError({
			ref: attachment.ref,
			declared: attachment.mediaType,
			stored: bytes.mediaType,
		})
	}

	if (attachment.kind === 'document') {
		return {
			type: 'document',
			data: bytes.data,
			mediaType: bytes.mediaType,
			...(attachment.name === undefined ? {} : { name: attachment.name }),
			...(attachment.citations === undefined ? {} : { citations: attachment.citations }),
		}
	}
	return { type: 'image', data: bytes.data, mediaType: bytes.mediaType }
}

/**
 * Resolve every stored attachment on every message.
 *
 * Returns the SAME array when nothing was stored, so the common case costs
 * one scan and no allocation — and so a caller cannot tell resolved
 * messages from unresolved ones by identity and get it wrong.
 */
export async function resolveAttachments(
	messages: readonly Message[],
	store: AttachmentStore | undefined,
): Promise<readonly Message[]> {
	// `Message` rather than a structural constraint: only some members of
	// the union carry `attachments`, and a structural bound over a union
	// like that is not assignable in either direction. Naming the real type
	// costs one import this module already had.
	const has = (message: Message): readonly MessageAttachment[] | undefined =>
		(message as { attachments?: readonly MessageAttachment[] }).attachments

	if (!messages.some((m) => has(m)?.some(isStoredAttachment))) return messages

	return await Promise.all(
		messages.map(async (message) => {
			const attachments = has(message)
			if (!attachments?.some(isStoredAttachment)) return message
			return {
				...message,
				attachments: await Promise.all(attachments.map((a) => resolveAttachment(a, store))),
			}
		}),
	)
}
