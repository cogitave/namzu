import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent, PalComputerStreamView, PalView } from '../shared/protocol.js'
import type { PalStreamProxy } from './pal-stream-proxy.js'
import type { RuntimeClient } from './rpc-client.js'
import { SupersededConversationSettingsError } from './superseded-settings.js'

vi.mock('node:fs/promises', { spy: true })

const transport = vi.hoisted(() => ({
	pal: undefined as PalView | undefined,
	pals: new Map<string, PalView>(),
	sessionIds: new Map<string, string>(),
	claims: new Map<string, string[]>(),
	calls: [] as {
		cwd: string
		method: string
		params: Record<string, unknown>
	}[],
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
	screen: {
		source: 'data:image/png;base64,aGVsbG8=',
		width: 1280,
		height: 800,
	},
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
			supportsTurnRetry() {
				return false
			}
			supportsTasks() {
				return false
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
						return {
							sessionId: transport.sessionIds.get(this.cwd) ?? 'claimed-fixture-session',
						}
					case 'namzu/pals/conversations/claim':
						if (transport.claimFailure) throw new Error('Claim rejected')
						transport.claims.set(this.cwd, [
							...(transport.claims.get(this.cwd) ?? []),
							params.sessionId as string,
						])
						return {
							sessionId: params.sessionId,
							palId: pal?.id,
							revision: pal?.revision,
						}
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
					case 'namzu/pals/delete': {
						const current = transport.pals.get(params.id as string)
						if (!current || current.revision !== params.expectedRevision)
							throw new Error('Pal revision changed')
						transport.pals.delete(current.id)
						return { id: current.id, deleted: true }
					}
					case 'namzu/conversations/archive':
						return { sessionId: params.sessionId, archived: true }
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
const nativePlatform = process.platform
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
	vi.restoreAllMocks()
	Object.defineProperty(process, 'platform', { value: nativePlatform })
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
	const provider = {
		id: 'zen',
		label: 'Zen',
		defaultModel: 'space-bunny-free',
	}
	const catalogue = {
		models: [{ id: provider.defaultModel, label: 'Space Bunny Free' }],
		notice: null,
	}
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/providers/status')
			return {
				available: [provider],
				selected: { id: provider.id, model: provider.defaultModel },
			}
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
		{
			cwd: workspace,
			method: 'namzu/providers/models',
			params: { provider: 'zen' },
		},
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

it('retains the actual workspace setup failure when intentional close follows a saved Pal creation', async () => {
	const { owner, workspace, pal } = fixture()
	transport.requestHook = async (cwd, method) => {
		if (method === 'namzu/pals/create') return pal
		if (cwd === workspace && method === 'namzu/project/status')
			throw new Error('Pal workspace metadata could not be verified')
	}
	transport.closeHook = async (cwd) => {
		if (cwd === workspace)
			transport.instances
				.find((client) => client.cwd === workspace)
				?.emit('closed', new Error('The Namzu connection was closed.'))
	}
	const created = await owner.createPal({ name: pal.name, model: null })
	await expect(owner.openPal(created.id)).rejects.toThrow(
		'Pal workspace metadata could not be verified',
	)
	expect(owner.listProjects()).toMatchObject([
		{
			path: workspace,
			status: 'error',
			error: 'Pal workspace metadata could not be verified',
		},
	])
	expect(await owner.listPals()).toEqual([pal])
	expect(transport.clients.find((client) => client.cwd === workspace)?.closed).toBe(true)
	expect(
		transport.calls.some((call) =>
			['session/new', 'namzu/pals/conversations/claim', 'namzu/pals/computer/start'].includes(
				call.method,
			),
		),
	).toBe(false)
	// An explicit retry reconnects the same saved Pal; creation is not repeated.
	transport.requestHook = undefined
	transport.closeHook = undefined
	const reopened = await owner.openPal(created.id)
	expect(reopened.project.status).toBe('ready')
	expect((await owner.newConversation(reopened.project.id)).palId).toBe(pal.id)
	expect(transport.calls.filter((call) => call.method === 'namzu/pals/create')).toHaveLength(1)
})

it('refuses a Pal opening when its ready connection closes during the held catalogue read', async () => {
	const { owner, workspace, pal } = fixture()
	const entered = deferred()
	const released = deferred()
	transport.requestHook = async (cwd, method) => {
		if (cwd === workspace && method === 'namzu/pals/conversations/list') {
			entered.resolve()
			await released.promise
			return []
		}
	}
	const opening = owner.openPal(pal.id)
	const rejected = expect(opening).rejects.toThrow(
		'Owned Pal transport closed during catalogue read',
	)
	await entered.promise
	transport.instances
		.find((client) => client.cwd === workspace)
		?.emit('closed', new Error('Owned Pal transport closed during catalogue read'))
	released.resolve()
	await rejected
	expect(owner.listProjects()).toMatchObject([
		{
			path: workspace,
			status: 'error',
			error: 'Owned Pal transport closed during catalogue read',
		},
	])
	expect(
		transport.calls.some((call) =>
			['session/new', 'namzu/pals/conversations/claim', 'namzu/pals/computer/start'].includes(
				call.method,
			),
		),
	).toBe(false)
})

it('keeps the approved Windows Pal path spelling through status and claim after matching directory identity', async () => {
	const { owner, workspace, pal } = fixture()
	const canonical = workspace.replace('control', 'CONTROL')
	const identity = await filesystem.lstat(workspace, { bigint: true })
	const {
		realpath: nativeRealpath,
		lstat: nativeLstat,
		stat: nativeStat,
	} = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
	Object.defineProperty(process, 'platform', { value: 'win32' })
	vi.spyOn(filesystem, 'realpath').mockImplementation(async (path, options) => {
		if (path === workspace) return canonical as never
		return nativeRealpath(path, options as never) as never
	})
	vi.spyOn(filesystem, 'lstat').mockImplementation(async (path, options) => {
		if (path === canonical) return identity as never
		return nativeLstat(path, options as never) as never
	})
	vi.spyOn(filesystem, 'stat').mockImplementation(async (path, options) => {
		if (path === canonical) return identity as never
		return nativeStat(path, options as never) as never
	})
	transport.requestHook = async (cwd, method) => {
		if (cwd === canonical && method === 'namzu/project/status')
			throw new Error('Pal workspace has no matching definition.')
	}
	const failed = await owner.openProject(workspace)
	expect(failed).toMatchObject({ path: canonical, status: 'error' })
	transport.requestHook = undefined
	const before = transport.calls.length
	const opened = await owner.openPal(pal.id)
	expect(opened.project.path).toBe(workspace)
	expect(opened.project.id).toBe(failed.id)
	expect(owner.listProjects()).toEqual([opened.project])
	const conversation = await owner.newConversation(opened.project.id)
	expect(conversation.palId).toBe(pal.id)
	expect(
		transport.calls
			.slice(before)
			.filter((call) =>
				['namzu/project/status', 'session/new', 'namzu/pals/conversations/claim'].includes(
					call.method,
				),
			),
	).toEqual([
		{ cwd: workspace, method: 'namzu/project/status', params: {} },
		{ cwd: workspace, method: 'session/new', params: { cwd: workspace } },
		{
			cwd: workspace,
			method: 'namzu/pals/conversations/claim',
			params: { palId: pal.id, sessionId: conversation.id },
		},
	])
})

it('reconnects an errored Windows Pal through its saved path and refuses a removed profile', async () => {
	const { owner, workspace, pal } = fixture()
	const canonical = workspace.replace('control', 'CONTROL')
	const identity = await filesystem.lstat(workspace, { bigint: true })
	const { realpath: nativeRealpath, lstat: nativeLstat } =
		await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
	Object.defineProperty(process, 'platform', { value: 'win32' })
	vi.spyOn(filesystem, 'realpath').mockImplementation(async (path, options) => {
		if (path === workspace) return canonical as never
		return nativeRealpath(path, options as never) as never
	})
	vi.spyOn(filesystem, 'lstat').mockImplementation(async (path, options) => {
		if (path === canonical) return identity as never
		return nativeLstat(path, options as never) as never
	})
	const opened = await owner.openPal(pal.id)
	workspaceClient(workspace).emit('closed', new Error('Disconnected'))
	const before = transport.calls.length
	const reconnected = await owner.reconnect(opened.project.id)
	expect(reconnected).toMatchObject({
		id: opened.project.id,
		path: workspace,
		palId: pal.id,
		status: 'ready',
	})
	expect(owner.listProjects()).toEqual([reconnected])
	expect(transport.clients.filter((client) => client.cwd === workspace)).toHaveLength(2)
	expect(transport.clients.some((client) => client.cwd === canonical)).toBe(false)
	expect(
		transport.calls.slice(before).filter((call) => call.method === 'namzu/project/status'),
	).toEqual([{ cwd: workspace, method: 'namzu/project/status', params: {} }])

	workspaceClient(workspace).emit('closed', new Error('Disconnected again'))
	transport.pals.delete(pal.id)
	await expect(owner.reconnect(opened.project.id)).rejects.toThrow('unavailable')
	expect(owner.listProjects()).toMatchObject([{ id: opened.project.id, status: 'error' }])
	expect(transport.clients.filter((client) => client.cwd === workspace)).toHaveLength(2)
})

it('refuses a differently cased Windows directory that is a different object before connecting a Pal', async () => {
	const { owner, workspace, pal } = fixture()
	const canonical = workspace.replace('control', 'CONTROL')
	const neighbor = join(workspace, 'different-object')
	mkdirSync(neighbor)
	const { realpath: nativeRealpath, lstat: nativeLstat } =
		await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
	const identity = await nativeLstat(neighbor, { bigint: true })
	Object.defineProperty(process, 'platform', { value: 'win32' })
	vi.spyOn(filesystem, 'realpath').mockImplementation(async (path, options) => {
		if (path === workspace) return canonical as never
		return nativeRealpath(path, options as never) as never
	})
	vi.spyOn(filesystem, 'lstat').mockImplementation(async (path, options) => {
		if (path === canonical) return identity as never
		return nativeLstat(path, options as never) as never
	})
	await expect(owner.openPal(pal.id)).rejects.toThrow('workspace identity changed')
	expect(owner.listProjects()).toEqual([])
	expect(
		transport.calls.some((call) =>
			['namzu/project/status', 'session/new', 'namzu/pals/conversations/claim'].includes(
				call.method,
			),
		),
	).toBe(false)
})

it('refuses a Pal control directory alias while ordinary folder opening still resolves it', async () => {
	const { owner, workspace, pal } = fixture()
	const alias = join(workspace, '..', 'alias-control')
	symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
	transport.pals.set(pal.id, { ...pal, workspace: alias })
	await expect(owner.openPal(pal.id)).rejects.toThrow('workspace identity changed')
	expect(owner.listProjects()).toEqual([])
	expect(transport.calls.some((call) => call.method === 'namzu/project/status')).toBe(false)
	const ordinary = await owner.openProject(alias)
	expect(ordinary.path).toBe(await filesystem.realpath(workspace))
	expect(ordinary.status).toBe('ready')
})

it.each(['ordinary', 'foreign', 'untrusted'] as const)(
	'refuses to mark a connection as the captured Pal when status reports %s ownership',
	async (status) => {
		const { owner, workspace, pal } = fixture()
		transport.requestHook = async (cwd, method) => {
			if (cwd === workspace && method === 'namzu/project/status')
				return {
					trusted: status !== 'untrusted',
					...(status === 'ordinary'
						? {}
						: {
								pal: {
									...pal,
									id: status === 'foreign' ? 'other-pal' : pal.id,
								},
							}),
				}
		}
		await expect(owner.openPal(pal.id)).rejects.toThrow('workspace ownership could not be verified')
		expect(
			transport.calls.some((call) =>
				/session\/new|pals\/conversations\/(list|claim)/.test(call.method),
			),
		).toBe(false)
		expect(owner.listProjects()[0]?.palId).toBe(
			status === 'ordinary' ? undefined : status === 'foreign' ? 'other-pal' : pal.id,
		)
	},
)
it.each([
	[undefined, { permissionMode: 'auto' }],
	[{ effort: 'high' }, { effort: 'high', permissionMode: 'auto' }],
	[{ permissionMode: 'prompt' }, { permissionMode: 'prompt' }],
	[{ permissionMode: 'plan' }, { permissionMode: 'plan' }],
] as const)(
	'captures owned Pal defaults and explicit settings for sends and queued drafts (%s)',
	async (options, expected) => {
		const { owner, pal } = fixture()
		const opened = await owner.openPal(pal.id)
		const conversation = await owner.newConversation(opened.project.id)
		const entered = deferred()
		const complete = deferred()
		transport.requestHook = async (_cwd, method) => {
			if (method !== 'session/prompt') return undefined
			entered.resolve()
			await complete.promise
			return { stopReason: 'end_turn' }
		}
		owner.send(conversation.id, 'Work in your computer', options)
		await entered.promise
		try {
			expect(
				transport.calls.find((call) => call.method === 'session/prompt')?.params.options,
			).toEqual(expected)
			owner.send(conversation.id, 'Queued work', options)
			expect(owner.takeQueued(conversation.id)).toBe('Queued work')
			expect(owner.draftSettings(conversation.id)).toEqual({
				options: expected,
			})
		} finally {
			complete.resolve()
		}
	},
)

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
		expect(() => owner.respondPermission(a.id, reviewB.request.id, { outcome: 'approve' })).toThrow(
			'no longer pending',
		)
		expect(() => owner.respondPermission(b.id, reviewA.request.id, { outcome: 'approve' })).toThrow(
			'no longer pending',
		)
		owner.respondPermission(a.id, reviewA.request.id, { outcome: 'approve' })
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
		owner.respondPermission(b.id, reviewB.request.id, { outcome: 'reject' })
		expect(transport.answers.at(-1)).toEqual({
			cwd: other.workspace,
			id: 7,
			// A No from the window is the person's, and the agent is told so.
			result: { outcome: 'reject', declined: {} },
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
	const readiness = Promise.all([
		owner.readyConversation(opened.project.id, conversation.id),
		owner.readyConversation(opened.project.id, conversation.id),
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
	await readiness
	for (const history of await loading)
		expect(history.thread).toMatchObject({
			messages: [],
			running: false,
			permissions: [],
		})
	expect(transport.calls.filter((call) => call.method === 'session/new')).toHaveLength(1)
	expect(
		transport.calls.filter((call) => call.method === 'namzu/pals/conversations/claim'),
	).toHaveLength(1)
	expect(transport.calls.filter((call) => call.method === 'session/prompt')).toEqual([])
	expect(transport.claims.get(pal.workspace)).toEqual([conversation.id])
})
it('rejects an invalid screenshot before forwarding image content to the renderer', async () => {
	const { owner, pal } = fixture()
	await expect(owner.palScreen(pal.id)).resolves.toMatchObject({
		width: 1280,
		height: 800,
	})
	const original = transport.screen
	try {
		transport.screen = {
			source: 'https://untrusted.invalid/screen.png',
			width: 1280,
			height: 800,
		}
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
			return {
				status: 'ready',
				generation: '2',
				control: { supported: true, mode: 'pal' },
			}
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
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode },
			}
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
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode },
			}
		}
		if (method === 'namzu/pals/computer/return_control') {
			mode = 'pal'
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode },
			}
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
	expect(() =>
		owner.respondPermission(conversation.id, 'guest-review', {
			outcome: 'approve',
		}),
	).toThrow('Return this Pal computer')
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
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'pal' },
			}
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
			return {
				status: 'ready',
				generation: '7',
				control: { supported: true, mode: 'operator' },
			}
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
		params: {
			palId: pal.id,
			generation: '7',
			input: { type: 'key', keys: 'A' },
		},
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
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'operator' },
			}
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
	}
	await owner.palComputer(pal.id)
	expect(() =>
		owner.respondPermission(conversation.id, 'guest-review', {
			outcome: 'approve',
		}),
	).toThrow('Return this Pal computer')
	await owner.stopPalComputer(pal.id)
	expect(() => owner.send(conversation.id, 'Fresh admission')).not.toThrow()
})
it('admits operator-held conversation text while keeping guest tool approvals fenced', async () => {
	const settled = deferred()
	const { owner, pal } = fixture((event) => {
		if (event.kind === 'state' && !event.running) settled.resolve()
	})
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'operator' },
			}
		if (method === 'session/prompt') return { stopReason: 'end_turn' }
	}
	await owner.palComputer(pal.id)
	expect(() =>
		owner.respondPermission(conversation.id, 'guest-review', {
			outcome: 'approve',
		}),
	).toThrow('Return this Pal computer')
	owner.send(conversation.id, 'Just chat with me')
	await settled.promise
	expect(transport.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/start')).toBe(false)
	expect(transport.calls.some((call) => call.method === 'namzu/pals/computer/return_control')).toBe(
		false,
	)
	expect(() =>
		owner.respondPermission(conversation.id, 'guest-review', {
			outcome: 'approve',
		}),
	).toThrow('Return this Pal computer')
})

