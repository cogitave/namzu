import type { AttachmentView } from '../shared/protocol.js'

export const MAX_MESSAGE_PREVIEW_BYTES = 16 * 1024 * 1024
export const MAX_MESSAGE_PREVIEW_REFERENCES = 256
export interface AttachmentPreviewEviction {
	sessionId: string
	attachmentIds: string[]
}
interface PreviewReference {
	sessionId: string
	attachmentId: string
	bytes: number
}

/** Metadata only; admitted file data and display strings remain with their owners. */
export class AttachmentPreviewBudget {
	private references: PreviewReference[] = []
	private bytes = 0
	constructor(
		private readonly maxBytes = MAX_MESSAGE_PREVIEW_BYTES,
		private readonly maxReferences = MAX_MESSAGE_PREVIEW_REFERENCES,
	) {
		if (
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 0 ||
			maxBytes > MAX_MESSAGE_PREVIEW_BYTES ||
			!Number.isSafeInteger(maxReferences) ||
			maxReferences < 0 ||
			maxReferences > MAX_MESSAGE_PREVIEW_REFERENCES
		)
			throw new Error('Invalid message preview budget.')
	}
	admit(sessionId: string, attachments: readonly AttachmentView[]): AttachmentPreviewEviction[] {
		for (const attachment of attachments) {
			if (attachment.kind !== 'image' || !attachment.preview) continue
			const bytes = Buffer.byteLength(attachment.preview)
			this.references.push({ sessionId, attachmentId: attachment.id, bytes })
			this.bytes += bytes
		}
		const evictions = new Map<string, Set<string>>()
		while (this.bytes > this.maxBytes || this.references.length > this.maxReferences) {
			const oldest = this.references[0]
			if (!oldest) break
			const ids = evictions.get(oldest.sessionId) ?? new Set<string>()
			ids.add(oldest.attachmentId)
			evictions.set(oldest.sessionId, ids)
			// One ID can appear in several failed/retried message copies. Retire all
			// of them together, charging each reference until that retirement.
			this.remove(
				(reference) =>
					reference.sessionId === oldest.sessionId &&
					reference.attachmentId === oldest.attachmentId,
			)
		}
		return [...evictions].map(([sessionId, ids]) => ({ sessionId, attachmentIds: [...ids] }))
	}
	/** Reading an owned projection promotes its retained references; it restores no bytes. */
	touch(sessionId: string): void {
		this.references = [
			...this.references.filter((reference) => reference.sessionId !== sessionId),
			...this.references.filter((reference) => reference.sessionId === sessionId),
		]
	}
	forget(sessionId: string): string[] {
		const ids = new Set(
			this.references
				.filter((reference) => reference.sessionId === sessionId)
				.map((reference) => reference.attachmentId),
		)
		this.remove((reference) => reference.sessionId === sessionId)
		return [...ids]
	}
	clear(): void {
		this.references = []
		this.bytes = 0
	}
	private remove(matches: (reference: PreviewReference) => boolean): void {
		this.references = this.references.filter((reference) => {
			if (!matches(reference)) return true
			this.bytes -= reference.bytes
			return false
		})
	}
}
