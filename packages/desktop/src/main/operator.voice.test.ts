import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
	for (const directory of directories.splice(0)) {
		for (const name of ['delivery', 'mode']) {
			const path = join(directory, name)
			if (existsSync(path)) unlinkSync(path)
		}
		rmdirSync(directory)
	}
})

function harness() {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-voice-'))
	directories.push(directory)
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: {
				...process.env,
				FIXTURE_LIVE_INPUT: '1',
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
	return { owner, recorded, wait, permission }
}

it('starts a new turn when idle, as the composer does, using the saved model choice', async () => {
	const { owner, recorded } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	owner.saveDraftSettings(session.id, {
		choice: { provider: 'namzu', model: 'fixture-model' },
		options: { permissionMode: 'prompt' },
	})
	const select = vi.spyOn(owner, 'selectProvider').mockResolvedValue(undefined)
	expect(owner.voiceActivity(session.id)).toEqual({ running: false, waitingOnPerson: false })
	const sent = vi.spyOn(owner, 'sendCurrent')
	await owner.sendSpoken(session.id, 'Merhaba, nasılsın')
	expect(select).toHaveBeenCalledWith(session.id, 'namzu', 'fixture-model')
	expect(sent).toHaveBeenCalledWith(session.id, 'Merhaba, nasılsın', { permissionMode: 'prompt' })
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(1)
	expect(owner.voiceActivity(session.id).running).toBe(true)
})

it('goes to current-turn input while a reply runs and never reselects the model', async () => {
	const { owner, recorded, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	owner.saveDraftSettings(session.id, { choice: { provider: 'namzu', model: 'fixture-model' } })
	const review = permission()
	owner.send(session.id, 'Original request')
	const pending = await review
	const select = vi.spyOn(owner, 'selectProvider')
	expect(owner.voiceActivity(session.id)).toEqual({ running: true, waitingOnPerson: true })
	await expect(owner.sendSpoken(session.id, 'Bir şey daha')).resolves.toBe('accepted')
	expect(select).not.toHaveBeenCalled()
	expect(
		recorded.filter((event) => event.kind === 'prompt' && event.sessionId === session.id),
	).toHaveLength(1)
	const settled = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	owner.respondPermission(session.id, pending.id, { outcome: 'approve' })
	expect(owner.voiceActivity(session.id).waitingOnPerson).toBe(false)
	await settled
})

it('refuses a conversation it does not have', () => {
	const { owner } = harness()
	expect(() => owner.voiceActivity('missing')).toThrow()
})
