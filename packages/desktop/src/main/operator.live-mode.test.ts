/**
 * Switching the mode of a conversation that is already working.
 *
 * Ask first, then Full access: the turn that is running, the card on screen and the messages
 * waiting all had to follow, and a mode the engine refuses must not stay in the menu. The engine
 * is the fixture process; every wait is an event or an answer, never a clock.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
})

const REFUSAL =
	'The mode that skips every question is off. Turn on Allow bypass permissions mode in Settings first.'

function harness(env: NodeJS.ProcessEnv = {}) {
	const events = new EventEmitter()
	const log = join(mkdtempSync(join(tmpdir(), 'namzu-live-mode-')), 'requests.jsonl')
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_REQUEST_LOG: log, ...env },
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
	const modeRequests = () => {
		try {
			return readFileSync(log, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
				.filter((entry) => entry.method === 'namzu/session/set-permission-mode')
		} catch {
			return []
		}
	}
	return { owner, wait, permission, modeRequests }
}

async function working(env: NodeJS.ProcessEnv = { FIXTURE_LIVE_MODE: '1' }) {
	const f = harness(env)
	const project = await f.owner.openProject(process.cwd())
	const session = await f.owner.newConversation(project.id)
	const asked = f.permission()
	void f.owner.send(session.id, 'Run the checks')
	const review = await asked
	return { ...f, project, session, review }
}

it('tells the running engine at once and answers the open card Full access would never have shown', async () => {
	const { owner, wait, session, review, modeRequests } = await working()
	const cleared = wait((event) => event.kind === 'permission-cleared')
	const ended = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)

	const result = await owner.saveDraftSettings(session.id, {
		options: { permissionMode: 'bypass' },
	})

	expect(result).toBeUndefined()
	expect(modeRequests()).toHaveLength(1)
	expect(modeRequests()[0]?.params).toMatchObject({ mode: 'bypass' })
	expect(owner.draftSettings(session.id).options?.permissionMode).toBe('bypass')
	await cleared
	await ended
	// The fixture answers an approved call with this text: the card was approved, not dropped.
	expect(
		(await owner.openConversation(review.projectId, session.id)).thread?.messages.at(-1),
	).toMatchObject({ role: 'assistant', text: 'Approved answer' })
})

it('leaves a card open that no mode settles, such as a rule that asks', async () => {
	const { owner, session, review, modeRequests } = await working({
		FIXTURE_LIVE_MODE: '1',
		FIXTURE_ALWAYS_ASK: '1',
	})

	await owner.saveDraftSettings(session.id, { options: { permissionMode: 'bypass' } })

	expect(modeRequests()).toHaveLength(1)
	// Still pending: answering it works, which it would not had the switch approved it.
	expect(() => owner.respondPermission(session.id, review.id, { outcome: 'approve' })).not.toThrow()
})

it('does not show a mode the engine refused, and says why', async () => {
	const { owner, session, review } = await working({
		FIXTURE_LIVE_MODE: '1',
		FIXTURE_LIVE_MODE_REFUSE: REFUSAL,
	})
	await owner.saveDraftSettings(session.id, { options: { permissionMode: 'accept-edits' } })

	const result = await owner.saveDraftSettings(session.id, {
		options: { permissionMode: 'bypass' },
	})

	expect(result).toEqual({ permissionModeRefused: REFUSAL })
	expect(owner.draftSettings(session.id).options?.permissionMode).toBe('accept-edits')
	expect(() => owner.respondPermission(session.id, review.id, { outcome: 'approve' })).not.toThrow()
})

it('makes a message waiting in the queue follow the new mode', async () => {
	const { owner, wait, session } = await working()
	const queued = wait(
		(event) =>
			event.kind === 'state' && event.sessionId === session.id && !!event.queuedItems?.length,
	)
	await owner.send(session.id, 'And then this', { permissionMode: 'prompt' })
	const waiting = await queued
	expect(
		waiting.kind === 'state' && waiting.queuedItems?.map((item) => item.permissionMode),
	).toEqual(['prompt'])

	// The window hears the queue as the switch leaves it, before the open card is answered.
	const heard = wait(
		(event) =>
			event.kind === 'state' && event.sessionId === session.id && !!event.queuedItems?.length,
	)
	await owner.saveDraftSettings(session.id, { options: { permissionMode: 'bypass' } })

	const event = await heard
	expect(event.kind === 'state' && event.queuedItems?.map((item) => item.permissionMode)).toEqual([
		'bypass',
	])
})

it('sends nothing to the engine when no turn is running, and when it cannot take a change', async () => {
	const idle = harness({ FIXTURE_LIVE_MODE: '1' })
	const project = await idle.owner.openProject(process.cwd())
	const session = await idle.owner.newConversation(project.id)
	await idle.owner.saveDraftSettings(session.id, { options: { permissionMode: 'bypass' } })
	expect(idle.modeRequests()).toHaveLength(0)
	expect(idle.owner.draftSettings(session.id).options?.permissionMode).toBe('bypass')

	// An engine that does not offer the method keeps the old behaviour: the next message carries it.
	const older = await working({})
	const result = await older.owner.saveDraftSettings(older.session.id, {
		options: { permissionMode: 'bypass' },
	})
	expect(result).toBeUndefined()
	expect(older.modeRequests()).toHaveLength(0)
	expect(older.owner.draftSettings(older.session.id).options?.permissionMode).toBe('bypass')
})
