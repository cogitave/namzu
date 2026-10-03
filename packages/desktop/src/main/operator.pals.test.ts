import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent, PalComputerStreamView, PalView } from '../shared/protocol.js'
import type { PalStreamProxy } from './pal-stream-proxy.js'

const transport = vi.hoisted(() => ({
	pal: undefined as PalView | undefined,
	pals: new Map<string, PalView>(),
	sessionIds: new Map<string, string>(),
	claims: new Map<string, string[]>(),
	calls: [] as { cwd: string; method: string; params: Record<string, unknown> }[],
	answers: [] as { cwd: string; id: string | number; result: unknown }[],
	clients: [] as { cwd: string; closed: boolean }[],
	instances: [] as {
		cwd: string
		emit(event: string, value: unknown): boolean
		listenerCount(event: string): number
	}[],
	startHook: undefined as ((cwd: string) => Promise<void>) | undefined,
	closeHook: undefined as ((cwd: string) => Promise<void>) | undefined,
	requestHook: undefined as
		| ((cwd: string, method: string, params: Record<string, unknown>) => Promise<unknown>)
		| undefined,
	claimFailure: false,
	controlSupported: true,
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
			supportsPalComputerControl() {
				return transport.controlSupported
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
function fixture(
	publish: (event: DesktopEvent) => void = () => {},
	streamProxy?: Pick<PalStreamProxy, 'onClosed' | 'open' | 'close'>,
) {
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
		undefined,
		streamProxy,
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
	transport.controlSupported = true
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
function fakeStreamProxy() {
	const listeners = new Set<(id: string) => void>()
	const views = new Map<string, PalComputerStreamView>()
	let sequence = 0
	const proxy = {
		onClosed(listener: (id: string) => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		open: vi.fn((_descriptor: unknown, generation: string): PalComputerStreamView => {
			const view = {
				id: `fixture-view-${++sequence}`,
				url: 'ws://127.0.0.1:1234/stream/fixture-ticket',
				generation,
				width: 1280,
				height: 800,
			}
			views.set(view.id, view)
			return view
		}),
		close: vi.fn((id: string) => {
			if (!views.delete(id)) return
			for (const listener of listeners) listener(id)
		}),
	}
	return { proxy, views }
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
it('loads onboarding and saved Pal catalogues without starting a computer or conversation', async () => {
	const { owner, workspace, pal } = fixture()
	const provider = { id: 'zen', label: 'Zen', defaultModel: 'space-bunny-free' }
	const catalogue = {
		models: [{ id: provider.defaultModel, label: 'Space Bunny Free' }],
		notice: null,
	}
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/providers/status')
			return { available: [provider], selected: { id: provider.id, model: provider.defaultModel } }
		if (method === 'namzu/providers/models') return catalogue
	}

	expect((await owner.palProviders()).available).toEqual([provider])
	expect(await owner.palModels(provider.id)).toEqual(catalogue)
	const opened = await owner.openPal(pal.id)
	expect((await owner.providers(opened.project.id)).selected?.model).toBe(provider.defaultModel)
	expect(await owner.models(opened.project.id, provider.id)).toEqual(catalogue)

	const requests = transport.calls.filter((call) => call.method === 'namzu/providers/models')
	expect(requests).toEqual([
		{
			cwd: transport.clients[0]?.cwd,
			method: 'namzu/providers/models',
			params: { provider: 'zen' },
		},
		{ cwd: workspace, method: 'namzu/providers/models', params: { provider: 'zen' } },
	])
	expect(requests[0]?.cwd).not.toBe(workspace)
	expect(
		transport.calls.some((call) =>
			['session/new', 'session/prompt', 'namzu/pals/computer/start'].includes(call.method),
		),
	).toBe(false)
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

it('verifies a stale generation before cancelling any owned Pal work', async () => {
	const { owner, pal } = fixture()
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation: '2', control: { supported: true, mode: 'pal' } }
	}
	await expect(owner.takeOverPalComputer(pal.id, '1')).rejects.toThrow('computer changed')
	expect(
		transport.calls.some((call) =>
			['session/cancel', 'namzu/jobs/stop', 'namzu/pals/computer/take_over'].includes(call.method),
		),
	).toBe(false)
})
it('reports unsupported controls without attempting transfer or input', async () => {
	const { owner, pal } = fixture()
	transport.controlSupported = false
	expect((await owner.palComputer(pal.id)).control).toEqual({
		supported: false,
		mode: 'unavailable',
	})
	await expect(owner.takeOverPalComputer(pal.id, '1')).rejects.toThrow('does not support')
	await expect(owner.palComputerInput(pal.id, '1', { type: 'key', keys: 'A' })).rejects.toThrow(
		'does not support',
	)
	expect(
		transport.calls.some((call) =>
			['namzu/pals/computer/take_over', 'namzu/pals/computer/input'].includes(call.method),
		),
	).toBe(false)
})
it('fences new work, waits for cancelled foreground completion, stops owned jobs and retains the queue', async () => {
	const events: DesktopEvent[] = []
	const { owner, pal } = fixture((event) => events.push(event))
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const promptEntered = deferred()
	const promptDone = deferred()
	const cancelEntered = deferred()
	const stopEntered = deferred()
	const stopDone = deferred()
	let mode = 'pal'
	let jobRunning = true
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation: '1', control: { supported: true, mode } }
		if (method === 'session/prompt') {
			promptEntered.resolve()
			await promptDone.promise
			return { stopReason: 'end_turn' }
		}
		if (method === 'session/cancel') {
			cancelEntered.resolve()
			return {}
		}
		if (method === 'namzu/jobs/list')
			return jobRunning
				? [{ id: 'owned-job', status: 'running' }]
				: [{ id: 'owned-job', status: 'killed' }]
		if (method === 'namzu/jobs/stop') {
			stopEntered.resolve()
			await stopDone.promise
			jobRunning = false
			return {}
		}
		if (method === 'namzu/pals/computer/take_over') {
			mode = 'operator'
			return { status: 'ready', generation: '1', control: { supported: true, mode } }
		}
		if (method === 'namzu/pals/computer/return_control') {
			mode = 'pal'
			return { status: 'ready', generation: '1', control: { supported: true, mode } }
		}
	}
	owner.send(conversation.id, 'First')
	await promptEntered.promise
	owner.send(conversation.id, 'Queued')
	const takeover = owner.takeOverPalComputer(pal.id, '1')
	await cancelEntered.promise
	expect(() => owner.send(conversation.id, 'Concurrent')).toThrow('changes to finish')
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/take_over')).toBe(
		false,
	)
	promptDone.resolve()
	await stopEntered.promise
	expect(transport.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/take_over')).toBe(
		false,
	)
	stopDone.resolve()
	expect((await takeover).control?.mode).toBe('operator')
	expect(() => owner.send(conversation.id, 'Blocked')).toThrow('Return this Pal computer')
	expect(transport.calls.find((call) => call.method === 'namzu/jobs/stop')?.params).toEqual({
		sessionId: conversation.id,
		jobId: 'owned-job',
	})
	await owner.returnPalComputerControl(pal.id, '1')
	expect(transport.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
	const state = events.filter((event) => event.kind === 'state').at(-1)
	expect(state?.kind === 'state' && state.queued).toEqual(['Queued'])
})
it('keeps Pal control when job termination remains unconfirmed', async () => {
	const completed = deferred()
	const { owner, pal } = fixture((event) => {
		if (event.kind === 'state' && !event.running) completed.resolve()
	})
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'session/prompt') return { stopReason: 'end_turn' }
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation: '1', control: { supported: true, mode: 'pal' } }
		if (method === 'namzu/jobs/list')
			return [{ id: 'owned-job', status: 'running', recoveryRequired: true }]
		if (method === 'namzu/jobs/stop') throw new Error('Stop unconfirmed')
	}
	owner.send(conversation.id, 'Prepare')
	await completed.promise
	await expect(owner.takeOverPalComputer(pal.id, '1')).rejects.toThrow('Stop unconfirmed')
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/take_over')).toBe(
		false,
	)
	expect(() => owner.send(conversation.id, 'Retry')).not.toThrow()
})
it('captures exact operator input before asynchronous preflight and routes only to its owned guest client', async () => {
	const { owner, pal, workspace } = fixture()
	const statusEntered = deferred()
	const statusDone = deferred()
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status') {
			statusEntered.resolve()
			await statusDone.promise
			return { status: 'ready', generation: '7', control: { supported: true, mode: 'operator' } }
		}
		if (method === 'namzu/pals/computer/input') return { type: 'ok' }
	}
	const input = { type: 'key' as const, keys: 'A' }
	const pending = owner.palComputerInput(pal.id, '7', input)
	await statusEntered.promise
	input.keys = 'B'
	statusDone.resolve()
	await pending
	expect(transport.calls.find((call) => call.method === 'namzu/pals/computer/input')).toEqual({
		cwd: workspace,
		method: 'namzu/pals/computer/input',
		params: { palId: pal.id, generation: '7', input: { type: 'key', keys: 'A' } },
	})
	await owner.palScreen(pal.id, '7')
	expect(
		transport.calls.find((call) => call.method === 'namzu/pals/computer/screen')?.params,
	).toEqual({ palId: pal.id, generation: '7' })
})
it('clears native control admission fencing only after a confirmed computer stop', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation: '1', control: { supported: true, mode: 'operator' } }
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
	}
	await owner.palComputer(pal.id)
	expect(() => owner.send(conversation.id, 'Still owned')).toThrow('Return this Pal computer')
	await owner.stopPalComputer(pal.id)
	expect(() => owner.send(conversation.id, 'Fresh admission')).not.toThrow()
})
it('does not let an earlier Pal status response clear newly confirmed operator authority', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const statusEntered = deferred()
	const oldStatusDone = deferred()
	let first = true
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status') {
			if (first) {
				first = false
				statusEntered.resolve()
				await oldStatusDone.promise
			}
			return { status: 'ready', generation: '1', control: { supported: true, mode: 'pal' } }
		}
		if (method === 'namzu/pals/computer/take_over')
			return { status: 'ready', generation: '1', control: { supported: true, mode: 'operator' } }
	}
	const stale = owner.palComputer(pal.id)
	await statusEntered.promise
	await owner.takeOverPalComputer(pal.id, '1')
	oldStatusDone.resolve()
	await stale
	expect(() => owner.send(conversation.id, 'No concurrent Pal work')).toThrow(
		'Return this Pal computer',
	)
})

