import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { DesktopConversationStore } from './desktop-conversation-store.js'
import { Operator } from './operator.js'
import { RuntimeClient } from './rpc-client.js'

const owners: Operator[] = []
const directories: string[] = []
const runtimeRequest = RuntimeClient.prototype.request
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
	vi.restoreAllMocks()
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
function harness(
	intercept?: (method: string, params: unknown) => Promise<unknown> | undefined,
	directory?: string,
) {
	const requests: { method: string; params: unknown }[] = []
	const events = new EventEmitter()
	let client!: RuntimeClient
	vi.spyOn(RuntimeClient.prototype, 'supportsTurnRetry').mockReturnValue(true)
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		client = this
		requests.push({ method, params })
		return intercept?.(method, params) ?? runtimeRequest.call(this, method, params, timeout)
	})
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-tasks-process.mjs', import.meta.url))],
		},
		(event) => events.emit('event', event),
		directory,
	)
	owners.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean) =>
		new Promise<DesktopEvent>((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					events.off('event', receive)
					resolve(event)
				}
			}
			events.on('event', receive)
		})
	return {
		owner,
		requests,
		wait,
		client: () => client,
		count: (method: string) => requests.filter((request) => request.method === method).length,
	}
}
const task = {
	taskId: 'retained',
	subject: 'Keep progress',
	status: 'failed',
	blockedBy: [],
}

it('reuses an indexed Recent’s display metadata while requiring fresh strict history admission', async () => {
	let denied = true
	const { owner, count } = harness((method) => {
		if (method === 'namzu/conversations/history' && denied)
			return Promise.reject(new Error('Conversation is outside this scope'))
	})
	const project = await owner.openProject(process.cwd())
	expect(await owner.listConversations(project.id)).toContainEqual(
		expect.objectContaining({ id: 'cold-session' }),
	)
	await expect(owner.openConversation(project.id, 'cold-session')).rejects.toThrow(
		'outside this scope',
	)
	expect(count('namzu/conversations/list')).toBe(1)
	expect(() => owner.draft('cold-session')).toThrow('Open this conversation first')
	denied = false
	expect((await owner.openConversation(project.id, 'cold-session')).messages).toEqual([
		{ role: 'user', text: 'Existing plan' },
	])
	expect(count('namzu/conversations/list')).toBe(1)
	expect(count('namzu/conversations/history')).toBe(2)
	expect(count('session/load')).toBe(0)
})

it('refuses a late catalogue from a replaced connection before caching its display metadata', async () => {
	const entered = deferred<void>()
	const rows = deferred<unknown>()
	let first = true
	const { owner, client, count, wait } = harness((method) => {
		if (method === 'namzu/conversations/list' && first) {
			first = false
			entered.resolve()
			return rows.promise
		}
	})
	try {
		const project = await owner.openProject(process.cwd())
		const listing = owner.listConversations(project.id)
		const refused = expect(listing).rejects.toThrow('settings changed')
		await entered.promise
		const closed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
		await expect(client().request('test/exit')).rejects.toThrow('connection closed')
		await closed
		await owner.reconnect(project.id)
		rows.resolve([{ id: 'cold-session', title: 'Obsolete catalogue', updatedAt: '2026-10-06' }])
		await refused
		expect((await owner.openConversation(project.id, 'cold-session')).messages).toEqual([
			{ role: 'user', text: 'Existing plan' },
		])
		expect(count('namzu/conversations/list')).toBe(2)
		expect(count('namzu/conversations/history')).toBe(1)
	} finally {
		rows.resolve([])
	}
})

async function savedConversation(hasPrompted = true) {
	const directory = await mkdtemp(join(tmpdir(), 'namzu-recents-restored-'))
	directories.push(directory)
	new DesktopConversationStore(directory).write({
		version: 1,
		projects: [{ id: 'saved-project', path: process.cwd() }],
		conversations: [
			{
				view: {
					id: 'saved-ui',
					projectId: 'saved-project',
					title: 'Saved conversation',
					updatedAt: '2026-10-06T00:00:00.000Z',
				},
				runtimeSessionId: 'cold-session',
				hasPrompted,
				draft: 'Saved authored draft',
				...(!hasPrompted
					? {
							draftSettings: { choice: { provider: 'fixture', model: 'exact-saved-model' } },
						}
					: {}),
			},
		],
		projectDrafts: [],
		attachments: [],
	})
	return directory
}