it('rejects stale model settings after an owned same-route selection and admits a fresh read', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const entered = deferred()
	const response = deferred()
	const settings = { effortLevels: ['low', 'high'], effortDefault: 'low' }
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/providers/settings') {
			entered.resolve()
			await response.promise
			return settings
		}
	}
	const stale = owner.modelSettings(opened.project.id, 'zen', 'selected', conversation.id)
	const rejected = expect(stale).rejects.toBeInstanceOf(SupersededConversationSettingsError)
	await entered.promise
	await owner.selectProvider(conversation.id, 'zen', 'selected')
	response.resolve()
	await rejected
	await expect(
		owner.modelSettings(opened.project.id, 'zen', 'selected', conversation.id),
	).resolves.toEqual(settings)
})

it('keeps connection closure a genuine failure even if settings also changed during a metadata read', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const entered = deferred()
	const response = deferred()
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/providers/settings') {
			entered.resolve()
			await response.promise
			return {}
		}
	}
	const outcome = owner.modelSettings(opened.project.id, 'zen', 'selected', conversation.id).then(
		(value) => ({ value, error: undefined }),
		(error: unknown) => ({ value: undefined, error }),
	)
	await entered.promise
	await owner.selectProvider(conversation.id, 'zen', 'selected')
	await owner.close()
	response.resolve()
	const result = await outcome
	expect(result.value).toBeUndefined()
	expect(result.error).toBeInstanceOf(Error)
	expect(result.error).not.toBeInstanceOf(SupersededConversationSettingsError)
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
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'pal' },
			}
		}
		if (method === 'namzu/pals/computer/take_over')
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'operator' },
			}
	}
	const stale = owner.palComputer(pal.id)
	await statusEntered.promise
	await owner.takeOverPalComputer(pal.id, '1')
	oldStatusDone.resolve()
	await stale
	expect(() =>
		owner.respondPermission(conversation.id, 'guest-review', {
			outcome: 'approve',
		}),
	).toThrow('Return this Pal computer')
})

