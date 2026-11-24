import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
})

function harness(env?: NodeJS.ProcessEnv) {
	const events = new EventEmitter()
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			...(env ? { env: { ...process.env, ...env } } : {}),
		},
		(event) => events.emit('update', event),
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
	return { owner, permission, wait, events }
}

it('passes a valid preview to the window and answers a reject with the written note', async () => {
	const preview = { path: '/work/a.ts', before: 'one\n', after: 'two\n' }
	const { owner, permission, wait } = harness({ FIXTURE_PREVIEW: JSON.stringify(preview) })
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Change it')
	const review = await asked
	expect(review.calls[0]?.preview).toEqual(preview)
	const ended = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, review.id, {
		outcome: 'reject',
		feedback: 'The user declined this change and said: use tabs',
	})
	await ended
	// The fixture echoes the note as the assistant's reply, so the round trip reached the wire.
	expect(
		(await owner.openConversation(project.id, session.id)).thread?.messages.at(-1),
	).toMatchObject({
		role: 'assistant',
		text: 'Declined: The user declined this change and said: use tabs',
	})
})

it('carries the agent’s always-ask mark to the window, and sends none for an ordinary call', async () => {
	for (const [env, marked] of [
		[{ FIXTURE_ALWAYS_ASK: '1' }, true],
		[undefined, false],
	] as const) {
		const { owner, permission } = harness(env)
		const project = await owner.openProject(process.cwd())
		const session = await owner.newConversation(project.id)
		const asked = permission()
		owner.send(session.id, 'Change it')
		const review = await asked
		expect(review.calls[0]?.alwaysAsk).toBe(marked ? true : undefined)
		owner.respondPermission(session.id, review.id, { outcome: 'approve' })
	}
})

it('drops a malformed preview instead of showing it, and refuses an over-long or misplaced note', async () => {
	const { owner, permission } = harness({
		FIXTURE_PREVIEW: JSON.stringify({ path: '/work/a.ts', before: 7, after: 'two' }),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Change it')
	const review = await asked
	expect(review.calls[0]?.preview).toBeUndefined()
	expect(() =>
		owner.respondPermission(session.id, review.id, {
			outcome: 'reject',
			feedback: 'x'.repeat(4001),
		}),
	).toThrow('under 4,000')
	expect(() =>
		owner.respondPermission(session.id, review.id, {
			outcome: 'approve',
			feedback: 'sneaky',
		} as never),
	).toThrow('Invalid approval')
	// Neither refusal consumed the request: it is still answerable.
	owner.respondPermission(session.id, review.id, { outcome: 'approve' })
})

it('forwards allow for this conversation to the agent as its own outcome', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Change it')
	const review = await asked
	const ended = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, review.id, { outcome: 'approve_all' })
	await ended
	// The fixture echoes the outcome it received, so a collapse into a plain approve would read differently.
	expect(
		(await owner.openConversation(project.id, session.id)).thread?.messages.at(-1),
	).toMatchObject({ role: 'assistant', text: 'Approved for the conversation' })
	// The request is answered once: a second answer finds nothing pending.
	expect(() => owner.respondPermission(session.id, review.id, { outcome: 'approve' })).toThrow(
		'no longer pending',
	)
})

it('refuses a note on allow for this conversation without consuming the request', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Change it')
	const review = await asked
	expect(() =>
		owner.respondPermission(session.id, review.id, {
			outcome: 'approve_all',
			feedback: 'sneaky',
		} as never),
	).toThrow('Invalid approval')
	owner.respondPermission(session.id, review.id, { outcome: 'approve_all' })
})

const computerCall = (extra: Record<string, unknown> = {}) => ({
	computer: { app: 'Notepad' },
	...extra,
})

it('asks once about an application, keeps the yes for the conversation, and answers its later actions itself', async () => {
	const { owner, permission, wait, events } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([computerCall()]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Open Notepad')
	const review = await asked
	// A question about the application, not about one click.
	expect(review.appRequest).toEqual({ apps: ['Notepad'] })
	const ended = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, review.id, { outcome: 'approve_all' })
	await ended
	// The engine got one plain yes: its own "approve all" is never set by this question.
	expect(
		(await owner.openConversation(project.id, session.id)).thread?.messages.at(-1),
	).toMatchObject({ text: 'Approved answer' })
	expect(owner.computerApps(session.id)).toEqual({ granted: ['Notepad'], used: ['Notepad'] })

	// The next action in the same application raises no card at all.
	let cards = 0
	events.on('update', (event: DesktopEvent) => {
		if (event.kind === 'permission') cards++
	})
	const second = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.send(session.id, 'Type hello')
	await second
	expect(
		(await owner.openConversation(project.id, session.id)).thread?.messages.at(-1),
	).toMatchObject({ text: 'Approved answer' })
	expect(cards).toBe(0)
})