it('displays an unsent draft while replacement and exact model restoration are still pending', async () => {
	const replacementEntered = deferred<void>()
	const replacement = deferred<unknown>()
	const selectionEntered = deferred<void>()
	const selected = deferred<unknown>()
	const { owner, count, requests } = harness(
		(method) => {
			if (method === 'session/new') {
				replacementEntered.resolve()
				return replacement.promise
			}
			if (method === 'namzu/providers/select') {
				selectionEntered.resolve()
				return selected.promise
			}
			if (method === 'namzu/providers/status')
				return Promise.resolve({
					available: [],
					selected: { id: 'fixture', model: 'exact-saved-model' },
				})
		},
		await savedConversation(false),
	)
	try {
		const project = await owner.openProject(process.cwd())
		expect(await owner.openConversation(project.id, 'saved-ui')).toMatchObject({ messages: [] })
		expect(count('session/new')).toBe(0)
		expect(owner.draft('saved-ui')).toBe('Saved authored draft')
		const readiness = owner.readyConversation(project.id, 'saved-ui')
		const providers = owner.providers(project.id, 'saved-ui')
		await replacementEntered.promise
		expect((await owner.openConversation(project.id, 'saved-ui')).messages).toEqual([])
		expect(count('session/new')).toBe(1)
		expect(count('namzu/providers/status')).toBe(0)
		replacement.resolve({ sessionId: 'replacement-slot' })
		await selectionEntered.promise
		expect(requests.find((request) => request.method === 'namzu/providers/select')?.params).toEqual(
			{
				sessionId: 'replacement-slot',
				provider: 'fixture',
				model: 'exact-saved-model',
			},
		)
		expect(count('namzu/tasks/list')).toBe(0)
		expect(count('namzu/providers/status')).toBe(0)
		expect((await owner.openConversation(project.id, 'saved-ui')).messages).toEqual([])
		selected.resolve({ selected: true })
		const [status] = await Promise.all([providers, readiness])
		expect(status.selected).toEqual({ id: 'fixture', model: 'exact-saved-model' })
		expect(count('session/new')).toBe(1)
		expect(count('namzu/providers/select')).toBe(1)
		expect(count('session/load')).toBe(0)
		expect(count('namzu/conversations/history')).toBe(0)
		expect(count('session/prompt')).toBe(0)
		expect(owner.draft('saved-ui')).toBe('Saved authored draft')
		expect(owner.draftSettings('saved-ui').choice?.model).toBe('exact-saved-model')
	} finally {
		replacement.resolve({ sessionId: 'replacement-slot' })
		selected.resolve({ selected: true })
	}
})

it('shows persisted history before runtime load, sharing one history read with concurrent admission', async () => {
	const historyEntered = deferred<void>()
	const history = deferred<unknown>()
	const loadEntered = deferred<void>()
	const loaded = deferred<unknown>()
	const { owner, count } = harness(
		(method) => {
			if (method === 'namzu/conversations/history') {
				historyEntered.resolve()
				return history.promise
			}
			if (method === 'session/load') {
				loadEntered.resolve()
				return loaded.promise
			}
		},
		await savedConversation(),
	)
	try {
		const project = await owner.openProject(process.cwd())
		const opening = owner.openConversation(project.id, 'saved-ui')
		await historyEntered.promise
		const providers = owner.providers(project.id, 'saved-ui')
		const readiness = owner.readyConversation(project.id, 'saved-ui')
		expect(count('namzu/conversations/history')).toBe(1)
		expect(count('session/load')).toBe(0)
		history.resolve({
			messages: [{ role: 'user', text: 'Saved exact history' }],
			partial: false,
		})
		const shown = await opening
		expect(shown.messages).toEqual([{ role: 'user', text: 'Saved exact history' }])
		await loadEntered.promise
		expect((await owner.openConversation(project.id, 'saved-ui')).messages).toEqual(shown.messages)
		expect(count('session/load')).toBe(1)
		expect(count('namzu/tasks/list')).toBe(0)
		expect(owner.draft('saved-ui')).toBe('Saved authored draft')
		loaded.resolve({ sessionId: 'cold-session' })
		await Promise.all([providers, readiness])
		expect(count('namzu/conversations/history')).toBe(1)
		expect(count('session/load')).toBe(1)
		expect(count('session/prompt')).toBe(0)
	} finally {
		history.resolve({ messages: [], partial: false })
		loaded.resolve({ sessionId: 'cold-session' })
	}
})

