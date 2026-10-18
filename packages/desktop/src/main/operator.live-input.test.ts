import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
	for (const directory of directories.splice(0)) {
		for (const name of ['delivery', 'mode']) {
			const path = join(directory, name)
			if (existsSync(path)) unlinkSync(path)
		}
		rmdirSync(directory)
	}
})

function harness(live = true) {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-live-input-'))
	directories.push(directory)
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: {
				...process.env,
				...(live ? { FIXTURE_LIVE_INPUT: '1' } : {}),
				FIXTURE_LIVE_INPUT_DELIVERY_FILE: join(directory, 'delivery'),
				FIXTURE_LIVE_INPUT_MODE_FILE: join(directory, 'mode'),
			},
		},
		(event) => {
			recorded.push(event)
			events.emit('event', event)
		},
	)
	operators.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (!predicate(event)) return
				events.off('event', receive)
				resolve(event)
			}
			events.on('event', receive)
		})
	const permission = async (): Promise<PermissionView> => {
		const event = await wait((item) => item.kind === 'permission')
		if (event.kind !== 'permission') throw new Error('Missing fixture review')
		return event.request
	}
	return { owner, recorded, wait, permission, directory }
}

it('delivers text to the active Namzu turn once without starting another prompt', async () => {
	const { owner, recorded, wait, permission, directory } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Original request')
	const pending = await review
	owner.saveDraft(session.id, 'Please answer me while the task works')
	expect(await owner.sendCurrent(session.id, 'Please answer me while the task works')).toBe(
		'accepted',
	)
	let thread = (await owner.openConversation(project.id, session.id)).thread
	expect(thread?.queued).toEqual([])
	expect(thread?.liveInputs).toMatchObject([{ status: 'pending' }])
	expect(owner.draft(session.id)).toBe('')
	writeFileSync(join(directory, 'delivery'), 'deliver')
	const settled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, pending.id, { outcome: 'approve' })
	await settled
	thread = (await owner.openConversation(project.id, session.id)).thread
	// A settled turn keeps the delivered message in the transcript but not as a receipt.
	expect(thread?.liveInputs).toEqual([])
	expect(
		thread?.messages.filter((message) => message.role === 'user').map((message) => message.text),
	).toEqual(['Original request', 'Please answer me while the task works'])
	expect(thread?.turn).toBe(1)
	expect(owner.draft(session.id)).toBe('')
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(1)
})

it('returns accepted but undelivered text to the draft after stopping the turn', async () => {
	const { owner, wait, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Original request')
	await review
	owner.saveDraft(session.id, 'Wait for me')
	expect(await owner.sendCurrent(session.id, 'Wait for me')).toBe('accepted')
	expect(owner.draft(session.id)).toBe('')
	const settled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	await owner.cancel(session.id)
	await settled
	expect(owner.draft(session.id)).toBe('Wait for me')
	expect((await owner.openConversation(project.id, session.id)).thread?.liveInputs).toEqual([])
	expect((await owner.openConversation(project.id, session.id)).thread?.queued).toEqual([])
})

it('retains uncertain admission after a lost ACK and failed status without replaying it', async () => {
	const { owner, recorded, wait, permission, directory } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Original request')
	const pending = await review
	const text = 'Keep this uncertain message'
	owner.saveDraft(session.id, text)
	writeFileSync(join(directory, 'mode'), 'lost-ack-and-status')
	await expect(owner.sendCurrent(session.id, text)).rejects.toThrow('ACK lost')
	expect((await owner.openConversation(project.id, session.id)).thread?.liveInputs).toMatchObject([
		{ status: 'unknown' },
	])
	const settled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, pending.id, { outcome: 'approve' })
	await settled
	expect(owner.draft(session.id)).toBe(text)
	expect((await owner.openConversation(project.id, session.id)).thread?.queued).toEqual([])
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(1)
})

it('holds uncertain text behind an authored edit until the operator explicitly takes it', async () => {
	const { owner, recorded, wait, permission, directory } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Original request')
	const pending = await review
	owner.saveDraft(session.id, 'Unconfirmed live text')
	writeFileSync(join(directory, 'mode'), 'lost-ack-and-status')
	await expect(owner.sendCurrent(session.id, 'Unconfirmed live text')).rejects.toThrow('ACK lost')
	owner.saveDraft(session.id, 'New authored draft')
	const firstSettled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, pending.id, { outcome: 'approve' })
	await firstSettled
	expect(owner.draft(session.id)).toBe('New authored draft')
	expect((await owner.openConversation(project.id, session.id)).thread?.queued).toEqual([
		'Unconfirmed live text',
	])
	owner.send(session.id, 'Separate explicit prompt')
	const nextReview = await permission()
	const secondSettled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, nextReview.id, { outcome: 'approve' })
	await secondSettled
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(2)
	expect((await owner.openConversation(project.id, session.id)).thread?.queued).toEqual([
		'Unconfirmed live text',
	])
	owner.saveDraft(session.id, '')
	expect(owner.takeQueued(session.id)).toBe('Unconfirmed live text')
	expect(owner.draft(session.id)).toBe('Unconfirmed live text')
})