it('reuses only an owned ready Pal input connection without reloading metadata or conversations', async () => {
	const { owner, pal, workspace } = fixture()
	await owner.openPal(pal.id)
	let mode = 'operator'
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return {
				status: 'ready',
				generation: '8',
				control: { supported: true, mode },
			}
		if (method === 'namzu/pals/computer/input') return { type: 'ok' }
	}
	const before = transport.calls.length
	await owner.palComputerInput(pal.id, '8', { type: 'key', keys: 'CTRL+l' })
	await owner.palComputerInput(pal.id, '8', {
		type: 'type_text',
		text: 'Owned guest text',
	})
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
			return {
				status: 'ready',
				generation: '9',
				control: { supported: true, mode: 'operator' },
			}
		if (method === 'namzu/pals/computer/input') return { type: 'ok' }
	}
	const before = transport.calls.length
	await owner.palComputerInput(pal.id, '9', { type: 'key', keys: 'A' })
	expect(workspaceClient(workspace)).not.toBe(old)
	expect(transport.clients.filter((client) => client.cwd === workspace)).toHaveLength(2)
	expect(transport.calls.slice(before).map((call) => call.method)).toContain('namzu/pals/get')
	expect(
		transport.calls.filter((call) => call.method === 'namzu/pals/computer/input').at(-1),
	).toMatchObject({
		cwd: workspace,
		params: { palId: pal.id, generation: '9' },
	})
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
				return {
					status: 'ready',
					generation: '12',
					control: { supported: true, mode: 'operator' },
				}
			}
			return {
				status: 'ready',
				generation: '12',
				control: { supported: true, mode },
			}
		}
		if (method === 'namzu/pals/computer/return_control') {
			mode = 'pal'
			return {
				status: 'ready',
				generation: '12',
				control: { supported: true, mode },
			}
		}
		if (method === 'namzu/pals/computer/take_over') {
			mode = 'operator'
			return {
				status: 'ready',
				generation: '12',
				control: { supported: true, mode },
			}
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
			params: {
				palId: pal.id,
				generation: '12',
				input: { type: 'key', keys: 'ENTER' },
			},
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
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'pal' },
			}
		if (method === 'namzu/pals/computer/take_over')
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'operator' },
			}
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
			return {
				status: 'ready',
				generation,
				control: { supported: true, mode },
			}
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
		if (method === 'namzu/pals/computer/start') {
			generation = '6'
			mode = 'pal'
			return {
				status: 'ready',
				generation,
				control: { supported: true, mode },
			}
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
		{
			cwd: workspace,
			method: 'namzu/pals/computer/stop',
			params: { palId: pal.id },
		},
		{
			cwd: workspace,
			method: 'namzu/pals/computer/start',
			params: { palId: pal.id },
		},
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
				return {
					status: 'ready',
					generation: '1',
					control: { supported: true, mode: 'operator' },
				}
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
		expect(() =>
			owner.respondPermission(conversation.id, 'guest-review', {
				outcome: 'approve',
			}),
		).toThrow('Return this Pal computer')
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

it('deletes only after owned guest and runtime cleanup, retiring its cached views without deleting workspace bytes', async () => {
	const events: DesktopEvent[] = []
	const { proxy, views } = fakeStreamProxy()
	const { owner, pal, workspace } = fixture((event) => events.push(event), proxy)
	writeFileSync(join(workspace, 'preserved.txt'), 'Keep the workspace and journal data')
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	transport.requestHook = async (cwd, method) => {
		if (method === 'namzu/pals/computer/status')
			return {
				status: 'ready',
				generation: '1',
				control: { supported: true, mode: 'operator' },
			}
		if (method === 'namzu/pals/computer/stream') return { generation: '1' }
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
		if (method === 'namzu/pals/delete') {
			expect(cwd).not.toBe(workspace)
			expect(
				transport.clients
					.filter((client) => client.cwd === workspace)
					.every((client) => client.closed),
			).toBe(true)
		}
	}
	const viewer = await owner.openPalComputerStream(pal.id, '1')
	const before = transport.calls.length
	expect(await owner.deletePal(pal.id, pal.revision)).toEqual({
		id: pal.id,
		deleted: true,
	})
	expect(views.has(viewer.id)).toBe(false)
	expect(owner.listProjects()).toEqual([])
	expect(await owner.listPals()).toEqual([])
	expect(readFileSync(join(workspace, 'preserved.txt'), 'utf8')).toBe(
		'Keep the workspace and journal data',
	)
	expect(events.filter((event) => event.kind === 'pal-deleted')).toEqual([
		{
			kind: 'pal-deleted',
			palId: pal.id,
			projectIds: [opened.project.id],
			sessionIds: [conversation.id],
		},
	])
	const calls = transport.calls.slice(before)
	expect(calls.findIndex((call) => call.method === 'namzu/pals/computer/stop')).toBeLessThan(
		calls.findIndex((call) => call.method === 'namzu/pals/delete'),
	)
	expect(calls.filter((call) => call.method === 'namzu/pals/computer/stop')).toEqual([
		{
			cwd: workspace,
			method: 'namzu/pals/computer/stop',
			params: { palId: pal.id },
		},
	])
	await expect(owner.openPal(pal.id)).rejects.toThrow('deleted')
	await expect(owner.startPalComputer(pal.id)).rejects.toThrow('deleted')
	await expect(owner.deletePal(pal.id, pal.revision)).resolves.toEqual({
		id: pal.id,
		deleted: true,
	})
	expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
})

it('rejects stale deletion revision before any guest stop or metadata deletion', async () => {
	const { owner, pal } = fixture()
	await owner.openPal(pal.id)
	await expect(owner.deletePal(pal.id, pal.revision + 1)).rejects.toThrow('changed')
	expect(transport.calls.some((call) => /computer\/stop$|pals\/delete$/.test(call.method))).toBe(
		false,
	)
})

it.each(['throw', 'ready', 'recovery'])(
	'keeps the profile and viewer when deletion cleanup is %s',
	async (outcome) => {
		const events: DesktopEvent[] = []
		const { proxy, views } = fakeStreamProxy()
		const { owner, pal } = fixture((event) => events.push(event), proxy)
		await owner.openPal(pal.id)
		transport.requestHook = async (_cwd, method) => {
			if (method === 'namzu/pals/computer/status') return { status: 'ready', generation: '1' }
			if (method === 'namzu/pals/computer/stream') return { generation: '1' }
			if (method === 'namzu/pals/computer/stop') {
				if (outcome === 'throw') throw new Error('Stop not confirmed')
				return outcome === 'ready' ? { status: 'ready' } : { status: 'stopped', requiresStop: true }
			}
		}
		const viewer = await owner.openPalComputerStream(pal.id, '1')
		await expect(owner.deletePal(pal.id, pal.revision)).rejects.toThrow(
			/not confirmed|did not confirm/,
		)
		expect(transport.pals.get(pal.id)).toEqual(pal)
		expect(views.has(viewer.id)).toBe(true)
		expect(transport.calls.some((call) => call.method === 'namzu/pals/delete')).toBe(false)
		expect(events.some((event) => event.kind === 'pal-deleted')).toBe(false)
	},
)

it('refuses profile deletion when owned runtime cleanup fails after guest stop', async () => {
	const { owner, pal, workspace } = fixture()
	await owner.openPal(pal.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
	}
	transport.closeHook = async (cwd) => {
		if (cwd === workspace) throw new Error('Owned runtime closure unconfirmed')
	}
	await expect(owner.deletePal(pal.id, pal.revision)).rejects.toThrow('closure unconfirmed')
	expect(transport.pals.get(pal.id)).toEqual(pal)
	expect(transport.calls.some((call) => call.method === 'namzu/pals/delete')).toBe(false)
})

it.each([
	[{ id: 'job', status: 'running' }],
	[{ id: 'job', status: 'killed', recoveryRequired: true }],
	{ unknown: true },
])('checks uncached claimed background work before deleting ($0)', async (jobs) => {
	const { owner, pal, workspace } = fixture()
	transport.claims.set(workspace, ['unopened-durable-session'])
	await owner.openPal(pal.id)
	transport.requestHook = async (_cwd, method, params) => {
		if (method === 'namzu/jobs/list') {
			expect(params.sessionId).toBe('unopened-durable-session')
			return jobs
		}
	}
	await expect(owner.deletePal(pal.id, pal.revision)).rejects.toThrow('background work')
	expect(transport.calls.some((call) => /computer\/stop$|pals\/delete$/.test(call.method))).toBe(
		false,
	)
})

it('fences fresh mutations throughout deletion and retries an uncertain metadata receipt without reopening a guest', async () => {
	const events: DesktopEvent[] = []
	const { owner, pal } = fixture((event) => events.push(event))
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const stopEntered = deferred()
	const stopDone = deferred()
	let uncertain = true
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/stop') {
			stopEntered.resolve()
			await stopDone.promise
			return { status: 'stopped' }
		}
		if (method === 'namzu/pals/delete' && uncertain) return { id: pal.id, deleted: false }
	}
	const deletion = owner.deletePal(pal.id, pal.revision)
	await stopEntered.promise
	expect(() => owner.send(conversation.id, 'Concurrent prompt')).toThrow('changes to finish')
	await expect(owner.newConversation(opened.project.id)).rejects.toThrow('changes to finish')
	await expect(owner.openPal(pal.id)).rejects.toThrow('changes to finish')
	await expect(owner.startPalComputer(pal.id)).rejects.toThrow('changes to finish')
	const rejected = expect(deletion).rejects.toThrow('not confirmed')
	stopDone.resolve()
	await rejected
	expect(events.some((event) => event.kind === 'pal-deleted')).toBe(false)
	expect(() => owner.send(conversation.id, 'Unknown deletion outcome')).toThrow(
		'needs confirmation',
	)
	await expect(owner.startPalComputer(pal.id)).rejects.toThrow('needs confirmation')
	await expect(owner.deletePal(pal.id, pal.revision + 1)).rejects.toThrow('changed')
	uncertain = false
	await expect(owner.deletePal(pal.id, pal.revision)).resolves.toEqual({
		id: pal.id,
		deleted: true,
	})
	expect(transport.calls.filter((call) => call.method === 'namzu/pals/computer/stop')).toHaveLength(
		1,
	)
	expect(events.filter((event) => event.kind === 'pal-deleted')).toHaveLength(1)
})

