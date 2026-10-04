import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'
const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
	vi.restoreAllMocks()
})
function harness(env?: NodeJS.ProcessEnv) {
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			...(env ? { env } : {}),
		},
		(event) => {
			recorded.push(event)
			events.emit('update', event)
		},
	)
	operators.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					events.off('update', receive)
					resolve(event)
				}
			}
			events.on('update', receive)
		})
	const permission = async (): Promise<PermissionView> => {
		const event = await wait((event) => event.kind === 'permission')
		if (event.kind !== 'permission') throw new Error('Missing review')
		return event.request
	}
	return { owner, permission, wait, recorded }
}
function turnEndings(recorded: DesktopEvent[], sessionId: string) {
	return recorded.filter(
		(event) =>
			event.kind === 'update' &&
			event.sessionId === sessionId &&
			event.update.kind === 'turn_ended',
	)
}
it('loads models through the owned project and rejects a foreign conversation or invalid provider', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const otherProject = await owner.openProject(fileURLToPath(new URL('.', import.meta.url)))
	const session = await owner.newConversation(project.id)
	expect(await owner.models(project.id, 'fixture', session.id)).toEqual({
		models: [{ id: `fixture-${session.id}`, label: 'Configured fixture model' }],
		notice: null,
	})
	expect(await owner.models(project.id, 'fixture')).toEqual({
		models: [{ id: 'fixture-project', label: 'Configured fixture model' }],
		notice: null,
	})
	await expect(owner.models(otherProject.id, 'fixture', session.id)).rejects.toThrow(
		'belongs to another project',
	)
	await expect(owner.models(project.id, '')).rejects.toThrow('Invalid provider')
	await expect(owner.models(project.id, 'x'.repeat(401))).rejects.toThrow('Invalid provider')
})
it('keeps review ownership, queued text and the live projection across UI reattachment', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	const first = permission()
	owner.send(a.id, 'First request')
	const review = await first
	owner.send(a.id, 'Queued request')
	const restored = await owner.openConversation(project.id, a.id)
	expect(restored.thread).toMatchObject({
		running: true,
		queued: ['Queued request'],
		permissions: [{ id: review.id }],
		messages: [{ role: 'user', text: 'First request' }],
	})
	expect(() => owner.approve(b.id, review.id, true)).toThrow('no longer pending')
	const next = permission()
	owner.approve(a.id, review.id, true)
	const nextReview = await next
	expect(nextReview.id).not.toBe(review.id)
	const ended = wait(
		(event) => event.kind === 'state' && event.sessionId === a.id && !event.running,
	)
	owner.approve(a.id, nextReview.id, false)
	await ended
	expect((await owner.openConversation(project.id, a.id)).thread).toMatchObject({
		running: false,
		queued: [],
		permissions: [],
		messages: [
			{ role: 'user', text: 'First request' },
			{ role: 'assistant', text: 'Approved answer' },
			{ role: 'user', text: 'Queued request' },
			{ role: 'assistant', text: 'Declined answer' },
		],
	})
	expect(() => owner.approve(a.id, review.id, true)).toThrow('no longer pending')
})
it('cancels pending permission without discarding an authored queue', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const first = permission()
	owner.send(a.id, 'First request')
	await first
	owner.send(a.id, 'Retain me')
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === a.id && !event.running,
	)
	await owner.cancel(a.id)
	await stopped
	expect((await owner.openConversation(project.id, a.id)).thread).toMatchObject({
		running: false,
		permissions: [],
		queued: ['Retain me'],
	})
	expect(owner.takeQueued(a.id)).toBe('Retain me')
})