it('reuses only an owned ready Pal input connection without reloading metadata or conversations', async () => {
	const { owner, pal, workspace } = fixture()
	await owner.openPal(pal.id)
	let mode = 'operator'
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation: '8', control: { supported: true, mode } }
		if (method === 'namzu/pals/computer/input') return { type: 'ok' }
	}
	const before = transport.calls.length
	await owner.palComputerInput(pal.id, '8', { type: 'key', keys: 'CTRL+l' })
	await owner.palComputerInput(pal.id, '8', { type: 'type_text', text: 'Owned guest text' })
	await expect(owner.palComputerInput(pal.id, '7', { type: 'key', keys: 'ENTER' })).rejects.toThrow(
		'computer changed',
	)
	mode = 'pal'
	await expect(owner.palComputerInput(pal.id, '8', { type: 'key', keys: 'ENTER' })).rejects.toThrow(
		'control changed',
	)
	const calls = transport.calls.slice(before)
	expect(calls.every((call) => call.cwd === workspace && call.params.palId === pal.id)).toBe(true)
	expect(calls.map((call) => call.method)).toEqual([
		'namzu/pals/computer/status',
		'namzu/pals/computer/input',
		'namzu/pals/computer/status',
		'namzu/pals/computer/input',
		'namzu/pals/computer/status',
		'namzu/pals/computer/status',
	])
})
it('reuses the owned ready connection for status and generation-bound frames without rescanning conversations', async () => {
	const { owner, pal, workspace } = fixture()
	await owner.openPal(pal.id)
	const before = transport.calls.length
	await owner.palComputer(pal.id)
	await owner.palScreen(pal.id, '7')
	const calls = transport.calls.slice(before)
	expect(calls.map((call) => call.method)).toEqual([
		'namzu/pals/computer/status',
		'namzu/pals/computer/screen',
	])
	expect(calls.every((call) => call.cwd === workspace && call.params.palId === pal.id)).toBe(true)
	expect(calls[1]?.params.generation).toBe('7')
})
it('reconnects an errored Pal input client instead of reusing its retained shutdown authority', async () => {
	const { owner, pal, workspace } = fixture()
	await owner.openPal(pal.id)
	const old = workspaceClient(workspace)
	old.emit('closed', new Error('Unexpected disconnect'))
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation: '9', control: { supported: true, mode: 'operator' } }
		if (method === 'namzu/pals/computer/input') return { type: 'ok' }
	}
	const before = transport.calls.length
	await owner.palComputerInput(pal.id, '9', { type: 'key', keys: 'A' })
	expect(workspaceClient(workspace)).not.toBe(old)
	expect(transport.clients.filter((client) => client.cwd === workspace)).toHaveLength(2)
	expect(transport.calls.slice(before).map((call) => call.method)).toContain('namzu/pals/get')
	expect(
		transport.calls.filter((call) => call.method === 'namzu/pals/computer/input').at(-1),
	).toMatchObject({ cwd: workspace, params: { palId: pal.id, generation: '9' } })
})