it.each(['start', 'new-conversation'])(
	'refuses deletion while %s was already admitted',
	async (operation) => {
		const { owner, pal } = fixture()
		const opened = await owner.openPal(pal.id)
		const entered = deferred()
		const released = deferred()
		transport.requestHook = async (_cwd, method) => {
			if (method === (operation === 'start' ? 'namzu/pals/computer/start' : 'session/new')) {
				entered.resolve()
				await released.promise
				if (operation === 'start') return { status: 'ready', generation: '1' }
			}
		}
		const admitted =
			operation === 'start'
				? owner.startPalComputer(pal.id)
				: owner.newConversation(opened.project.id)
		await entered.promise
		await expect(owner.deletePal(pal.id, pal.revision)).rejects.toThrow('connection or settings')
		expect(transport.calls.some((call) => /computer\/stop$|pals\/delete$/.test(call.method))).toBe(
			false,
		)
		released.resolve()
		await admitted
	},
)

it('rejects Pal deletion during asynchronous prompt admission before any provider request', async () => {
	const { owner, pal, workspace } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	const client = workspaceClient(workspace) as unknown as Pick<RuntimeClient, 'supportsTurnRetry'>
	vi.spyOn(client, 'supportsTurnRetry').mockReturnValue(true)
	const entered = deferred()
	const released = deferred()
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/sessions/retry-status') {
			entered.resolve()
			await released.promise
			return { notice: 'Retry required' }
		}
	}
	const sending = Promise.resolve(owner.send(conversation.id, 'Unadmitted prompt'))
	const rejectedSending = expect(sending).rejects.toThrow('Retry required')
	await entered.promise
	await expect(owner.deletePal(pal.id, pal.revision)).rejects.toThrow('active work')
	expect(
		transport.calls.some((call) =>
			/computer\/stop$|pals\/delete$|session\/prompt$/.test(call.method),
		),
	).toBe(false)
	released.resolve()
	await rejectedSending
})