it('records a response-only cancellation once with stable host start/end timestamps and retains its pending queue', async () => {
	let clock = 1_700_000_000_000
	vi.spyOn(Date, 'now').mockImplementation(() => clock)
	const { owner, permission, wait, recorded } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Cancel before a streamed terminal')
	await review
	owner.send(session.id, 'Keep this authored follow-up')
	const startedAt = clock
	clock += 4_321
	const endedAt = clock
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	await owner.cancel(session.id)
	await stopped
	expect(turnEndings(recorded, session.id)).toEqual([
		expect.objectContaining({
			at: endedAt,
			update: { kind: 'turn_ended', stopReason: 'cancelled' },
		}),
	])
	const first = (await owner.openConversation(project.id, session.id)).thread
	expect(first).toMatchObject({
		running: false,
		permissions: [],
		queued: ['Keep this authored follow-up'],
		messages: [{ role: 'user', text: 'Cancel before a streamed terminal' }],
		turns: { 1: { startedAt, endedAt, stopReason: 'cancelled' } },
	})
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(1)
	clock += 123_000
	const restored = (await owner.openConversation(project.id, session.id)).thread
	expect(restored?.turns).toEqual(first?.turns)
	expect((restored?.turns[1]?.endedAt ?? 0) - (restored?.turns[1]?.startedAt ?? 0)).toBe(4_321)
	expect(owner.takeQueued(session.id)).toBe('Keep this authored follow-up')
})

it.each(['Fail turn with fixture', 'Reject turn with fixture'])(
	'records a missing terminal error for %s and preserves its authored message',
	async (prompt) => {
		const clock = 1_700_000_001_000
		vi.spyOn(Date, 'now').mockReturnValue(clock)
		const { owner, wait, recorded } = harness()
		const project = await owner.openProject(process.cwd())
		const session = await owner.newConversation(project.id)
		const stopped = wait(
			(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
		)
		owner.send(session.id, prompt)
		await stopped
		expect(turnEndings(recorded, session.id)).toEqual([
			expect.objectContaining({
				at: clock,
				update: { kind: 'turn_ended', stopReason: 'error' },
			}),
		])
		const first = (await owner.openConversation(project.id, session.id)).thread
		expect(first).toMatchObject({
			running: false,
			permissions: [],
			stopReason: 'error',
			messages: [{ role: 'user', text: prompt }],
			turns: { 1: { startedAt: clock, endedAt: clock, stopReason: 'error' } },
		})
		expect(first?.error).toEqual(expect.any(String))
		expect(JSON.stringify(first)).not.toContain('PRIVATE_TURN_HISTORY_FIXTURE')
		expect((await owner.openConversation(project.id, session.id)).thread?.turns).toEqual(
			first?.turns,
		)
	},
)

it('retains the exact paused reason from a response without misreporting a completed or cancelled turn', async () => {
	const clock = 1_700_000_002_000
	vi.spyOn(Date, 'now').mockReturnValue(clock)
	const { owner, wait, recorded } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.send(session.id, 'Pause turn with fixture')
	await stopped
	expect(turnEndings(recorded, session.id)).toEqual([
		expect.objectContaining({
			at: clock,
			update: { kind: 'turn_ended', stopReason: 'cancelled', reason: 'paused' },
		}),
	])
	const first = (await owner.openConversation(project.id, session.id)).thread
	expect(first?.turns[1]).toMatchObject({
		startedAt: clock,
		endedAt: clock,
		stopReason: 'cancelled',
		reason: 'paused',
	})
	expect(first?.error).toBeUndefined()
	expect(first?.messages).toEqual([{ role: 'user', text: 'Pause turn with fixture' }])
	expect((await owner.openConversation(project.id, session.id)).thread?.turns).toEqual(first?.turns)
})

it('keeps a streamed completion once when the prompt response follows, without shifting its snapshot timestamp', async () => {
	let clock = 1_700_000_003_000
	vi.spyOn(Date, 'now').mockImplementation(() => clock)
	const { owner, permission, wait, recorded } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Complete through the streamed terminal')
	const request = await review
	const startedAt = clock
	clock += 2_100
	const endedAt = clock
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.approve(session.id, request.id, true)
	await stopped
	expect(turnEndings(recorded, session.id)).toEqual([
		expect.objectContaining({
			at: endedAt,
			update: { kind: 'turn_ended', stopReason: 'end_turn' },
		}),
	])
	const first = (await owner.openConversation(project.id, session.id)).thread
	expect(first).toMatchObject({
		running: false,
		permissions: [],
		messages: [
			{ role: 'user', text: 'Complete through the streamed terminal' },
			{ role: 'assistant', text: 'Approved answer' },
		],
		turns: { 1: { startedAt, endedAt, stopReason: 'end_turn' } },
	})
	clock += 87_654
	expect((await owner.openConversation(project.id, session.id)).thread?.turns).toEqual(first?.turns)
	expect(turnEndings(recorded, session.id)).toHaveLength(1)
})

it('reconnects the same project and reattaches its conversation without replaying a failed prompt', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const failed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(a.id, 'Break connection')
	await failed
	expect(await owner.reconnect(project.id)).toMatchObject({
		id: project.id,
		status: 'ready',
	})
	const history = await owner.openConversation(project.id, a.id)
	expect(history.thread).toMatchObject({
		running: false,
		messages: [{ role: 'user', text: 'Break connection' }],
		permissions: [],
	})
	const review = permission()
	owner.send(a.id, 'Explicit retry')
	const request = await review
	expect(request.calls[0]?.input).toEqual({ prompt: 'Explicit retry' })
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.approve(a.id, request.id, true)
	await ended
})

