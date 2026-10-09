import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { ThreadState } from '../shared/projection.js'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { MAX_MESSAGE_PREVIEW_BYTES } from './attachment-preview-budget.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
})

function harness(onEvent?: (event: DesktopEvent) => void) {
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		(event) => {
			recorded.push(event)
			events.emit('update', event)
			onEvent?.(event)
		},
	)
	operators.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (!predicate(event)) return
				events.off('update', receive)
				resolve(event)
			}
			events.on('update', receive)
		})
	const permission = async (): Promise<PermissionView> => {
		const event = await wait((value) => value.kind === 'permission')
		if (event.kind !== 'permission') throw new Error('Missing fixture review')
		return event.request
	}
	return { owner, recorded, wait, permission }
}

function image(fill: number): Buffer {
	const bytes = Buffer.alloc(3 * 1024 * 1024, fill)
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
	return bytes
}

function previewBytes(...threads: ThreadState[]): number {
	return threads.reduce(
		(total, thread) =>
			total +
			thread.messages.reduce(
				(messageBytes, message) =>
					messageBytes +
					(message.attachments ?? []).reduce(
						(bytes, attachment) => bytes + Buffer.byteLength(attachment.preview ?? ''),
						0,
					),
				0,
			),
		0,
	)
}

it('bounds live previews across owners and strips every copy of a retried image without changing admitted bytes', async () => {
	const { owner, recorded, wait, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const first = await owner.newConversation(project.id)
	const second = await owner.newConversation(project.id)
	const original = image(1)
	const originalData = original.toString('base64')
	const originalFiles = owner.addAttachments(first.id, [{ name: 'original.png', bytes: original }])
	const originalId = originalFiles[0]?.id
	if (!originalId) throw new Error('Missing original attachment')

	const cancelledReview = permission()
	owner.send(first.id, 'First attempt', { attachmentIds: [originalId] })
	const cancelledRequest = await cancelledReview
	expect(cancelledRequest.calls[0]?.input).toMatchObject({
		attachments: [{ type: 'image', mediaType: 'image/png', data: originalData }],
	})
	const cancelled = wait(
		(event) => event.kind === 'state' && event.sessionId === first.id && !event.running,
	)
	await owner.cancel(first.id)
	await cancelled
	expect(owner.attachments(first.id)).toEqual(originalFiles)

	const retryReview = permission()
	owner.send(first.id, 'Retry same image', { attachmentIds: [originalId] })
	const retryRequest = await retryReview
	expect(retryRequest.calls[0]?.input).toMatchObject({
		attachments: [{ type: 'image', mediaType: 'image/png', data: originalData }],
	})
	const retryEnded = wait(
		(event) => event.kind === 'state' && event.sessionId === first.id && !event.running,
	)
	owner.respondPermission(first.id, retryRequest.id, { outcome: 'approve' })
	await retryEnded

	// Each admitted image keeps one preview of the same encoded size, and the original is held twice
	// (the cancelled attempt and the retry). Fill the budget past its limit with the least that
	// does it, plus one image to spare, so the oldest copies are retired by the bound itself.
	const previewSize = Buffer.byteLength(`data:image/png;base64,${originalData}`)
	const referencesToOverflow = Math.floor(MAX_MESSAGE_PREVIEW_BYTES / previewSize) + 1
	const laterImages = referencesToOverflow - 2 + 1
	for (let index = 0; index < laterImages; index += 1) {
		const sessionId = index % 2 === 0 ? second.id : first.id
		const bytes = image(index + 2)
		const files = owner.addAttachments(sessionId, [{ name: `image-${index}.png`, bytes }])
		const review = permission()
		owner.send(sessionId, `Image ${index}`, { attachmentIds: files.map((file) => file.id) })
		const request = await review
		expect(request.calls[0]?.input).toMatchObject({
			attachments: [{ type: 'image', mediaType: 'image/png', data: bytes.toString('base64') }],
		})
		const ended = wait(
			(event) => event.kind === 'state' && event.sessionId === sessionId && !event.running,
		)
		owner.respondPermission(sessionId, request.id, { outcome: 'approve' })
		await ended
	}
	const firstThread = (await owner.openConversation(project.id, first.id)).thread
	const secondThread = (await owner.openConversation(project.id, second.id)).thread
	if (!firstThread || !secondThread) throw new Error('Missing owned projection')
	expect(previewBytes(firstThread, secondThread)).toBeLessThanOrEqual(MAX_MESSAGE_PREVIEW_BYTES)
	const repeated = firstThread.messages.flatMap((message) =>
		(message.attachments ?? []).filter((attachment) => attachment.id === originalId),
	)
	expect(repeated).toHaveLength(2)
	expect(repeated.every((attachment) => attachment.kind === 'image' && !attachment.preview)).toBe(
		true,
	)
	expect(
		recorded.some(
			(event) =>
				event.kind === 'attachment-previews-evicted' &&
				event.sessionId === first.id &&
				event.attachmentIds.includes(originalId),
		),
	).toBe(true)

	// A later retirement may change old transcript previews, but queued and
	// unsent files still own the same encoded bytes for a future prompt.
	const holdReview = permission()
	owner.send(first.id, 'Hold queued files')
	await holdReview
	const queuedBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
	const queuedFiles = owner.addAttachments(first.id, [{ name: 'queued.png', bytes: queuedBytes }])
	owner.send(first.id, 'Queued image', { attachmentIds: queuedFiles.map((file) => file.id) })
	const draftFiles = owner.addAttachments(first.id, [{ name: 'draft.png', bytes: queuedBytes }])
	const queuedItem = (await owner.openConversation(project.id, first.id)).thread?.queuedItems[0]
	if (!queuedItem) throw new Error('Missing queued image')
	expect(queuedItem.attachments).toEqual(queuedFiles)
	expect(owner.attachments(first.id)).toEqual(draftFiles)

	const moreBytes = image(98)
	const moreFiles = owner.addAttachments(second.id, [
		{ name: 'retire-again.png', bytes: moreBytes },
	])
	const moreReview = permission()
	owner.send(second.id, 'Retire old previews', {
		attachmentIds: moreFiles.map((file) => file.id),
	})
	const moreRequest = await moreReview
	const moreEnded = wait(
		(event) => event.kind === 'state' && event.sessionId === second.id && !event.running,
	)
	owner.respondPermission(second.id, moreRequest.id, { outcome: 'approve' })
	await moreEnded
	expect((await owner.openConversation(project.id, first.id)).thread?.queuedItems[0]).toMatchObject(
		{
			id: queuedItem.id,
			attachments: queuedFiles,
		},
	)
	expect(owner.attachments(first.id)).toEqual(draftFiles)
	const heldStopped = wait(
		(event) => event.kind === 'state' && event.sessionId === first.id && !event.running,
	)
	await owner.cancel(first.id)
	await heldStopped
	owner.saveDraft(first.id, '')
	const draftDelivery = permission()
	owner.send(first.id, 'Unsent draft image', { attachmentIds: draftFiles.map((file) => file.id) })
	const draftRequest = await draftDelivery
	expect(draftRequest.calls[0]?.input).toMatchObject({
		attachments: [{ type: 'image', mediaType: 'image/png', data: queuedBytes.toString('base64') }],
	})
	const queuedDelivery = permission()
	owner.respondPermission(first.id, draftRequest.id, { outcome: 'approve' })
	const queuedRequest = await queuedDelivery
	expect(queuedRequest.calls[0]?.input).toMatchObject({
		attachments: [{ type: 'image', mediaType: 'image/png', data: queuedBytes.toString('base64') }],
	})
	const queuedEnded = wait(
		(event) => event.kind === 'state' && event.sessionId === first.id && !event.running,
	)
	owner.respondPermission(first.id, queuedRequest.id, { outcome: 'approve' })
	await queuedEnded
	expect(owner.attachments(first.id)).toEqual([])
})

it('commits budget evictions before a renderer publication callback can throw', async () => {
	let throwOnPrompt = false
	let thrown = false
	const { owner, wait, permission } = harness((event) => {
		if (throwOnPrompt && event.kind === 'prompt') {
			thrown = true
			throw new Error('Fixture renderer publication failed')
		}
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	for (let index = 0; index < 4; index += 1) {
		const bytes = image(index + 10)
		const files = owner.addAttachments(session.id, [{ name: `before-${index}.png`, bytes }])
		const review = permission()
		owner.send(session.id, `Before ${index}`, { attachmentIds: files.map((file) => file.id) })
		const request = await review
		const ended = wait(
			(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
		)
		owner.respondPermission(session.id, request.id, { outcome: 'approve' })
		await ended
	}
	const failingFiles = owner.addAttachments(session.id, [
		{ name: 'failed-publication.png', bytes: image(99) },
	])
	throwOnPrompt = true
	owner.send(session.id, 'Publication failure', {
		attachmentIds: failingFiles.map((file) => file.id),
	})
	expect(thrown).toBe(true)
	const thread = (await owner.openConversation(project.id, session.id)).thread
	if (!thread) throw new Error('Missing owned projection')
	expect(previewBytes(thread)).toBeLessThanOrEqual(MAX_MESSAGE_PREVIEW_BYTES)
	expect(thread.messages.some((message) => message.text === 'Publication failure')).toBe(true)
})