it('removes an unopened durable Recent only after exact owned archive acknowledgement without loading a model', async () => {
	const events: DesktopEvent[] = []
	const { owner, pal, workspace } = fixture((event) => events.push(event))
	transport.claims.set(workspace, ['closed-durable-chat'])
	const opened = await owner.openPal(pal.id)
	const before = transport.calls.length
	expect(await owner.removeConversation('closed-durable-chat')).toEqual({
		sessionId: 'closed-durable-chat',
		removed: true,
		archived: true,
	})
	expect(await owner.listConversations(opened.project.id)).toEqual([])
	expect(events.filter((event) => event.kind === 'conversation-removed')).toEqual([
		{
			kind: 'conversation-removed',
			sessionId: 'closed-durable-chat',
			projectId: opened.project.id,
			archived: true,
		},
	])
	expect(
		transport.calls
			.slice(before)
			.filter((call) => /session\/(new|load|prompt)|providers\//.test(call.method)),
	).toEqual([])
	await expect(owner.openConversation(opened.project.id, 'closed-durable-chat')).rejects.toThrow(
		'no longer',
	)
})

const OWNERSHIP = 'This conversation does not belong to this project.'
const IDENTITY = 'This conversation was saved by a different Namzu identity.'
it.each([
	['its journal is gone', 'missing'],
	['it was saved under another identity', 'identity'],
])('removes a restored row whose journal cannot be opened when %s', async (_name, kind) => {
	const { owner, pal, workspace } = fixture()
	transport.claims.set(workspace, ['dead-row-chat'])
	const opened = await owner.openPal(pal.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/jobs/list') throw new Error(OWNERSHIP)
		if (method === 'namzu/conversations/archive') {
			if (kind === 'identity') throw new Error(IDENTITY)
			return { sessionId: 'dead-row-chat', archived: false, missing: true }
		}
	}
	expect(await owner.removeConversation('dead-row-chat')).toEqual({
		sessionId: 'dead-row-chat',
		removed: true,
		archived: false,
	})
	expect(await owner.listConversations(opened.project.id)).toEqual([])
})

it('still refuses a conversation id the host calls foreign when archiving it', async () => {
	const { owner, pal, workspace } = fixture()
	transport.claims.set(workspace, ['foreign-row-chat'])
	const opened = await owner.openPal(pal.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/jobs/list') throw new Error(OWNERSHIP)
		if (method === 'namzu/conversations/archive') throw new Error(OWNERSHIP)
	}
	await expect(owner.removeConversation('foreign-row-chat')).rejects.toThrow(OWNERSHIP)
	expect((await owner.listConversations(opened.project.id)).map((c) => c.id)).toEqual([
		'foreign-row-chat',
	])
})

it.each(['unknown', 'foreign', 'missing', 'throws'])(
	'keeps a durable conversation and its draft when archive returns %s',
	async (outcome) => {
		const events: DesktopEvent[] = []
		const { owner, pal } = fixture((event) => events.push(event))
		const opened = await owner.openPal(pal.id)
		const conversation = await owner.newConversation(opened.project.id)
		owner.saveDraft(conversation.id, 'Retained authored text')
		transport.requestHook = async (_cwd, method) => {
			if (method !== 'namzu/conversations/archive') return
			if (outcome === 'throws') throw new Error('Corrupt/foreign journal refused')
			if (outcome === 'missing')
				return { sessionId: conversation.id, archived: false, missing: true }
			return {
				sessionId: outcome === 'foreign' ? 'another-session' : conversation.id,
				archived: outcome === 'foreign',
			}
		}
		await expect(owner.removeConversation(conversation.id)).rejects.toThrow(
			outcome === 'throws' ? 'journal refused' : 'not confirmed',
		)
		expect(events.some((event) => event.kind === 'conversation-removed')).toBe(false)
		expect(
			(await owner.listConversations(opened.project.id)).some(
				(view) => view.id === conversation.id,
			),
		).toBe(true)
		expect(() => owner.send(conversation.id, 'Unknown archive outcome')).toThrow(
			'removal to finish',
		)
		transport.requestHook = undefined
		await expect(owner.removeConversation(conversation.id)).resolves.toMatchObject({
			removed: true,
			archived: true,
		})
	},
)

it('removes only a known never-prompted local draft after strict missing receipt without claiming a durable archive', async () => {
	const events: DesktopEvent[] = []
	const { owner, workspace } = fixture((event) => events.push(event))
	const ordinary = join(workspace, 'ordinary-project')
	mkdirSync(ordinary)
	const project = await owner.openProject(ordinary)
	const conversation = await owner.newConversation(project.id)
	owner.saveDraft(conversation.id, 'Local unsent draft')
	transport.requestHook = async (_cwd, method, params) => {
		if (method === 'namzu/conversations/archive')
			return { sessionId: params.sessionId, archived: false, missing: true }
	}
	const before = transport.calls.length
	expect(await owner.removeConversation(conversation.id)).toEqual({
		sessionId: conversation.id,
		removed: true,
		archived: false,
	})
	expect(events.filter((event) => event.kind === 'conversation-removed')).toEqual([
		{
			kind: 'conversation-removed',
			sessionId: conversation.id,
			projectId: project.id,
			archived: false,
		},
	])
	expect(
		transport.calls
			.slice(before)
			.some((call) => /session\/(new|load|prompt)|jobs\/list/.test(call.method)),
	).toBe(false)
	expect(() => owner.draft(conversation.id)).toThrow('Open this conversation')
	await expect(owner.removeConversation(conversation.id)).resolves.toEqual({
		sessionId: conversation.id,
		removed: true,
		archived: false,
	})
})

it('does not archive a conversation with unconfirmed background termination', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/jobs/list') return [{ status: 'killed', recoveryRequired: true }]
	}
	await expect(owner.removeConversation(conversation.id)).rejects.toThrow('background work')
	expect(transport.calls.some((call) => call.method === 'namzu/conversations/archive')).toBe(false)
	expect(() => owner.draft(conversation.id)).not.toThrow()
})