it('retains separate authored drafts on reattachment and refuses invalid draft writes', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	owner.saveDraft(a.id, 'Unsent in first conversation')
	owner.saveDraft(b.id, 'Unsent in second conversation')
	await owner.openConversation(project.id, b.id)
	await owner.openConversation(project.id, a.id)
	expect(owner.draft(a.id)).toBe('Unsent in first conversation')
	expect(owner.draft(b.id)).toBe('Unsent in second conversation')
	expect(() => owner.saveDraft('foreign-session', 'Cannot attach')).toThrow(
		'Open this conversation',
	)
	expect(() => owner.saveDraft(a.id, 'x'.repeat(50_001))).toThrow('50,000')
	expect(owner.draft(a.id)).toBe('Unsent in first conversation')
})

it('keeps drafts available during connection failure and restores them after reconnect', async () => {
	const { owner, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	owner.saveDraft(session.id, 'Do not discard on disconnect')
	const failed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(session.id, 'Break connection')
	await failed
	expect(owner.draft(session.id)).toBe('Do not discard on disconnect')
	owner.saveDraft(session.id, 'Can keep writing while disconnected')
	expect(await owner.listConversations(project.id)).toContainEqual(
		expect.objectContaining({ id: session.id }),
	)
	expect((await owner.openConversation(project.id, session.id)).messages).toEqual([
		{ role: 'user', text: 'Break connection' },
	])
	expect(await owner.providers(project.id, session.id)).toEqual({
		available: [],
		selected: null,
	})
	expect(() => owner.send(session.id, 'Do not pretend this connected')).toThrow(
		'Reopen this project',
	)
	await owner.reconnect(project.id)
	await owner.openConversation(project.id, session.id)
	expect(owner.draft(session.id)).toBe('Can keep writing while disconnected')
})

it('keeps an unsent conversation usable after reconnect without loading missing durable history', async () => {
	const { owner, wait, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const started = await owner.newConversation(project.id)
	const unsent = await owner.newConversation(project.id)
	owner.saveDraft(unsent.id, 'My unsubmitted request')
	const failed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(started.id, 'Break connection')
	await failed
	await owner.reconnect(project.id)
	expect(await owner.listConversations(project.id)).toContainEqual(
		expect.objectContaining({ id: unsent.id }),
	)
	await Promise.all([
		owner.openConversation(project.id, unsent.id),
		owner.openConversation(project.id, unsent.id),
	])
	expect(owner.draft(unsent.id)).toBe('My unsubmitted request')
	const review = permission()
	owner.send(unsent.id, owner.draft(unsent.id))
	const request = await review
	expect(request.sessionId).toBe(unsent.id)
	expect(request.calls[0]?.input).toEqual({ prompt: 'My unsubmitted request' })
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.approve(unsent.id, request.id, true)
	await ended
	expect((await owner.openConversation(project.id, unsent.id)).messages).toContainEqual({
		role: 'assistant',
		text: 'Approved answer',
	})
})

it('keeps attachment-only and settings-only draft conversations listed and usable after reconnect', async () => {
	const { owner, wait, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const started = await owner.newConversation(project.id)
	const fileOnly = await owner.newConversation(project.id)
	const settingsOnly = await owner.newConversation(project.id)
	const empty = await owner.newConversation(project.id)
	const files = owner.addAttachments(fileOnly.id, [
		{ name: 'notes.txt', bytes: Buffer.from('Retained contents') },
	])
	const settings = {
		choice: { provider: 'fixture', model: 'selected', label: 'Selected model' },
		options: { effort: 'high' as const, permissionMode: 'strict' as const },
	}
	owner.saveDraftSettings(settingsOnly.id, settings)
	owner.saveDraftSettings(empty.id, { options: {} })
	const failed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(started.id, 'Break connection')
	await failed
	await owner.reconnect(project.id)
	const listed = await owner.listConversations(project.id)
	for (const id of [fileOnly.id, settingsOnly.id])
		expect(listed).toContainEqual(expect.objectContaining({ id }))
	expect(listed).not.toContainEqual(expect.objectContaining({ id: empty.id }))
	await Promise.all([
		owner.openConversation(project.id, fileOnly.id),
		owner.openConversation(project.id, settingsOnly.id),
	])
	expect(owner.draft(fileOnly.id)).toBe('')
	expect(owner.attachments(fileOnly.id)).toEqual(files)
	expect(owner.draftSettings(settingsOnly.id)).toEqual(settings)
	const fileReview = permission()
	owner.send(fileOnly.id, '', { attachmentIds: files.map((file) => file.id) })
	const fileRequest = await fileReview
	expect(fileRequest.sessionId).toBe(fileOnly.id)
	expect(fileRequest.calls[0]?.input).toEqual({
		prompt: 'Attached text file: "notes.txt"\nRetained contents',
	})
	const fileEnded = wait(
		(event) => event.kind === 'state' && event.sessionId === fileOnly.id && !event.running,
	)
	owner.approve(fileOnly.id, fileRequest.id, true)
	await fileEnded
	const settingsReview = permission()
	owner.send(
		settingsOnly.id,
		'Continue my settings-only draft',
		owner.draftSettings(settingsOnly.id).options,
	)
	const settingsRequest = await settingsReview
	expect(settingsRequest.sessionId).toBe(settingsOnly.id)
	const settingsEnded = wait(
		(event) => event.kind === 'state' && event.sessionId === settingsOnly.id && !event.running,
	)
	owner.approve(settingsOnly.id, settingsRequest.id, true)
	await settingsEnded
})

it('edits and removes queued identities without overwriting a draft or another conversation', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	const pending = permission()
	owner.send(a.id, 'Wait for approval')
	await pending
	owner.send(a.id, 'Repeated queued text')
	owner.send(a.id, 'Repeated queued text')
	const queue = (await owner.openConversation(project.id, a.id)).thread?.queuedItems ?? []
	expect(queue).toHaveLength(2)
	expect(queue[0]?.id).not.toBe(queue[1]?.id)
	owner.saveDraft(a.id, 'Already writing a different request')
	expect(() => owner.takeQueued(a.id, queue[1]?.id)).toThrow('current draft')
	expect(owner.draft(a.id)).toBe('Already writing a different request')
	expect((await owner.openConversation(project.id, a.id)).thread?.queued).toHaveLength(2)
	expect(() => owner.removeQueued(b.id, queue[0]?.id ?? '')).toThrow('already started')
	owner.removeQueued(a.id, queue[0]?.id ?? '')
	expect((await owner.openConversation(project.id, a.id)).thread?.queuedItems).toEqual([queue[1]])
	expect(() => owner.removeQueued(a.id, queue[0]?.id ?? '')).toThrow('already started')
	owner.saveDraft(a.id, '')
	expect(owner.takeQueued(a.id, queue[1]?.id)).toBe('Repeated queued text')
	expect(owner.draft(a.id)).toBe('Repeated queued text')
	expect((await owner.openConversation(project.id, a.id)).thread?.queued).toEqual([])
})

it('keeps project landing drafts separate from conversations without creating a session', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const landing = `project:${project.id}`
	owner.saveDraft(landing, 'My first unsent project prompt')
	expect(owner.draft(landing)).toBe('My first unsent project prompt')
	expect(await owner.listConversations(project.id)).toEqual([])
	const conversation = await owner.newConversation(project.id)
	owner.saveDraft(conversation.id, 'Different conversation draft')
	expect(owner.draft(landing)).toBe('My first unsent project prompt')
	expect(owner.draft(conversation.id)).toBe('Different conversation draft')
	expect(() => owner.saveDraft('project:unknown', 'Rejected')).toThrow('Unknown project')
	expect(() => owner.saveDraft(landing, 'x'.repeat(50_001))).toThrow('50,000')
})

it('promotes files without rereading bytes, preserves them on refusal and restores queued edits', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const ownerId = `project:${project.id}`
	const files = owner.addAttachments(ownerId, [
		{ name: 'notes.txt', bytes: Buffer.from('EXACT_FILE_CONTENT') },
	])
	const session = await owner.newConversation(project.id)
	expect(owner.moveAttachments(ownerId, session.id)).toEqual(files)
	expect(owner.attachments(ownerId)).toEqual([])
	expect(() =>
		owner.send(session.id, 'x'.repeat(50_001), { attachmentIds: files.map((file) => file.id) }),
	).toThrow('50,000')
	expect(owner.attachments(session.id)).toEqual(files)
	const review = permission()
	owner.send(session.id, 'Wait')
	await review
	owner.send(session.id, 'Queued files', {
		attachmentIds: files.map((file) => file.id),
		effort: 'high',
		permissionMode: 'strict',
	})
	const queue = (await owner.openConversation(project.id, session.id)).thread?.queuedItems ?? []
	expect(queue[0]).toMatchObject({
		prompt: 'Queued files',
		attachments: files,
		effort: 'high',
		permissionMode: 'strict',
	})
	expect(owner.attachments(session.id)).toEqual([])
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	await owner.cancel(session.id)
	await stopped
	owner.saveDraftSettings(session.id, {
		choice: { provider: 'fixture', model: 'selected' },
		options: { effort: 'low', permissionMode: 'plan' },
	})
	expect(owner.takeQueued(session.id, queue[0]?.id)).toBe('Queued files')
	expect(owner.attachments(session.id)).toEqual(files)
	expect(owner.draftSettings(session.id)).toEqual({
		choice: { provider: 'fixture', model: 'selected' },
		options: { effort: 'high', permissionMode: 'strict' },
	})
	owner.saveDraft(session.id, '')
	const retryReview = permission()
	owner.send(session.id, '', { attachmentIds: files.map((file) => file.id) })
	const request = await retryReview
	expect(request.calls[0]?.input).toEqual({
		prompt: 'Attached text file: "notes.txt"\nEXACT_FILE_CONTENT',
	})
})

