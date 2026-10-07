import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'
import { RuntimeClient } from './rpc-client.js'

const owners: Operator[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	vi.restoreAllMocks()
})

function fixture() {
	const stream = new EventEmitter()
	const events: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		(event) => {
			events.push(event)
			stream.emit('event', event)
		},
	)
	owners.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (!predicate(event)) return
				stream.off('event', receive)
				resolve(event)
			}
			stream.on('event', receive)
		})
	return { owner, events, wait }
}

it('keeps ordinary background status in A while B is selected, then revokes it on engine change', async () => {
	const original = RuntimeClient.prototype.request
	const reads: string[] = []
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		if (method === 'namzu/jobs/list') {
			reads.push(String(params?.sessionId))
			return Promise.resolve([
				{
					id: 'job_1',
					command: 'PRIVATE COMMAND',
					status: 'running',
					startedAt: 1,
				},
			])
		}
		return original.call(this, method, params, timeout)
	})
	const { owner, events, wait } = fixture()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	owner.trackBackgroundWork(a.id)
	expect(reads).toEqual([])
	const permission = wait(
		(event) => event.kind === 'permission' && event.request.sessionId === a.id,
	)
	const status = wait(
		(event) => event.kind === 'background-work-status' && event.sessionId === a.id,
	)
	const settled = wait(
		(event) => event.kind === 'state' && event.sessionId === a.id && !event.running,
	)
	owner.send(a.id, 'First request')
	const review = await permission
	if (review.kind !== 'permission') throw new Error('Missing fixture review')
	owner.approve(a.id, review.request.id, true)
	const observed = await status
	if (observed.kind !== 'background-work-status') throw new Error('Missing status')
	expect(observed.status).toMatchObject({ state: 'known', runningCount: 1 })
	expect(JSON.stringify(observed)).not.toContain('PRIVATE COMMAND')
	await owner.openConversation(project.id, b.id)
	expect(owner.backgroundWorkStatuses()[a.id]).toMatchObject({ state: 'known', runningCount: 1 })
	// Background status can arrive before retry/task reconciliation releases this turn's admission.
	await settled
	const unavailable = wait(
		(event) =>
			event.kind === 'background-work-status' &&
			event.sessionId === a.id &&
			event.status.state === 'unavailable',
	)
	await owner.selectHarness(a.id, 'codex-cli')
	await unavailable
	expect(owner.backgroundWorkStatuses()[a.id]).toEqual({ state: 'unavailable' })
	expect(
		events.some((event) => event.kind === 'background-work-status' && event.sessionId === b.id),
	).toBe(false)
})