it('keeps restored drafts after failed history and rejects history from a replaced connection', async () => {
	const entered = deferred<void>()
	const history = deferred<unknown>()
	let attempt = 0
	const { owner, client, count, wait } = harness(
		(method) => {
			if (method !== 'namzu/conversations/history') return
			if (++attempt === 1) return Promise.reject(new Error('History read failed'))
			if (attempt === 2) {
				entered.resolve()
				return history.promise
			}
		},
		await savedConversation(),
	)
	try {
		const project = await owner.openProject(process.cwd())
		await expect(owner.openConversation(project.id, 'saved-ui')).rejects.toThrow(
			'History read failed',
		)
		expect(owner.draft('saved-ui')).toBe('Saved authored draft')
		const opening = owner.openConversation(project.id, 'saved-ui')
		const refused = expect(opening).rejects.toThrow('settings changed')
		await entered.promise
		const closed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
		await expect(client().request('test/exit')).rejects.toThrow('connection closed')
		await closed
		await owner.reconnect(project.id)
		history.resolve({
			messages: [{ role: 'assistant', text: 'Old connection' }],
			partial: false,
		})
		await refused
		expect((await owner.openConversation(project.id, 'saved-ui')).messages).toEqual([
			{ role: 'user', text: 'Existing plan' },
		])
		expect(count('namzu/conversations/history')).toBe(3)
		expect(count('session/load')).toBe(0)
		expect(owner.draft('saved-ui')).toBe('Saved authored draft')
	} finally {
		history.resolve({ messages: [], partial: false })
	}
})

it('returns admitted cold history before status reads and coalesces concurrent readiness with parallel task and retry reads', async () => {
	const tasks = deferred<unknown>()
	const retry = deferred<unknown>()
	const entered = deferred<void>()
	let reads = 0
	const { owner, count } = harness((method) => {
		if (method !== 'namzu/tasks/list' && method !== 'namzu/sessions/retry-status') return
		if (++reads === 2) entered.resolve()
		return method === 'namzu/tasks/list' ? tasks.promise : retry.promise
	})
	try {
		const project = await owner.openProject(process.cwd())
		const shown = await owner.openConversation(project.id, 'cold-session')
		expect(shown.messages).toEqual([{ role: 'user', text: 'Existing plan' }])
		expect(count('session/load')).toBe(0)
		expect(reads).toBe(0)
		const first = owner.readyConversation(project.id, 'cold-session')
		const second = owner.readyConversation(project.id, 'cold-session')
		await entered.promise
		expect(count('session/load')).toBe(1)
		expect(count('namzu/tasks/list')).toBe(1)
		expect(count('namzu/sessions/retry-status')).toBe(1)
		retry.resolve({
			retry: { turnId: 'retained-turn', checkpointId: 'retained-checkpoint' },
		})
		tasks.resolve({ tasks: [task] })
		await Promise.all([first, second])
		expect((await owner.openConversation(project.id, 'cold-session')).thread).toMatchObject({
			tasks: [task],
			retry: { turnId: 'retained-turn', checkpointId: 'retained-checkpoint' },
		})
		expect(count('session/prompt')).toBe(0)
	} finally {
		tasks.resolve({ tasks: [] })
		retry.resolve({})
	}
})

it('reuses warm live history without disk RPCs and retains drafts, model settings, attachments and failed progress', async () => {
	const { owner, requests } = harness()
	const project = await owner.openProject(process.cwd())
	await owner.openConversation(project.id, 'cold-session')
	await owner.readyConversation(project.id, 'cold-session')
	owner.saveDraft('cold-session', 'Unsent authored text')
	const settings = {
		choice: { provider: 'fixture', model: 'selected-model' },
		options: { effort: 'high' as const, permissionMode: 'plan' as const },
	}
	owner.saveDraftSettings('cold-session', settings)
	const files = await owner.addAttachments('cold-session', [
		{ name: 'notes.txt', bytes: Buffer.from('Keep attachment') },
	])
	const before = requests.length
	const first = await owner.openConversation(project.id, 'cold-session')
	const second = await owner.openConversation(project.id, 'cold-session')
	const third = await owner.openConversation(project.id, 'cold-session')
	for (const shown of [first, second, third]) {
		expect(shown.messages).toEqual([{ role: 'user', text: 'Existing plan' }])
		expect(shown.thread?.tasks).toContainEqual(expect.objectContaining({ status: 'failed' }))
	}
	expect(requests).toHaveLength(before)
	expect(owner.draft('cold-session')).toBe('Unsent authored text')
	expect(owner.draftSettings('cold-session')).toEqual(settings)
	expect(owner.attachments('cold-session')).toEqual(files)
})