it('refuses attachment ownership theft and frees queued blobs when removing a queued message', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	const files = owner.addAttachments(a.id, [
		{ name: 'owned.txt', bytes: Buffer.from('Owned content') },
	])
	expect(() => owner.send(b.id, 'Steal', { attachmentIds: files.map((file) => file.id) })).toThrow(
		'another draft',
	)
	expect(() => owner.removeAttachment(b.id, files[0]?.id ?? '')).toThrow('belongs to this draft')
	expect(owner.attachments(a.id)).toEqual(files)
	const review = permission()
	owner.send(a.id, 'Wait')
	await review
	owner.send(a.id, 'Queued files', { attachmentIds: files.map((file) => file.id) })
	const queue = (await owner.openConversation(project.id, a.id)).thread?.queuedItems ?? []
	owner.removeQueued(a.id, queue[0]?.id ?? '')
	expect(owner.attachments(a.id)).toEqual([])
	expect(() =>
		owner.send(a.id, 'No longer retained', { attachmentIds: files.map((file) => file.id) }),
	).toThrow('another draft')
})

it('bounds retained queued image bytes and releases their budget on queue removal', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Wait')
	await review
	const image = Buffer.alloc(3 * 1024 * 1024)
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
	for (let index = 0; index < 8; index += 1) {
		const files = owner.addAttachments(session.id, [{ name: 'image.png', bytes: image }])
		owner.send(session.id, `Queued ${index}`, { attachmentIds: files.map((file) => file.id) })
	}
	expect(() =>
		owner.addAttachments(session.id, [{ name: 'over-budget.png', bytes: image }]),
	).toThrow('storage is full')
	const queue = (await owner.openConversation(project.id, session.id)).thread?.queuedItems ?? []
	expect(queue).toHaveLength(8)
	owner.removeQueued(session.id, queue[0]?.id ?? '')
	expect(owner.addAttachments(session.id, [{ name: 'room-again.png', bytes: image }])).toHaveLength(
		1,
	)
})