it('rejects a delayed native input preflight after return and retake of the same computer generation', async () => {
	const { owner, pal } = fixture()
	await owner.openPal(pal.id)
	const oldStatusEntered = deferred()
	const oldStatusDone = deferred()
	let first = true
	let mode = 'operator'
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status') {
			if (first) {
				first = false
				oldStatusEntered.resolve()
				await oldStatusDone.promise
				return { status: 'ready', generation: '12', control: { supported: true, mode: 'operator' } }
			}
			return { status: 'ready', generation: '12', control: { supported: true, mode } }
		}
		if (method === 'namzu/pals/computer/return_control') {
			mode = 'pal'
			return { status: 'ready', generation: '12', control: { supported: true, mode } }
		}
		if (method === 'namzu/pals/computer/take_over') {
			mode = 'operator'
			return { status: 'ready', generation: '12', control: { supported: true, mode } }
		}
		if (method === 'namzu/pals/computer/input') return { type: 'ok' }
	}
	const pending = owner.palComputerInput(pal.id, '12', {
		type: 'type_text',
		text: 'Old control cycle',
	})
	await oldStatusEntered.promise
	await owner.returnPalComputerControl(pal.id, '12')
	await owner.takeOverPalComputer(pal.id, '12')
	const rejected = expect(pending).rejects.toThrow('earlier computer control')
	oldStatusDone.resolve()
	await rejected
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/input')).toBe(false)
	await owner.palComputerInput(pal.id, '12', { type: 'key', keys: 'ENTER' })
	expect(transport.calls.filter((call) => call.method === 'namzu/pals/computer/input')).toEqual([
		expect.objectContaining({
			params: { palId: pal.id, generation: '12', input: { type: 'key', keys: 'ENTER' } },
		}),
	])
})