it('does not retain a false live attempt when the exact scope confirms it was never admitted', async () => {
	const { owner, wait, permission, directory } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = permission()
	owner.send(session.id, 'Original request')
	const pending = await review
	owner.saveDraft(session.id, 'Rejected input')
	writeFileSync(join(directory, 'mode'), 'reject-before-admit')
	await expect(owner.sendCurrent(session.id, 'Rejected input')).rejects.toThrow(
		'Input refused before admission',
	)
	expect((await owner.openConversation(project.id, session.id)).thread?.liveInputs).toEqual([])
	const settled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, pending.id, { outcome: 'approve' })
	await settled
	expect(owner.draft(session.id)).toBe('Rejected input')
	expect((await owner.openConversation(project.id, session.id)).thread?.queued).toEqual([])
})

it('keeps explicit and unsupported submissions in the normal next-turn queue', async () => {
	for (const live of [true, false]) {
		const { owner, wait, permission } = harness(live)
		const project = await owner.openProject(process.cwd())
		const session = await owner.newConversation(project.id)
		const review = permission()
		owner.send(session.id, 'Original request')
		await review
		if (live) owner.send(session.id, 'Explicit queue')
		else expect(await owner.sendCurrent(session.id, 'Unsupported live input')).toBe('queued')
		expect((await owner.openConversation(project.id, session.id)).thread?.queued).toEqual([
			live ? 'Explicit queue' : 'Unsupported live input',
		])
		const settled = wait(
			(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
		)
		await owner.cancel(session.id)
		await settled
	}
})

it('send now stops the reply and starts the waiting message at once', async () => {
	const { owner, recorded, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const first = permission()
	owner.send(session.id, 'Original request')
	await first
	owner.send(session.id, 'Wait for the reply')
	owner.send(session.id, 'Then this one')
	const queued = (await owner.openConversation(project.id, session.id)).thread?.queuedItems ?? []
	expect(queued.map((item) => item.prompt)).toEqual(['Wait for the reply', 'Then this one'])
	// The later message jumps the line: it is the one asked for.
	const next = permission()
	await owner.sendNow(session.id, queued[1]?.id)
	await next
	expect(
		recorded
			.filter((event) => event.kind === 'prompt' && event.sessionId === session.id)
			.map((event) => (event.kind === 'prompt' ? event.prompt : '')),
	).toEqual(['Original request', 'Then this one'])
	const after = (await owner.openConversation(project.id, session.id)).thread
	expect(after?.queued).toEqual(['Wait for the reply'])
})

it('send now on a message sent into the reply starts it as the next one instead of a draft', async () => {
	const { owner, recorded, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const first = permission()
	owner.send(session.id, 'Original request')
	await first
	owner.saveDraft(session.id, 'Take this now')
	expect(await owner.sendCurrent(session.id, 'Take this now')).toBe('accepted')
	const receipt = (await owner.openConversation(project.id, session.id)).thread?.liveInputs[0]
	expect(receipt?.status).toBe('pending')
	const next = permission()
	await owner.sendNow(session.id, receipt?.id)
	await next
	expect(
		recorded
			.filter((event) => event.kind === 'prompt' && event.sessionId === session.id)
			.map((event) => (event.kind === 'prompt' ? event.prompt : '')),
	).toEqual(['Original request', 'Take this now'])
	expect(owner.draft(session.id)).toBe('')
})

it('send now after a stopped reply starts the waiting message without a new turn first', async () => {
	const { owner, recorded, wait, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const first = permission()
	owner.send(session.id, 'Original request')
	await first
	owner.send(session.id, 'Held message')
	const settled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	await owner.cancel(session.id)
	await settled
	// A stopped reply parks what waited; nothing started on its own.
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(1)
	const next = permission()
	await owner.sendNow(session.id)
	await next
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(2)
})

it('send now refuses a message that already started or was removed', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const first = permission()
	owner.send(session.id, 'Original request')
	await first
	await expect(owner.sendNow(session.id, 'gone')).rejects.toThrow('already started or was removed')
})

it('rewrites a waiting message in place, and refuses one that already started', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const first = permission()
	owner.send(session.id, 'Original request')
	await first
	owner.send(session.id, 'One')
	owner.send(session.id, 'Two')
	const before = (await owner.openConversation(project.id, session.id)).thread?.queuedItems ?? []
	owner.updateQueued(session.id, before[0]?.id ?? '', 'One, changed')
	const after = (await owner.openConversation(project.id, session.id)).thread?.queuedItems ?? []
	expect(after.map((item) => [item.id, item.prompt])).toEqual([
		[before[0]?.id, 'One, changed'],
		[before[1]?.id, 'Two'],
	])
	expect(() => owner.updateQueued(session.id, before[0]?.id ?? '', '  ')).toThrow('Enter a message')
	expect(() => owner.updateQueued(session.id, 'gone', 'x')).toThrow(
		'already started or was removed',
	)
})