it('publishes owned history before context load and coalesces readiness and provider admission behind one load', async () => {
	const entered = deferred<void>()
	const loaded = deferred<unknown>()
	const { owner, count } = harness((method) => {
		if (method === 'session/load') {
			entered.resolve()
			return loaded.promise
		}
	})
	try {
		const project = await owner.openProject(process.cwd())
		const shown = await owner.openConversation(project.id, 'cold-session')
		expect(shown.messages).toEqual([{ role: 'user', text: 'Existing plan' }])
		expect(count('session/load')).toBe(0)
		owner.saveDraft('cold-session', 'Registered authored draft')
		const readiness = owner.readyConversation(project.id, 'cold-session')
		const providers = owner.providers(project.id, 'cold-session')
		await entered.promise
		expect(count('namzu/conversations/list')).toBe(1)
		expect(count('namzu/conversations/history')).toBe(1)
		expect(count('session/load')).toBe(1)
		expect(count('namzu/tasks/list')).toBe(0)
		expect(count('namzu/sessions/retry-status')).toBe(0)
		expect(count('namzu/providers/status')).toBe(0)
		loaded.resolve({ sessionId: 'cold-session' })
		await Promise.all([readiness, providers])
		expect(count('session/load')).toBe(1)
		expect(count('namzu/conversations/history')).toBe(1)
		expect(count('namzu/providers/status')).toBe(1)
		expect(owner.draft('cold-session')).toBe('Registered authored draft')
	} finally {
		loaded.resolve({ sessionId: 'cold-session' })
	}
})

it('does not register blank history after a failed first read and rereads exact messages on retry', async () => {
	let fail = true
	const { owner, count } = harness((method) => {
		if (method === 'namzu/conversations/history' && fail)
			return Promise.reject(new Error('History could not be read'))
	})
	const project = await owner.openProject(process.cwd())
	await expect(owner.openConversation(project.id, 'cold-session')).rejects.toThrow(
		'History could not be read',
	)
	await expect(owner.readyConversation(project.id, 'cold-session')).rejects.toThrow(
		'Open this conversation first',
	)
	expect(() => owner.draft('cold-session')).toThrow('Open this conversation first')
	fail = false
	const shown = await owner.openConversation(project.id, 'cold-session')
	expect(shown.messages).toEqual([{ role: 'user', text: 'Existing plan' }])
	expect(shown.thread?.messages).toEqual([{ role: 'user', text: 'Existing plan' }])
	expect(count('namzu/conversations/history')).toBe(2)
	expect(count('session/load')).toBe(0)
	await owner.readyConversation(project.id, 'cold-session')
	expect(count('session/load')).toBe(1)
})

it('does not register cold history from an old client after reconnect and rereads on the owned connection', async () => {
	const entered = deferred<void>()
	const history = deferred<unknown>()
	let first = true
	const { owner, client, count, wait } = harness((method) => {
		if (method === 'namzu/conversations/history' && first) {
			first = false
			entered.resolve()
			return history.promise
		}
	})
	try {
		const project = await owner.openProject(process.cwd())
		const opening = owner.openConversation(project.id, 'cold-session')
		const refused = expect(opening).rejects.toThrow('settings changed')
		await entered.promise
		const closed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
		await expect(client().request('test/exit')).rejects.toThrow('connection closed')
		await closed
		await owner.reconnect(project.id)
		history.resolve({
			messages: [{ role: 'assistant', text: 'Stale client text' }],
			partial: false,
		})
		await refused
		expect(() => owner.draft('cold-session')).toThrow('Open this conversation first')
		expect((await owner.openConversation(project.id, 'cold-session')).messages).toEqual([
			{ role: 'user', text: 'Existing plan' },
		])
		expect(count('namzu/conversations/history')).toBe(2)
		expect(count('session/load')).toBe(0)
	} finally {
		history.resolve({ messages: [], partial: false })
	}
})

