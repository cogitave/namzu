import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent, PalView } from '../shared/protocol.js'

const transport = vi.hoisted(() => ({
	pal: undefined as PalView | undefined,
	pals: new Map<string, PalView>(),
	sessionIds: new Map<string, string>(),
	claims: new Map<string, string[]>(),
	calls: [] as { cwd: string; method: string; params: Record<string, unknown> }[],
	answers: [] as { cwd: string; id: string | number; result: unknown }[],
	clients: [] as { cwd: string; closed: boolean }[],
	instances: [] as { cwd: string; emit(event: string, value: unknown): boolean }[],
	startHook: undefined as ((cwd: string) => Promise<void>) | undefined,
	closeHook: undefined as ((cwd: string) => Promise<void>) | undefined,
	requestHook: undefined as
		| ((cwd: string, method: string, params: Record<string, unknown>) => Promise<unknown>)
		| undefined,
	claimFailure: false,
	screen: { source: 'data:image/png;base64,aGVsbG8=', width: 1280, height: 800 },
}))
vi.mock('./rpc-client.js', async () => {
	const { EventEmitter } = await import('node:events')
	return {
		RuntimeClient: class extends EventEmitter {
			readonly record: { cwd: string; closed: boolean }
			constructor(readonly cwd: string) {
				super()
				this.record = { cwd, closed: false }
				transport.clients.push(this.record)
				transport.instances.push(this)
			}
			async start() {
				await transport.startHook?.(this.cwd)
			}
			supportsPals() {
				return true
			}
			supportsPromptOptions() {
				return true
			}
			supportsPromptAttachments() {
				return true
			}
			async close() {
				await transport.closeHook?.(this.cwd)
				this.record.closed = true
			}
			answer(id: string | number, result: unknown) {
				transport.answers.push({ cwd: this.cwd, id, result })
			}
			async request(method: string, params: Record<string, unknown> = {}) {
				transport.calls.push({ cwd: this.cwd, method, params })
				const hooked = await transport.requestHook?.(this.cwd, method, params)
				if (hooked !== undefined) return hooked
				const pal = [...transport.pals.values()].find((item) => item.workspace === this.cwd)
				switch (method) {
					case 'namzu/pals/list':
						return [...transport.pals.values()]
					case 'namzu/pals/get':
						return transport.pals.get(params.id as string)
					case 'namzu/project/status':
						return { trusted: true, pal }
					case 'namzu/pals/conversations/list':
						return (transport.claims.get(this.cwd) ?? []).map((id) => ({
							id,
							title: 'New conversation',
							updatedAt: '2026-10-02T00:00:00Z',
						}))
					case 'namzu/conversations/history':
						return { messages: [], partial: false }
					case 'session/new':
						return { sessionId: transport.sessionIds.get(this.cwd) ?? 'claimed-fixture-session' }
					case 'namzu/pals/conversations/claim':
						if (transport.claimFailure) throw new Error('Claim rejected')
						transport.claims.set(this.cwd, [
							...(transport.claims.get(this.cwd) ?? []),
							params.sessionId as string,
						])
						return { sessionId: params.sessionId, palId: pal?.id, revision: pal?.revision }
					case 'namzu/pals/update': {
						const current = transport.pals.get(params.id as string)
						if (!current) throw new Error('Missing Pal')
						const next = {
							...current,
							paused: params.paused as boolean,
							revision: current.revision + 1,
						}
						transport.pals.set(next.id, next)
						if (transport.pal?.id === next.id) transport.pal = next
						return next
					}
					case 'namzu/jobs/list':
						return []
					case 'namzu/pals/computer/status':
						return { status: 'stopped' }
					case 'namzu/pals/computer/screen':
						return transport.screen
					default:
						return {}
				}
			}
		},
	}
})
import { Operator } from './operator.js'
const roots: string[] = []
const owners: Operator[] = []
function fixture(publish: (event: DesktopEvent) => void = () => {}) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-desktop-pal-'))
	roots.push(root)
	const workspace = join(root, 'control')
	mkdirSync(workspace)
	transport.pal = {
		id: 'fixture-pal',
		name: 'Research',
		purpose: '',
		workspace,
		revision: 1,
		model: null,
		paused: false,
		createdAt: '2026-10-02T00:00:00Z',
		updatedAt: '2026-10-02T00:00:00Z',
	}
	transport.pals.set(transport.pal.id, transport.pal)
	const owner = new Operator(
		{ program: 'fixture', args: [] },
		publish,
		join(root, 'registry-client'),
	)
	owners.push(owner)
	return { owner, workspace, pal: transport.pal }
}
afterEach(async () => {
	transport.startHook = undefined
	transport.closeHook = undefined
	transport.requestHook = undefined
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	transport.calls.length = 0
	transport.answers.length = 0
	transport.clients.length = 0
	transport.instances.length = 0
	transport.claimFailure = false
	transport.pal = undefined
	transport.pals.clear()
	transport.sessionIds.clear()
	transport.claims.clear()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function deferred() {
	let resolve = () => {}
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function workspaceClient(cwd: string) {
	const client = transport.instances.filter((item) => item.cwd === cwd).at(-1)
	if (!client) throw new Error('Missing workspace client')
	return client
}
function updateFrame(sessionId: string, text: string) {
	return {
		method: 'session/update',
		params: { sessionId, update: { kind: 'agent_message_chunk', text } },
	}
}
function permissionFrame(sessionId: string, id: string | number) {
	return {
		id,
		method: 'session/request_permission',
		params: {
			sessionId,
			toolCalls: [{ id: 'same-tool-call', name: 'bash', input: { command: 'pwd' } }],
		},
	}
}
it('shares concurrent project starts and reconnects without orphaning a runtime client', async () => {
	const { owner, workspace } = fixture()
	const [first, same] = await Promise.all([
		owner.openProject(workspace),
		owner.openProject(workspace),
	])
	expect(first.id).toBe(same.id)
	expect(transport.clients).toHaveLength(1)
	transport.instances[0]?.emit('closed', new Error('Disconnected'))
	const closing = deferred()
	const entered = deferred()
	transport.closeHook = async () => {
		entered.resolve()
		await closing.promise
	}
	const reconnecting = Promise.all([owner.openProject(workspace), owner.openProject(workspace)])
	await entered.promise
	closing.resolve()
	const [second, reconnected] = await reconnecting
	expect(second.id).toBe(first.id)
	expect(reconnected.id).toBe(first.id)
	expect(transport.clients).toHaveLength(2)
	transport.closeHook = undefined
	await owner.close()
	expect(transport.clients.every((client) => client.closed)).toBe(true)
})
it('closes an in-flight project start without publishing a ready or unowned client', async () => {
	const events: DesktopEvent[] = []
	const { owner, workspace } = fixture((event) => events.push(event))
	const starting = deferred()
	const entered = deferred()
	transport.startHook = async () => {
		entered.resolve()
		await starting.promise
	}
	const opening = owner.openProject(workspace)
	await entered.promise
	const stopped = owner.close()
	starting.resolve()
	await expect(opening).rejects.toThrow('Namzu is closing')
	await stopped
	expect(owner.listProjects()).toEqual([])
	expect(transport.clients.every((client) => client.closed)).toBe(true)
	expect(
		events.some((event) => event.kind === 'connection' && event.project.status === 'ready'),
	).toBe(false)
	await expect(owner.openProject(workspace)).rejects.toThrow('Namzu is closing')
})
it('shares metadata startup and routes computer access through the Pal workspace client', async () => {
	const { owner, workspace, pal } = fixture()
	await Promise.all([owner.listPals(), owner.listPals()])
	expect(transport.clients).toHaveLength(1)
	await owner.openPal(pal.id)
	await owner.palComputer(pal.id)
	expect(transport.clients).toHaveLength(2)
	expect(transport.calls.find((call) => call.method === 'namzu/pals/computer/status')?.cwd).toBe(
		workspace,
	)
	await owner.close()
	expect(transport.clients.every((client) => client.closed)).toBe(true)
})
it('publishes a new conversation only after the runtime confirms its Pal claim', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	transport.claimFailure = true
	await expect(owner.newConversation(opened.project.id)).rejects.toThrow('Claim rejected')
	expect(() => owner.send('claimed-fixture-session', 'Should never send')).toThrow(
		'Open this conversation',
	)
	transport.claimFailure = false
	const conversation = await owner.newConversation(opened.project.id)
	expect(conversation.palId).toBe(pal.id)
	const methods = transport.calls.map((call) => call.method)
	expect(methods.at(-1)).toBe('namzu/pals/conversations/claim')
})
it('retains failed runtime shutdown ownership and confirms it on a later close', async () => {
	const { owner, pal, workspace } = fixture()
	await owner.listPals()
	const opened = await owner.openPal(pal.id)
	const registry = transport.clients.find((client) => client.cwd !== workspace)
	const project = transport.clients.find((client) => client.cwd === workspace)
	transport.closeHook = async (cwd) => {
		if (cwd !== workspace) throw new Error('Owned process tree could not be stopped')
	}
	// A transport may leave its UI slot before the process tree has been stopped.
	transport.instances.find((client) => client.cwd !== workspace)?.emit('closed', new Error('EOF'))
	await expect(owner.close()).rejects.toThrow('could not confirm')
	expect(registry?.closed).toBe(false)
	expect(project?.closed).toBe(true)
	expect(owner.listProjects().map((item) => item.id)).toContain(opened.project.id)
	await expect(owner.listPals()).rejects.toThrow('Namzu is closing')
	transport.closeHook = undefined
	await owner.close()
	expect(registry?.closed).toBe(true)
	expect(owner.listProjects()).toEqual([])
})
it('blocks new conversations and prompt admission for a paused Pal', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	await owner.updatePal(pal.id, 1, { paused: true })
	await expect(owner.newConversation(opened.project.id)).rejects.toThrow('Resume this Pal')
	expect(() => owner.send(conversation.id, 'No new turn')).toThrow('Resume this Pal')
	expect(transport.calls.some((call) => call.method === 'session/prompt')).toBe(false)
})
it('rejects foreign Pal frames and keeps reused permission wire ids owned by their clients', async () => {
	const events: DesktopEvent[] = []
	const finishedA = deferred()
	const finishedB = deferred()
	const { owner, pal } = fixture((event) => {
		events.push(event)
		if (event.kind === 'state' && !event.running) {
			if (event.sessionId === 'pal-a-session') finishedA.resolve()
			if (event.sessionId === 'pal-b-session') finishedB.resolve()
		}
	})
	const other = {
		...pal,
		id: 'other-pal',
		name: 'Writer',
		workspace: join(pal.workspace, '..', 'other-control'),
	}
	mkdirSync(other.workspace)
	transport.pals.set(other.id, other)
	transport.sessionIds.set(pal.workspace, 'pal-a-session')
	transport.sessionIds.set(other.workspace, 'pal-b-session')
	const [projectA, projectB] = await Promise.all([owner.openPal(pal.id), owner.openPal(other.id)])
	const a = await owner.newConversation(projectA.project.id)
	const b = await owner.newConversation(projectB.project.id)
	const enteredA = deferred()
	const enteredB = deferred()
	const completeA = deferred()
	const completeB = deferred()
	transport.requestHook = async (cwd, method) => {
		if (method !== 'session/prompt') return undefined
		if (cwd === pal.workspace) {
			enteredA.resolve()
			await completeA.promise
		} else {
			enteredB.resolve()
			await completeB.promise
		}
		return { stopReason: 'end_turn' }
	}
	owner.send(a.id, 'Research request')
	owner.send(b.id, 'Writing request')
	await Promise.all([enteredA.promise, enteredB.promise])
	try {
		const clientA = workspaceClient(pal.workspace)
		const clientB = workspaceClient(other.workspace)
		const beforeA = await owner.openConversation(projectA.project.id, a.id)
		const beforeB = await owner.openConversation(projectB.project.id, b.id)
		const count = events.length
		clientA.emit('frame', updateFrame(b.id, 'Foreign text from A'))
		clientB.emit('frame', updateFrame(a.id, 'Foreign text from B'))
		clientA.emit('frame', permissionFrame(b.id, 'foreign-A'))
		clientB.emit('frame', permissionFrame(a.id, 'foreign-B'))
		expect(events).toHaveLength(count)
		expect((await owner.openConversation(projectA.project.id, a.id)).thread).toEqual(beforeA.thread)
		expect((await owner.openConversation(projectB.project.id, b.id)).thread).toEqual(beforeB.thread)
		expect(transport.answers).toEqual([
			{ cwd: pal.workspace, id: 'foreign-A', result: { outcome: 'reject' } },
			{ cwd: other.workspace, id: 'foreign-B', result: { outcome: 'reject' } },
		])

		clientA.emit('frame', updateFrame(a.id, 'Owned answer A'))
		clientB.emit('frame', updateFrame(b.id, 'Owned answer B'))
		clientA.emit('frame', permissionFrame(a.id, 7))
		clientB.emit('frame', permissionFrame(b.id, 7))
		const reviewA = events.find(
			(event) => event.kind === 'permission' && event.request.sessionId === a.id,
		)
		const reviewB = events.find(
			(event) => event.kind === 'permission' && event.request.sessionId === b.id,
		)
		if (reviewA?.kind !== 'permission' || reviewB?.kind !== 'permission')
			throw new Error('Missing owned reviews')
		expect(reviewA.request.id).not.toBe(reviewB.request.id)
		expect(() => owner.approve(a.id, reviewB.request.id, true)).toThrow('no longer pending')
		expect(() => owner.approve(b.id, reviewA.request.id, true)).toThrow('no longer pending')
		owner.approve(a.id, reviewA.request.id, true)
		expect(transport.answers.at(-1)).toEqual({
			cwd: pal.workspace,
			id: 7,
			result: { outcome: 'approve' },
		})
		expect((await owner.openConversation(projectA.project.id, a.id)).thread).toMatchObject({
			messages: [
				{ role: 'user', text: 'Research request' },
				{ role: 'assistant', text: 'Owned answer A' },
			],
			permissions: [],
		})
		expect((await owner.openConversation(projectB.project.id, b.id)).thread).toMatchObject({
			messages: [
				{ role: 'user', text: 'Writing request' },
				{ role: 'assistant', text: 'Owned answer B' },
			],
			permissions: [{ id: reviewB.request.id }],
		})
		owner.approve(b.id, reviewB.request.id, false)
		expect(transport.answers.at(-1)).toEqual({
			cwd: other.workspace,
			id: 7,
			result: { outcome: 'reject' },
		})
	} finally {
		completeA.resolve()
		completeB.resolve()
		await Promise.all([finishedA.promise, finishedB.promise])
	}
})
it('discards late frames from a replaced Pal client while its resumed conversation is running', async () => {
	const events: DesktopEvent[] = []
	const finished = deferred()
	let awaitingFinish = false
	const { owner, pal } = fixture((event) => {
		events.push(event)
		if (awaitingFinish && event.kind === 'state' && !event.running) finished.resolve()
	})
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const original = workspaceClient(pal.workspace)
	original.emit('closed', new Error('Disconnected'))
	await owner.reconnect(opened.project.id)
	await owner.openConversation(opened.project.id, conversation.id)
	const replacement = workspaceClient(pal.workspace)
	expect(replacement).not.toBe(original)
	const entered = deferred()
	const complete = deferred()
	transport.requestHook = async (_cwd, method) => {
		if (method !== 'session/prompt') return undefined
		entered.resolve()
		await complete.promise
		return { stopReason: 'end_turn' }
	}
	awaitingFinish = true
	owner.send(conversation.id, 'Continue on the new connection')
	await entered.promise
	try {
		const before = await owner.openConversation(opened.project.id, conversation.id)
		const count = events.length
		original.emit('frame', updateFrame(conversation.id, 'Stale answer'))
		original.emit('frame', permissionFrame(conversation.id, 'stale-permission'))
		expect(events).toHaveLength(count)
		expect((await owner.openConversation(opened.project.id, conversation.id)).thread).toEqual(
			before.thread,
		)
		expect(transport.answers).toEqual([])
		replacement.emit('frame', updateFrame(conversation.id, 'Current answer'))
		expect((await owner.openConversation(opened.project.id, conversation.id)).thread).toMatchObject(
			{
				running: true,
				messages: [
					{ role: 'user', text: 'Continue on the new connection' },
					{ role: 'assistant', text: 'Current answer' },
				],
				permissions: [],
			},
		)
	} finally {
		complete.resolve()
		await finished.promise
	}
})
it('loads a durable empty Pal claim once after reconnect and preserves its session identity', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const original = workspaceClient(pal.workspace)
	expect(transport.claims.get(pal.workspace)).toEqual([conversation.id])
	original.emit('closed', new Error('Disconnected before first prompt'))
	await owner.reconnect(opened.project.id)
	expect(await owner.listConversations(opened.project.id)).toContainEqual(
		expect.objectContaining({ id: conversation.id, palId: pal.id }),
	)
	const loadEntered = deferred()
	const loadComplete = deferred()
	transport.requestHook = async (_cwd, method, params) => {
		if (method !== 'session/load') return undefined
		loadEntered.resolve()
		await loadComplete.promise
		return { sessionId: params.sessionId }
	}
	const loading = Promise.all([
		owner.openConversation(opened.project.id, conversation.id),
		owner.openConversation(opened.project.id, conversation.id),
	])
	await loadEntered.promise
	expect(transport.calls.filter((call) => call.method === 'session/load')).toEqual([
		{
			cwd: pal.workspace,
			method: 'session/load',
			params: { cwd: pal.workspace, sessionId: conversation.id },
		},
	])
	loadComplete.resolve()
	for (const history of await loading)
		expect(history.thread).toMatchObject({ messages: [], running: false, permissions: [] })
	expect(transport.calls.filter((call) => call.method === 'session/new')).toHaveLength(1)
	expect(
		transport.calls.filter((call) => call.method === 'namzu/pals/conversations/claim'),
	).toHaveLength(1)
	expect(transport.calls.filter((call) => call.method === 'session/prompt')).toEqual([])
	expect(transport.claims.get(pal.workspace)).toEqual([conversation.id])
})
it('rejects an invalid screenshot before forwarding image content to the renderer', async () => {
	const { owner, pal } = fixture()
	await expect(owner.palScreen(pal.id)).resolves.toMatchObject({ width: 1280, height: 800 })
	const original = transport.screen
	try {
		transport.screen = { source: 'https://untrusted.invalid/screen.png', width: 1280, height: 800 }
		await expect(owner.palScreen(pal.id)).rejects.toThrow('invalid screen')
	} finally {
		transport.screen = original
	}
})

it('forwards appearance selections through the Pal create/update wire and returns the saved selection', async () => {
	const { owner, pal } = fixture()
	const initial = { character: 'spark', color: 'violet' } as const
	const edited = { character: 'sprout', color: 'rose' } as const
	transport.requestHook = async (_cwd, method, params) => {
		if (method === 'namzu/pals/create') return { ...pal, appearance: params.appearance }
		if (method === 'namzu/pals/update')
			return { ...pal, revision: 2, appearance: params.appearance }
		return undefined
	}
	expect((await owner.createPal({ name: pal.name, appearance: initial })).appearance).toEqual(
		initial,
	)
	expect((await owner.updatePal(pal.id, 1, { appearance: edited })).appearance).toEqual(edited)
	expect(transport.calls.find((call) => call.method === 'namzu/pals/create')?.params).toEqual({
		name: pal.name,
		appearance: initial,
	})
	expect(transport.calls.find((call) => call.method === 'namzu/pals/update')?.params).toEqual({
		id: pal.id,
		expectedRevision: 1,
		appearance: edited,
	})
})