it.each([true, false])(
	'checks both stable and replacement unsent aliases before removal (durable original: %s)',
	async (durableOriginal) => {
		const { owner, workspace } = fixture()
		const ordinary = join(workspace, 'ordinary-project')
		mkdirSync(ordinary)
		const project = await owner.openProject(ordinary)
		const conversation = await owner.newConversation(project.id)
		owner.saveDraft(conversation.id, 'Unsent text survives replacement')
		workspaceClient(ordinary).emit('closed', new Error('Disconnected'))
		await owner.reconnect(project.id)
		transport.sessionIds.set(ordinary, 'replacement-slot')
		transport.requestHook = async (_cwd, method) => {
			if (method === 'namzu/providers/status') return { available: [], selected: null }
		}
		await owner.providers(project.id, conversation.id)
		transport.requestHook = async (_cwd, method, params) => {
			if (method === 'namzu/conversations/archive')
				return params.sessionId === conversation.id && durableOriginal
					? { sessionId: params.sessionId, archived: true }
					: { sessionId: params.sessionId, archived: false, missing: true }
		}
		const before = transport.calls.length
		expect(await owner.removeConversation(conversation.id)).toEqual({
			sessionId: conversation.id,
			removed: true,
			archived: durableOriginal,
		})
		const removalCalls = transport.calls.slice(before)
		expect(removalCalls.filter((call) => call.method === 'namzu/conversations/archive')).toEqual([
			{
				cwd: ordinary,
				method: 'namzu/conversations/archive',
				params: { sessionId: conversation.id },
			},
			{
				cwd: ordinary,
				method: 'namzu/conversations/archive',
				params: { sessionId: 'replacement-slot' },
			},
		])
		expect(
			removalCalls.some((call) =>
				/session\/(new|load|prompt)|jobs\/list|providers\//.test(call.method),
			),
		).toBe(false)
	},
)

