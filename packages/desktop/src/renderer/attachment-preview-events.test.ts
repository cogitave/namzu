import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
import type { AttachmentView } from '../shared/protocol.js'
import { applyCachedAttachmentPreviewEviction } from './attachment-preview-events.js'

const file: AttachmentView = {
	id: 'image',
	name: 'retained.png',
	kind: 'image',
	size: 10,
	mediaType: 'image/png',
	preview: 'data:image/png;base64,aGVsbG8=',
}
const prompt = (revision: number) => ({
	kind: 'prompt' as const,
	sessionId: 'a',
	prompt: 'Review it',
	attachments: [file],
	revision,
})
const eviction = {
	kind: 'attachment-previews-evicted' as const,
	sessionId: 'a',
	attachmentIds: ['image'],
	revision: 3,
}

it('removes only copied message previews, including repeated attempts, and leaves admitted views and queues intact', () => {
	let thread = applyEvent(emptyThread(), prompt(1))
	thread = applyEvent(thread, prompt(2))
	thread = {
		...thread,
		queuedItems: [{ id: 'q', prompt: 'Next', attachments: [file] }],
		running: true,
	}
	const original = thread
	const next = applyEvent(thread, eviction)
	expect(next.messages.map((row) => row.attachments?.[0])).toEqual([
		{ id: file.id, name: file.name, kind: file.kind, size: file.size, mediaType: file.mediaType },
		{ id: file.id, name: file.name, kind: file.kind, size: file.size, mediaType: file.mediaType },
	])
	expect(original.messages[0]?.attachments?.[0]?.preview).toBe(file.preview)
	expect(next.queuedItems).toBe(original.queuedItems)
	expect(next.queuedItems[0]?.attachments?.[0]?.preview).toBe(file.preview)
	expect(next.running).toBe(true)
	expect(next.timeline).toBe(original.timeline)
	expect(file.preview).toBeDefined()
})

it('retires a cached inactive owner without affecting another owner or fabricating a missing thread', () => {
	const a = applyEvent(emptyThread(), prompt(1))
	const b = { ...a, revision: 7 }
	const cache = { a, b }
	const next = applyCachedAttachmentPreviewEviction(cache, eviction)
	expect(next.a?.messages[0]?.attachments?.[0]?.preview).toBeUndefined()
	expect(next.b).toBe(b)
	expect(applyCachedAttachmentPreviewEviction(next, { ...eviction, sessionId: 'missing' })).toBe(
		next,
	)
	expect(applyCachedAttachmentPreviewEviction(next, eviction)).toBe(next)
})

it('replays retirement over an older held snapshot and ignores superseded revisions', () => {
	const snapshot = applyEvent(emptyThread(), prompt(1))
	const replayed = applyEvent(snapshot, eviction)
	expect(snapshot.messages[0]?.attachments?.[0]?.preview).toBeDefined()
	expect(replayed.messages[0]?.attachments?.[0]?.preview).toBeUndefined()
	expect(replayed.revision).toBe(3)
	expect(applyEvent(replayed, { ...eviction, revision: 2 })).toBe(replayed)
	// A genuinely new retry may show a new copied preview of the same admitted
	// file; an older retirement cannot erase that later admission.
	const retry = applyEvent(replayed, prompt(4))
	expect(applyEvent(retry, eviction)).toBe(retry)
	expect(retry.messages.at(-1)?.attachments?.[0]?.preview).toBe(file.preview)
})