it('opens a live view only through the owned current client and detaches its listener when the proxy closes', async () => {
	const { proxy, views } = fakeStreamProxy()
	const { owner, pal, workspace } = fixture(() => {}, proxy)
	await owner.openPal(pal.id)
	const client = workspaceClient(workspace)
	const initialListeners = client.listenerCount('closed')
	const descriptor = {
		protocol: 'rfb',
		url: 'ws://127.0.0.1:1234/stream',
		authorization: 'Bearer fixture-private-allocation',
		generation: '12',
		width: 1280,
		height: 800,
	}
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/stream') return descriptor
	}
	const before = transport.calls.length
	const view = await owner.openPalComputerStream(pal.id, '12')
	expect(transport.calls.slice(before)).toEqual([
		{
			cwd: workspace,
			method: 'namzu/pals/computer/stream',
			params: { palId: pal.id, generation: '12' },
		},
	])
	expect(proxy.open).toHaveBeenCalledWith(descriptor, '12')
	expect(view).not.toHaveProperty('authorization')
	expect(client.listenerCount('closed')).toBe(initialListeners + 1)
	proxy.close(view.id)
	expect(views.size).toBe(0)
	expect(client.listenerCount('closed')).toBe(initialListeners)
	const closeCalls = proxy.close.mock.calls.length
	owner.closePalComputerStream(view.id)
	expect(proxy.close).toHaveBeenCalledTimes(closeCalls)
})