it('keeps display and authored state after failed readiness and makes a fresh retry read on the next attempt', async () => {
	let fail = true
	const { owner, count } = harness((method) => {
		if (method === 'namzu/sessions/retry-status')
			return fail ? Promise.reject(new Error('Retry state unavailable')) : Promise.resolve({})
	})
	const project = await owner.openProject(process.cwd())
	await owner.openConversation(project.id, 'cold-session')
	owner.saveDraft('cold-session', 'Do not consume this draft')
	await expect(owner.readyConversation(project.id, 'cold-session')).rejects.toThrow(
		'Retry state unavailable',
	)
	const shown = await owner.openConversation(project.id, 'cold-session')
	expect(shown.messages).toEqual([{ role: 'user', text: 'Existing plan' }])
	expect(owner.draft('cold-session')).toBe('Do not consume this draft')
	fail = false
	await owner.readyConversation(project.id, 'cold-session')
	expect(count('namzu/sessions/retry-status')).toBe(2)
	expect(count('session/prompt')).toBe(0)
})

it('does not reuse successful display readiness to authorize a later send', async () => {
	let reads = 0
	const { owner, count } = harness((method) => {
		if (method === 'namzu/sessions/retry-status')
			return Promise.resolve(++reads === 1 ? {} : { notice: 'External paused turn retained.' })
	})
	const project = await owner.openProject(process.cwd())
	await owner.openConversation(project.id, 'cold-session')
	await owner.readyConversation(project.id, 'cold-session')
	owner.saveDraft('cold-session', 'Keep my draft')
	await expect(owner.send('cold-session', 'Keep my draft')).rejects.toThrow(
		'External paused turn retained',
	)
	expect(count('namzu/sessions/retry-status')).toBe(2)
	expect(count('session/prompt')).toBe(0)
	expect(owner.draft('cold-session')).toBe('Keep my draft')
})

it('does not start display readiness reads during admission or an active permission turn', async () => {
	const entered = deferred<void>()
	const retry = deferred<unknown>()
	let first = true
	const { owner, count, wait } = harness((method) => {
		if (method === 'namzu/sessions/retry-status' && first) {
			first = false
			entered.resolve()
			return retry.promise
		}
	})
	try {
		const project = await owner.openProject(process.cwd())
		await owner.openConversation(project.id, 'cold-session')
		const permission = wait((event) => event.kind === 'permission')
		const admission = owner.send('cold-session', 'Watch')
		await entered.promise
		await owner.readyConversation(project.id, 'cold-session')
		expect(count('namzu/tasks/list')).toBe(0)
		expect(count('namzu/sessions/retry-status')).toBe(1)
		retry.resolve({})
		await admission
		await permission
		const taskReads = count('namzu/tasks/list')
		await owner.readyConversation(project.id, 'cold-session')
		expect(count('namzu/tasks/list')).toBe(taskReads)
		expect(count('namzu/sessions/retry-status')).toBe(1)
		const stopped = wait((event) => event.kind === 'state' && !event.running)
		await owner.cancel('cold-session')
		await stopped
	} finally {
		retry.resolve({})
	}
})

it('does not grant readiness for an unknown conversation or another project’s stable identity', async () => {
	const { owner, requests } = harness()
	const project = await owner.openProject(process.cwd())
	await expect(owner.openConversation(project.id, 'unknown')).rejects.toThrow(
		'no longer in this project',
	)
	await expect(owner.readyConversation(project.id, 'unknown')).rejects.toThrow(
		'Open this conversation first',
	)
	await owner.openConversation(project.id, 'cold-session')
	const other = await owner.openProject(fileURLToPath(new URL('.', import.meta.url)))
	const before = requests.length
	await expect(owner.readyConversation(other.id, 'cold-session')).rejects.toThrow(
		'belongs to another project',
	)
	expect(requests).toHaveLength(before)
})

it('refuses a delayed readiness acknowledgement after the owned connection closes while retaining readable history', async () => {
	const entered = deferred<void>()
	const retry = deferred<unknown>()
	const { owner, client, wait } = harness((method) => {
		if (method === 'namzu/sessions/retry-status') {
			entered.resolve()
			return retry.promise
		}
	})
	try {
		const project = await owner.openProject(process.cwd())
		await owner.openConversation(project.id, 'cold-session')
		const readiness = owner.readyConversation(project.id, 'cold-session')
		const refused = expect(readiness).rejects.toThrow('connection changed')
		await entered.promise
		const closed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
		await expect(client().request('test/exit')).rejects.toThrow('connection closed')
		await closed
		retry.resolve({
			retry: { turnId: 'stale-turn', checkpointId: 'stale-checkpoint' },
		})
		await refused
		const shown = await owner.openConversation(project.id, 'cold-session')
		expect(shown.messages).toEqual([{ role: 'user', text: 'Existing plan' }])
		expect(shown.thread?.retry).toBeUndefined()
	} finally {
		retry.resolve({})
	}
})