it('sends admitted image bytes unchanged and restores them to the draft after cancellation', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const image = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBz8AAAAASUVORK5CYII=',
		'base64',
	)
	const data = image.toString('base64')
	const files = owner.addAttachments(session.id, [{ name: 'pixel.png', bytes: image }])
	image.fill(0)
	const review = permission()
	owner.send(session.id, '', { attachmentIds: files.map((file) => file.id) })
	const request = await review
	expect(request.calls[0]?.input).toEqual({
		prompt: 'Attached image: "pixel.png"',
		attachments: [{ type: 'image', mediaType: 'image/png', data }],
	})
	expect(owner.attachments(session.id)).toEqual([])
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	await owner.cancel(session.id)
	await stopped
	expect(owner.attachments(session.id)).toEqual(files)
})

it('keeps image drafts when an older CLI cannot receive attachments', async () => {
	const { owner } = harness({ ...process.env, FIXTURE_NO_ATTACHMENTS: '1' })
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const files = owner.addAttachments(session.id, [
		{ name: 'image.png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
	])
	expect(() =>
		owner.send(session.id, 'Keep the image', { attachmentIds: files.map((file) => file.id) }),
	).toThrow('can receive image attachments')
	expect(owner.attachments(session.id)).toEqual(files)
	expect((await owner.openConversation(project.id, session.id)).thread?.messages).toEqual([])
})

it('refuses unsupported explicit settings before consuming the draft, but retains default-prompt compatibility', async () => {
	const { owner, permission } = harness({ ...process.env, FIXTURE_NO_OPTIONS: '1' })
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	owner.saveDraft(session.id, 'Keep my draft')
	const files = owner.addAttachments(session.id, [
		{ name: 'notes.txt', bytes: Buffer.from('Owned notes') },
	])
	for (const settings of [{ effort: 'high' as const }, { permissionMode: 'strict' as const }]) {
		expect(() =>
			owner.send(session.id, 'Keep my draft', {
				attachmentIds: files.map((file) => file.id),
				...settings,
			}),
		).toThrow('apply message settings')
	}
	expect(owner.draft(session.id)).toBe('Keep my draft')
	expect(owner.attachments(session.id)).toEqual(files)
	expect((await owner.openConversation(project.id, session.id)).thread?.messages).toEqual([])
	const review = permission()
	owner.send(session.id, 'Keep my draft', {
		permissionMode: 'prompt',
		attachmentIds: files.map((file) => file.id),
	})
	expect((await review).calls[0]?.input).toEqual({
		prompt: 'Keep my draft\n\nAttached text file: "notes.txt"\nOwned notes',
	})
})

it('retains bounded draft settings in the main owner across navigation and disconnection', async () => {
	const { owner, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const landing = `project:${project.id}`
	const session = await owner.newConversation(project.id)
	const settings = {
		choice: { provider: 'fixture', model: 'chosen', label: 'Chosen model' },
		options: { effort: 'high' as const, permissionMode: 'strict' as const },
	}
	owner.saveDraftSettings(landing, settings)
	owner.saveDraftSettings(session.id, owner.draftSettings(landing))
	settings.choice.model = 'mutated renderer object'
	const loaded = owner.draftSettings(session.id)
	if (loaded.choice) loaded.choice.model = 'mutated read result'
	expect(owner.draftSettings(landing).choice?.model).toBe('chosen')
	expect(owner.draftSettings(session.id).choice?.model).toBe('chosen')
	expect(() =>
		owner.saveDraftSettings(session.id, {
			choice: { provider: 'fixture', model: 'x'.repeat(401) },
		}),
	).toThrow('Invalid draft model choice')
	expect(() =>
		owner.saveDraftSettings(session.id, { options: { attachmentIds: ['foreign'] } } as never),
	).toThrow('Invalid draft message settings')
	expect(() => owner.draftSettings('project:unknown')).toThrow('Unknown project')
	const closed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(session.id, 'Break connection')
	await closed
	expect(owner.draftSettings(session.id)).toEqual({
		choice: { provider: 'fixture', model: 'chosen', label: 'Chosen model' },
		options: { effort: 'high', permissionMode: 'strict' },
	})
	owner.saveDraftSettings(landing, {})
	expect(owner.draftSettings(landing)).toEqual({})
	expect(owner.draftSettings(session.id).choice?.model).toBe('chosen')
})