it('rejects a stream result from the previous authority epoch before opening a ticket', async () => {
	const { proxy } = fakeStreamProxy()
	const { owner, pal } = fixture(() => {}, proxy)
	await owner.openPal(pal.id)
	const streamEntered = deferred()
	const streamDone = deferred()
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/stream') {
			streamEntered.resolve()
			await streamDone.promise
			return { generation: '1' }
		}
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation: '1', control: { supported: true, mode: 'pal' } }
		if (method === 'namzu/pals/computer/take_over')
			return { status: 'ready', generation: '1', control: { supported: true, mode: 'operator' } }
	}
	const view = owner.openPalComputerStream(pal.id, '1')
	await streamEntered.promise
	await owner.takeOverPalComputer(pal.id, '1')
	const rejected = expect(view).rejects.toThrow('changed before the view opened')
	streamDone.resolve()
	await rejected
	expect(proxy.open).not.toHaveBeenCalled()
})

it('reboots only the current owned generation, preserving its profile and closing only its viewers after confirmed stop', async () => {
	const { proxy, views } = fakeStreamProxy()
	const { owner, pal, workspace } = fixture(() => {}, proxy)
	const otherWorkspace = join(roots.at(-1) as string, 'other-control')
	mkdirSync(otherWorkspace)
	const other = { ...pal, id: 'other-pal', workspace: otherWorkspace }
	transport.pals.set(other.id, other)
	await owner.openPal(pal.id)
	await owner.openPal(other.id)
	let generation = '5'
	let mode = 'operator'
	transport.requestHook = async (cwd, method) => {
		if (method === 'namzu/pals/computer/stream')
			return { generation: cwd === workspace ? generation : '1' }
		if (method === 'namzu/pals/computer/status')
			return { status: 'ready', generation, control: { supported: true, mode } }
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
		if (method === 'namzu/pals/computer/start') {
			generation = '6'
			mode = 'pal'
			return { status: 'ready', generation, control: { supported: true, mode } }
		}
	}
	const view = await owner.openPalComputerStream(pal.id, '5')
	const otherView = await owner.openPalComputerStream(other.id, '1')
	const client = workspaceClient(workspace)
	const listeners = client.listenerCount('closed')
	const before = transport.calls.length
	expect(await owner.rebootPalComputer(pal.id, '5')).toMatchObject({
		status: 'ready',
		generation: '6',
		control: { mode: 'pal' },
	})
	expect(transport.pals.get(pal.id)).toEqual(pal)
	expect(views.has(view.id)).toBe(false)
	expect(views.has(otherView.id)).toBe(true)
	expect(client.listenerCount('closed')).toBe(listeners - 1)
	expect(
		transport.calls.slice(before).filter((call) => /computer\/(stop|start)$/.test(call.method)),
	).toEqual([
		{ cwd: workspace, method: 'namzu/pals/computer/stop', params: { palId: pal.id } },
		{ cwd: workspace, method: 'namzu/pals/computer/start', params: { palId: pal.id } },
	])
	expect(transport.calls.some((call) => call.method === 'session/prompt')).toBe(false)
	await expect(owner.palComputerInput(pal.id, '5', { type: 'key', keys: 'ENTER' })).rejects.toThrow(
		'computer changed',
	)
})

it.each(['0', '01', '-1', '9007199254740992'])(
	'rejects invalid reboot generation %s before any stop',
	async (generation) => {
		const { owner, pal } = fixture()
		await expect(owner.rebootPalComputer(pal.id, generation)).rejects.toThrow(
			'Invalid Pal computer generation',
		)
		expect(transport.calls).toEqual([])
	},
)