it('fences Pal deletion after an unconfirmed conversation removal until removal is retried', async () => {
	const { owner, pal } = fixture()
	const opened = await owner.openPal(pal.id)
	const conversation = await owner.newConversation(opened.project.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/conversations/archive') return { sessionId: conversation.id }
	}
	await expect(owner.removeConversation(conversation.id)).rejects.toThrow('not confirmed')
	await expect(owner.deletePal(pal.id, pal.revision)).rejects.toThrow('settings change')
	expect(transport.calls.some((call) => /computer\/stop$|pals\/delete$/.test(call.method))).toBe(
		false,
	)
	transport.requestHook = undefined
	await owner.removeConversation(conversation.id)
	transport.requestHook = async (_cwd, method) => {
		if (method === 'namzu/pals/computer/stop') return { status: 'stopped' }
	}
	await expect(owner.deletePal(pal.id, pal.revision)).resolves.toEqual({
		id: pal.id,
		deleted: true,
	})
})

it.each([true, false])(
	'does not resurrect an unopened Recent from delayed history after removal (confirmed: %s)',
	async (confirmed) => {
		const { owner, pal, workspace } = fixture()
		const id = 'cold-retirement'
		transport.claims.set(workspace, [id])
		const opened = await owner.openPal(pal.id)
		const entered = deferred()
		const release = deferred()
		transport.requestHook = async (_cwd, method) => {
			if (method === 'namzu/conversations/history') {
				entered.resolve()
				await release.promise
				return {
					messages: [{ role: 'assistant', text: 'Historical answer' }],
					partial: false,
				}
			}
			if (method === 'namzu/conversations/archive' && !confirmed) return { sessionId: id }
		}
		const opening = owner.openConversation(opened.project.id, id)
		const rejection = expect(opening).rejects.toThrow(confirmed ? 'no longer' : 'removal to finish')
		await entered.promise
		if (confirmed) await owner.removeConversation(id)
		else await expect(owner.removeConversation(id)).rejects.toThrow('not confirmed')
		release.resolve()
		await rejection
		expect(() => owner.draft(id)).toThrow('Open this conversation')
		const requests = transport.calls.filter(
			(call) => call.method === 'namzu/conversations/history',
		).length
		await expect(owner.openConversation(opened.project.id, id)).rejects.toThrow(
			confirmed ? 'no longer' : 'removal to finish',
		)
		expect(
			transport.calls.filter((call) => call.method === 'namzu/conversations/history'),
		).toHaveLength(requests)
	},
)