it('lists an application the person took back, and asks about it again', async () => {
	const { owner, permission, wait } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([computerCall()]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const first = permission()
	owner.send(session.id, 'Open Notepad')
	const review = await first
	owner.respondPermission(session.id, review.id, { outcome: 'approve_all' })
	await wait((event) => event.kind === 'state' && !event.running)
	expect(owner.revokeComputerApp(session.id, 'notepad').granted).toEqual([])
	const again = permission()
	owner.send(session.id, 'Type hello')
	expect((await again).appRequest).toEqual({ apps: ['Notepad'] })
	owner.respondPermission(session.id, (await again).id, { outcome: 'reject' })
})

it('answers Allow once for this action only and keeps nothing', async () => {
	const { owner, permission, wait } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([computerCall()]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Open Notepad')
	const review = await asked
	owner.respondPermission(session.id, review.id, { outcome: 'approve' })
	await wait((event) => event.kind === 'state' && !event.running)
	expect(owner.computerApps(session.id).granted).toEqual([])
})

it('tells the agent why an application was refused, and never grants it', async () => {
	const { owner, permission, wait } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([computerCall()]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Open Notepad')
	const review = await asked
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.respondPermission(session.id, review.id, { outcome: 'reject' })
	await ended
	expect(
		(await owner.openConversation(project.id, session.id)).thread?.messages.at(-1)?.text,
	).toContain('did not allow Namzu to use Notepad')
	expect(owner.computerApps(session.id).granted).toEqual([])
})

it('keeps the ordinary card for an action that closes or deletes, even in an allowed application', async () => {
	const { owner, permission, wait } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([
			computerCall({ computer: { app: 'Notepad', consequence: 'presses ALT+F4' } }),
		]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const first = permission()
	owner.send(session.id, 'Close it')
	const review = await first
	// Not an application question: it is about this action.
	expect(review.appRequest).toBeUndefined()
	expect(review.calls[0]?.computer?.consequence).toBe('presses ALT+F4')
	owner.respondPermission(session.id, review.id, { outcome: 'approve' })
	await wait((event) => event.kind === 'state' && !event.running)
})

it('never lets the agent into Namzu’s own window', async () => {
	const { owner, permission } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([computerCall({ computer: { app: 'Namzu' } })]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Click Accept')
	const review = await asked
	expect(review.appRequest).toBeUndefined()
	owner.respondPermission(session.id, review.id, { outcome: 'reject' })
	// Nothing about Namzu itself was granted or listed as an application the agent may drive.
	expect(owner.computerApps(session.id).granted).toEqual([])
})

const braveCall = (extra: Record<string, unknown> = {}) =>
	computerCall({ computer: { app: 'brave-browser', browserAsk: ['brave-browser'] }, ...extra })

it('asks once about a browser the engine will ask about, in the browser’s words, and its yes covers the conversation', async () => {
	const { owner, permission, wait, events } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([braveCall()]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Click in Brave')
	const review = await asked
	expect(review.appRequest).toEqual({ apps: ['Brave'], browser: true })
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.respondPermission(session.id, review.id, { outcome: 'approve_all' })
	await ended
	expect(owner.computerApps(session.id).granted).toEqual(['Brave'])
	// The next action in this browser raises no card of Desktop's.
	let cards = 0
	events.on('update', (event: DesktopEvent) => {
		if (event.kind === 'permission') cards++
	})
	const second = wait((event) => event.kind === 'state' && !event.running)
	owner.send(session.id, 'Click again')
	await second
	expect(cards).toBe(0)
})

it('tells the agent not now for a browser and grants nothing', async () => {
	const { owner, permission, wait } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([braveCall()]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Click in Brave')
	const review = await asked
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.respondPermission(session.id, review.id, { outcome: 'reject' })
	await ended
	expect(
		(await owner.openConversation(project.id, session.id)).thread?.messages.at(-1)?.text,
	).toContain('not now to clicking and typing in Brave')
	expect(owner.computerApps(session.id).granted).toEqual([])
})

it('keeps the ordinary card for a browser the engine will not ask about', async () => {
	const { owner, permission } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([computerCall({ computer: { app: 'brave-browser' } })]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Look at Brave')
	const review = await asked
	expect(review.appRequest).toEqual({ apps: ['Brave'] })
	owner.respondPermission(session.id, review.id, { outcome: 'reject' })
})

it('draws the engine’s browser question once, and a yes to it also allows the application', async () => {
	const { owner, permission, wait, events } = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([
			{ name: 'browser_window', input: { app: 'brave-browser' }, alwaysAsk: true },
		]),
	})
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = permission()
	owner.send(session.id, 'Click in Brave')
	const review = await asked
	expect(review.appRequest).toBeUndefined()
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.respondPermission(session.id, review.id, { outcome: 'approve' })
	await ended
	expect(owner.computerApps(session.id).granted).toEqual(['Brave'])
	// Asked again in the same conversation: the person's yes answers it, no second card.
	let cards = 0
	events.on('update', (event: DesktopEvent) => {
		if (event.kind === 'permission') cards++
	})
	const again = wait((event) => event.kind === 'state' && !event.running)
	owner.send(session.id, 'And again')
	await again
	expect(cards).toBe(0)
	// Taken back, it is asked again.
	owner.revokeComputerApp(session.id, 'Brave')
	const third = permission()
	owner.send(session.id, 'Once more')
	const card = await third
	expect(card.calls[0]?.name).toBe('browser_window')
	owner.respondPermission(session.id, card.id, { outcome: 'reject' })
})