it('refuses a stale reboot generation and a persisted paused Pal before stopping either computer', async () => {
	const { owner, pal } = fixture()
	await owner.openPal(pal.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '2' }
	}
	await expect(owner.rebootPalComputer(pal.id, '1')).rejects.toThrow('computer changed')
	transport.pals.set(pal.id, { ...pal, paused: true, revision: 2 })
	await expect(owner.rebootPalComputer(pal.id, '2')).rejects.toThrow('Resume this Pal')
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/stop')).toBe(false)
})

it('rereads pause after asynchronous idle verification instead of stopping a newly paused Pal', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	await owner.newConversation(opened.project.id)
	const jobsEntered = deferred()
	const jobsDone = deferred()
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '1' }
		if (method === 'namzu/jobs/list') {
			jobsEntered.resolve()
			await jobsDone.promise
			return []
		}
	}
	const reboot = owner.rebootPalComputer(pal.id, '1')
	await jobsEntered.promise
	transport.pals.set(pal.id, { ...pal, paused: true, revision: 2 })
	const rejected = expect(reboot).rejects.toThrow('Resume this Pal')
	jobsDone.resolve()
	await rejected
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/stop')).toBe(false)
})

it.each([
	{ jobs: [{ id: 'job', status: 'running' }] },
	{ jobs: [{ id: 'job', status: 'killed', recoveryRequired: true }] },
	{ jobs: { unknown: true } },
])('refuses reboot when background idleness cannot be confirmed ($jobs)', async ({ jobs }) => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	await owner.newConversation(opened.project.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '1' }
		if (method === 'namzu/jobs/list') return jobs
	}
	await expect(owner.rebootPalComputer(pal.id, '1')).rejects.toThrow('background work')
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/stop')).toBe(false)
})

it.each(['running', 'review', 'queued'])(
	'refuses reboot while owned foreground work is %s',
	async (work) => {
		const completed = deferred()
		const { owner, pal, workspace } = fixture((event) => {
			if (event.kind === 'state' && !event.running) completed.resolve()
		})
		const opened = await owner.openPal(pal.id)
		const conversation = await owner.newConversation(opened.project.id)
		const promptEntered = deferred()
		const promptDone = deferred()
		transport.requestHook = async (_cwd, method) => {
			if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '1' }
			if (method === 'session/prompt') {
				promptEntered.resolve()
				await promptDone.promise
				return { stopReason: 'cancelled' }
			}
		}
		owner.send(conversation.id, 'Owned foreground')
		await promptEntered.promise
		if (work === 'review')
			workspaceClient(workspace).emit('frame', permissionFrame(conversation.id, 'review'))
		if (work === 'queued') owner.send(conversation.id, 'Queued foreground')
		await expect(owner.rebootPalComputer(pal.id, '1')).rejects.toThrow('active work')
		promptDone.resolve()
		await completed.promise
		if (work === 'queued')
			await expect(owner.rebootPalComputer(pal.id, '1')).rejects.toThrow('active work')
		expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/stop')).toBe(false)
	},
)

it('keeps the reboot fence across both stop and start, including input, live views and new messages', async () => {
	const { proxy } = fakeStreamProxy()
	const { owner, pal } = fixture(() => {}, proxy)
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const stopEntered = deferred()
	const stopDone = deferred()
	const startEntered = deferred()
	const startDone = deferred()
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '1' }
		if (method === 'namzu/pals/computer/stop') {
			stopEntered.resolve()
			await stopDone.promise
			return { status: 'stopped' }
		}
		if (method === 'namzu/pals/computer/start') {
			startEntered.resolve()
			await startDone.promise
			return { status: 'ready', generation: '2' }
		}
	}
	const reboot = owner.rebootPalComputer(pal.id, '1')
	const assertFenced = async () => {
		expect(() => owner.send(conversation.id, 'Concurrent prompt')).toThrow('changes to finish')
		await expect(owner.newConversation(opened.project.id)).rejects.toThrow('changes to finish')
		await expect(
			owner.palComputerInput(pal.id, '1', { type: 'key', keys: 'ENTER' }),
		).rejects.toThrow('control change')
		await expect(owner.openPalComputerStream(pal.id, '1')).rejects.toThrow('changes to finish')
		await expect(owner.startPalComputer(pal.id)).rejects.toThrow('changes to finish')
		await expect(owner.stopPalComputer(pal.id)).rejects.toThrow('changes to finish')
		await expect(owner.rebootPalComputer(pal.id, '1')).rejects.toThrow('changes to finish')
	}
	await stopEntered.promise
	await assertFenced()
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/start')).toBe(false)
	stopDone.resolve()
	await startEntered.promise
	await assertFenced()
	startDone.resolve()
	expect(await reboot).toMatchObject({ status: 'ready', generation: '2' })
	await expect(owner.newConversation(opened.project.id)).resolves.toHaveProperty('palId', pal.id)
	expect(transport.calls.some((call) => call.method === 'session/prompt')).toBe(false)
})

