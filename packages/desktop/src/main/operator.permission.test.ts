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
	return { owner, permission, wait }
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