const created = (name: string, id: string): PalView => ({
	id,
	name,
	purpose: '',
	workspace: `/pals/${id}`,
	revision: 1,
	model: null,
	paused: false,
	createdAt: '2026-10-09T00:00:00Z',
	updatedAt: '2026-10-09T00:00:00Z',
})
const createCalls = () => transport.calls.filter((call) => call.method === 'namzu/pals/create')

it('makes one Pal when the same create attempt arrives twice while the first is running', async () => {
	const { owner } = fixture()
	let release: (() => void) | undefined
	let made = 0
	transport.requestHook = async (_cwd, method) => {
		if (method !== 'namzu/pals/create') return undefined
		made += 1
		await new Promise<void>((resolve) => {
			release = resolve
		})
		return created('pamir', `pal-${made}`)
	}
	const first = owner.createPal({ name: 'pamir', requestId: 'attempt-1' })
	const second = owner.createPal({ name: 'pamir', requestId: 'attempt-1' })
	await vi.waitFor(() => expect(release).toBeDefined())
	release?.()
	const [one, two] = await Promise.all([first, second])
	expect(one.id).toBe('pal-1')
	expect(two).toBe(one)
	expect(createCalls()).toHaveLength(1)
})

it('returns the finished Pal for a repeated attempt and does not send the attempt id on', async () => {
	const { owner } = fixture()
	transport.requestHook = async (_cwd, method) =>
		method === 'namzu/pals/create' ? created('pamir', 'pal-1') : undefined
	const one = await owner.createPal({ name: 'pamir', requestId: 'attempt-1' })
	const again = await owner.createPal({ name: 'pamir', requestId: 'attempt-1' })
	expect(again).toBe(one)
	expect(createCalls()).toHaveLength(1)
	expect(createCalls()[0]?.params).toEqual({ name: 'pamir' })
})

it('does not remember a failed attempt, so the same attempt can be retried', async () => {
	const { owner } = fixture()
	let calls = 0
	transport.requestHook = async (_cwd, method) => {
		if (method !== 'namzu/pals/create') return undefined
		calls += 1
		if (calls === 1) throw new Error('The Namzu connection was closed.')
		return created('pamir', 'pal-1')
	}
	await expect(owner.createPal({ name: 'pamir', requestId: 'attempt-1' })).rejects.toThrow('closed')
	expect((await owner.createPal({ name: 'pamir', requestId: 'attempt-1' })).id).toBe('pal-1')
})

it('refuses a second Pal whose name differs only by case or the Turkish i', async () => {
	const { owner } = fixture()
	transport.requestHook = async (_cwd, method) =>
		method === 'namzu/pals/create' ? created('Isık', 'pal-1') : undefined
	await owner.createPal({ name: 'Isık', requestId: 'a' })
	await expect(owner.createPal({ name: ' ISIK ', requestId: 'b' })).rejects.toThrow(
		'You already have a Pal called “ISIK”. Try “ISIK 2”.',
	)
	expect(createCalls()).toHaveLength(1)
})

it('names a Pal’s own folder to reveal, from its record and never from a caller path', async () => {
	const { owner, pal, workspace } = fixture()
	await owner.listPals()
	expect(await owner.palFolder(pal.id)).toBe(realpathSync(workspace))
	await expect(owner.palFolder('')).rejects.toThrow('Invalid Pal')
	rmSync(workspace, { recursive: true, force: true })
	await expect(owner.palFolder(pal.id)).rejects.toThrow('does not exist')
})