it.each(['failed', 'unconfirmed'])(
	'never starts after a %s stop or discards the current viewer/control latch',
	async (outcome) => {
		const { proxy, views } = fakeStreamProxy()
		const { owner, pal } = fixture(() => {}, proxy)
		const opened = await owner.openPal(pal.id)
		const conversation = await owner.newConversation(opened.project.id)
		transport.requestHook = async (_cwd, method) => {
			if (method === 'namzu/pals/computer/status')
				return { status: 'ready', generation: '1', control: { supported: true, mode: 'operator' } }
			if (method === 'namzu/pals/computer/stream') return { generation: '1' }
			if (method === 'namzu/pals/computer/stop') {
				if (outcome === 'failed') throw new Error('Stop failed')
				return { status: 'unavailable' }
			}
		}
		await owner.palComputer(pal.id)
		const view = await owner.openPalComputerStream(pal.id, '1')
		await expect(owner.rebootPalComputer(pal.id, '1')).rejects.toThrow(
			outcome === 'failed' ? 'Stop failed' : 'did not confirm its stop',
		)
		expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/start')).toBe(false)
		expect(views.has(view.id)).toBe(true)
		expect(() => owner.send(conversation.id, 'Still operator owned')).toThrow(
			'Return this Pal computer',
		)
	},
)

it.each(['failed', 'old-generation', 'unavailable'])(
	'does not report successful reboot after %s startup',
	async (outcome) => {
		const { proxy, views } = fakeStreamProxy()
		const { owner, pal } = fixture(() => {}, proxy)
		await owner.openPal(pal.id)
		transport.requestHook = async (_cwd, method) => {
			if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '1' }
			if (method === 'namzu/pals/computer/stream') return { generation: '1' }
			if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
			if (method === 'namzu/pals/computer/start') {
				if (outcome === 'failed') throw new Error('Start failed')
				return outcome === 'old-generation'
					? { status: 'ready', generation: '1' }
					: { status: 'unavailable' }
			}
		}
		const view = await owner.openPalComputerStream(pal.id, '1')
		await expect(owner.rebootPalComputer(pal.id, '1')).rejects.toThrow(
			outcome === 'failed' ? 'Start failed' : 'did not confirm a new generation',
		)
		expect(views.has(view.id)).toBe(false)
		expect(
			transport.calls.filter((call) => call.method === 'namzu/pals/computer/start'),
		).toHaveLength(1)
	},
)

it('refuses an earlier independent start preflight after a complete reboot', async () => {
	const { owner, pal } = fixture()
	await owner.openPal(pal.id)
	const getEntered = deferred()
	const getDone = deferred()
	let first = true
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/get' && first) {
			first = false
			getEntered.resolve()
			await getDone.promise
			return pal
		}
		if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '1' }
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
		if (method === 'namzu/pals/computer/start') return { status: 'ready', generation: '2' }
	}
	const oldStart = owner.startPalComputer(pal.id)
	await getEntered.promise
	await owner.rebootPalComputer(pal.id, '1')
	const rejected = expect(oldStart).rejects.toThrow('changed before it could start')
	getDone.resolve()
	await rejected
	expect(
		transport.calls.filter((call) => call.method === 'namzu/pals/computer/start'),
	).toHaveLength(1)
})
