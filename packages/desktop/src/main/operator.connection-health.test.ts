import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
const folders: string[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function harness(options: { autoReconnect?: boolean } = {}) {
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
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		options,
	)
	operators.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const found = recorded.find(predicate)
			if (found) return resolve(found)
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					events.off('update', receive)
					resolve(event)
				}
			}
			events.on('update', receive)
		})
	return { owner, recorded, wait }
}
function projectFolder(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-folder-'))
	folders.push(root)
	const folder = join(root, 'my project')
	mkdirSync(folder)
	return realpathSync(folder)
}

it('says a deleted folder is gone instead of asking to trust it, and recovers when it returns', async () => {
	const { owner, wait } = harness()
	const folder = projectFolder()
	const project = await owner.openProject(folder)
	const session = await owner.newConversation(project.id)
	rmSync(folder, { recursive: true })

	const failed = wait(
		(event) =>
			event.kind === 'connection' && event.project.id === project.id && !!event.project.missing,
	)
	expect(() => owner.send(session.id, 'Hello after delete')).toThrow(
		`This folder no longer exists: ${folder}`,
	)
	const event = await failed
	expect(event.kind === 'connection' && event.project).toMatchObject({
		status: 'error',
		missing: true,
		error: `This folder no longer exists: ${folder}`,
	})
	// Never the trust wording, and not a thrown ENOENT either.
	const again = await owner.reconnect(project.id)
	expect(again).toMatchObject({ status: 'error', missing: true })
	expect(again.error).not.toMatch(/trust|ENOENT/i)

	mkdirSync(folder)
	const back = await owner.reconnect(project.id)
	expect(back.status).toBe('ready')
	expect(back.missing).toBeUndefined()
})

it('keeps the conversation and offers Reconnect when the host drops and nobody reconnects it', async () => {
	const { owner, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const dropped = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(session.id, 'Break connection')
	const event = await dropped
	expect(event.kind === 'connection' && event.project).toMatchObject({ lost: true })
	expect(event.kind === 'connection' && event.project.reconnecting).toBeUndefined()
	expect(owner.listProjects().find((item) => item.id === project.id)).toMatchObject({
		lost: true,
	})
	const back = await owner.reconnect(project.id)
	expect(back).toMatchObject({ status: 'ready' })
	expect(back.lost).toBeUndefined()
})

it('reconnects by itself once, then clears the line that said the connection was lost', async () => {
	const { owner, recorded, wait } = harness({ autoReconnect: true })
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const cleared = wait(
		(event) =>
			event.kind === 'state' && event.sessionId === session.id && event.clearError === true,
	)
	owner.send(session.id, 'Break connection')
	await cleared

	const connections = recorded.flatMap((event) =>
		event.kind === 'connection' && event.project.id === project.id ? [event.project] : [],
	)
	// Lost, then trying again, then back with nothing left over.
	const kinds = connections.map((view) =>
		view.status === 'ready' ? 'ready' : view.reconnecting ? 'reconnecting' : 'lost',
	)
	expect(kinds).toContain('lost')
	expect(kinds).toContain('reconnecting')
	expect(kinds.at(-1)).toBe('ready')
	expect(connections.at(-1)?.lost).toBeUndefined()
	// The turn that was cut short did say why while the connection was down.
	expect(
		recorded.some(
			(event) => event.kind === 'state' && event.sessionId === session.id && Boolean(event.error),
		),
	).toBe(true)
})
