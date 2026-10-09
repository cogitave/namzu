import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopDiagnosticContext, DesktopDiagnosticEvent } from './diagnostics.js'
import { Operator } from './operator.js'
import { RuntimeClient } from './rpc-client.js'

const owners: Operator[] = []
const dirs: string[] = []
const realRequest = RuntimeClient.prototype.request
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	vi.restoreAllMocks()
	await Promise.all(dirs.map((path) => rm(path, { recursive: true, force: true })))
	dirs.length = 0
})
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
async function fixture(unsupported = false, extraEnv: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-pal-communication-'))
	dirs.push(root)
	const workspace = join(root, 'pal')
	await mkdir(workspace)
	const calls: { method: string; params: unknown }[] = []
	const logs: { event: DesktopDiagnosticEvent; context?: DesktopDiagnosticContext }[] = []
	let client!: RuntimeClient
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		if (this.cwd === workspace) client = this
		calls.push({ method, params })
		return realRequest.call(this, method, params, timeout)
	})
	const owner = new Operator(
		{
			program: process.execPath,
			args: [
				fileURLToPath(new URL('./__fixtures__/rpc-pal-communication-process.mjs', import.meta.url)),
			],
			env: {
				...process.env,
				FIXTURE_PAL_WORKSPACE: workspace,
				...(unsupported ? { FIXTURE_NO_COMMUNICATION: '1' } : {}),
				...extraEnv,
			},
		},
		() => {},
		join(root, 'registry'),
		{
			record: (event, context) => {
				logs.push({ event, context })
			},
		},
	)
	owners.push(owner)
	const opened = await owner.openPal('one')
	const session = await owner.newConversation(opened.project.id)
	return { owner, session, calls, logs, client: () => client, project: opened.project }
}
it('manages only explicit outgoing consent and exact original subscriptions without starting work or changing draft/settings', async () => {
	const { owner, session, calls } = await fixture()
	owner.saveDraft(session.id, 'Keep this draft')
	owner.saveDraftSettings(session.id, { options: { permissionMode: 'auto' } })
	const first = await owner.palCommunication(session.id, 'one')
	expect(first.peers[0]?.incoming.enabled).toBe(false)
	expect(JSON.stringify(first)).not.toContain('PRIVATE')
	const granted = await owner.updatePalPermission(session.id, 'one', {
		snapshotId: first.snapshotId,
		peerPalId: 'two',
		enabled: true,
		allowWake: false,
	})
	expect(granted.peers[0]?.outgoing).toEqual({ revision: 1, enabled: true, allowWake: false })
	expect(granted.peers[0]?.incoming.enabled).toBe(false)
	const observed = await owner.createPalSubscription(session.id, 'one', {
		snapshotId: granted.snapshotId,
		sourcePalId: 'two',
		sourceSessionId: 'original-two',
		recipientPalId: 'one',
		wake: false,
	})
	expect(observed.subscriptions[0]).toMatchObject({
		sourceProfileRevision: 2,
		enabled: true,
		permission: { wake: false },
		progress: { lastSequence: null },
	})
	const row = observed.subscriptions[0]
	if (!row) throw new Error('Missing subscription')
	const disabled = await owner.disablePalSubscription(session.id, 'one', {
		snapshotId: observed.snapshotId,
		subscriptionId: row.id,
	})
	expect(disabled.subscriptions[0]).toMatchObject({ enabled: false, revision: 2 })
	expect(calls.find(({ method }) => method.endsWith('/subscriptions/disable'))?.params).toEqual({
		palId: 'one',
		id: row.id,
		expectedRevision: 1,
	})
	expect(await owner.draft(session.id)).toBe('Keep this draft')
	expect(await owner.draftSettings(session.id)).toEqual({ options: { permissionMode: 'auto' } })
	expect(
		calls.filter(({ method }) => method === 'session/prompt' || method.includes('/computer/')),
	).toEqual([])
})
it('rejects foreign session/Pal, stale snapshots and unlisted source conversations before metadata writes', async () => {
	const { owner, session, calls } = await fixture()
	await expect(owner.palCommunication(session.id, 'two')).rejects.toThrow('changed')
	await expect(owner.palCommunication('missing', 'one')).rejects.toThrow('first')
	const old = await owner.palCommunication(session.id, 'one')
	const fresh = await owner.palCommunication(session.id, 'one')
	await expect(
		owner.updatePalPermission(session.id, 'one', {
			snapshotId: old.snapshotId,
			peerPalId: 'two',
			enabled: true,
			allowWake: false,
		}),
	).rejects.toThrow('refresh')
	await expect(
		owner.createPalSubscription(session.id, 'one', {
			snapshotId: fresh.snapshotId,
			sourcePalId: 'two',
			sourceSessionId: 'foreign-log',
			recipientPalId: 'one',
			wake: false,
		}),
	).rejects.toThrow('listed')
	expect(
		calls.filter(
			({ method }) =>
				method.endsWith('/permissions/update') || method.endsWith('/subscriptions/create'),
		),
	).toEqual([])
})
it('keeps old peers read-only on malformed metadata while independently loading inbox and records no private diagnostic', async () => {
	const { owner, session, client, logs } = await fixture()
	const first = await owner.palCommunication(session.id, 'one')
	const request = client().request.bind(client())
	vi.spyOn(client(), 'request').mockImplementation((method, params, timeout) =>
		method.endsWith('/peers')
			? Promise.resolve({ v: 1, palId: 'foreign', peers: [] })
			: request(method, params, timeout),
	)
	const next = await owner.palCommunication(session.id, 'one')
	expect(next.peers).toEqual(first.peers)
	expect(next.peersNotice).toContain('Unavailable')
	expect(next.messages).toEqual(first.messages)
	expect(logs).toContainEqual(
		expect.objectContaining({
			event: 'cli_notice',
			context: expect.objectContaining({
				operation: 'namzu/pals/communication/peers',
				severity: 'error',
			}),
		}),
	)
	expect(JSON.stringify(logs)).not.toContain('PRIVATE')
	await expect(
		owner.updatePalPermission(session.id, 'one', {
			snapshotId: next.snapshotId,
			peerPalId: 'two',
			enabled: true,
			allowWake: false,
		}),
	).rejects.toThrow('Refresh')
})
it('fences delayed reads across a mutation and consumes the token after an ambiguous write without replay', async () => {
	const { owner, session, client, calls } = await fixture()
	const first = await owner.palCommunication(session.id, 'one')
	const peers = deferred<unknown>()
	const issued = deferred<void>()
	const finish = deferred<unknown>()
	const request = client().request.bind(client())
	vi.spyOn(client(), 'request').mockImplementation((method, params, timeout) => {
		if (method.endsWith('/peers')) return peers.promise
		if (method.endsWith('/permissions/update')) {
			issued.resolve()
			return finish.promise
		}
		return request(method, params, timeout)
	})
	const read = owner.palCommunication(session.id, 'one')
	const readRejected = expect(read).rejects.toThrow('changed')
	const mutation = owner.updatePalPermission(session.id, 'one', {
		snapshotId: first.snapshotId,
		peerPalId: 'two',
		enabled: true,
		allowWake: false,
	})
	const rejected = expect(mutation).rejects.toThrow('could not be confirmed')
	await issued.promise
	await expect(owner.palCommunication(session.id, 'one')).rejects.toThrow('finish')
	peers.resolve({ v: 1, palId: 'one', peers: first.peers })
	await readRejected
	finish.reject(new Error('Unknown PRIVATE'))
	await rejected
	await expect(
		owner.updatePalPermission(session.id, 'one', {
			snapshotId: first.snapshotId,
			peerPalId: 'two',
			enabled: true,
			allowWake: false,
		}),
	).rejects.toThrow('refresh')
	// The interceptor owns the one issued write; no retry reached the actual process.
	expect(calls.filter(({ method }) => method.endsWith('/permissions/update'))).toEqual([])
})

it('refuses Pal deletion while an admitted communication permission change is unsettled', async () => {
	const { owner, session, client, calls } = await fixture()
	const first = await owner.palCommunication(session.id, 'one')
	const entered = deferred<void>()
	const finish = deferred<unknown>()
	const activeClient = client()
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		calls.push({ method, params })
		if (this === activeClient && method.endsWith('/permissions/update')) {
			entered.resolve()
			return finish.promise
		}
		return realRequest.call(this, method, params, timeout)
	})
	const mutation = owner.updatePalPermission(session.id, 'one', {
		snapshotId: first.snapshotId,
		peerPalId: 'two',
		enabled: true,
		allowWake: false,
	})
	const rejection = expect(mutation).rejects.toThrow('could not be confirmed')
	await entered.promise
	try {
		await expect(owner.deletePal('one', 1)).rejects.toThrow('settings change')
		expect(calls.some(({ method }) => /computer\/stop$|pals\/delete$/.test(method))).toBe(false)
	} finally {
		finish.reject(new Error('Ambiguous permission acknowledgement'))
		await rejection
	}
})
it('ignores successful old-client data after the exact Pal project reconnects', async () => {
	const { owner, session, client, project } = await fixture()
	const peers = deferred<unknown>()
	const started = deferred<void>()
	const oldClient = client()
	const request = oldClient.request.bind(oldClient)
	// The fixture spies on the prototype. Give this client its own dispatcher so
	// intercepting the old read cannot replace the prototype for its reconnect.
	Object.defineProperty(oldClient, 'request', {
		configurable: true,
		writable: true,
		value: request,
	})
	vi.spyOn(oldClient, 'request').mockImplementation((method, params, timeout) => {
		if (method.endsWith('/peers')) {
			started.resolve()
			return peers.promise
		}
		return request(method, params, timeout)
	})
	const read = owner.palCommunication(session.id, 'one')
	const rejected = expect(read).rejects.toThrow('changed')
	await started.promise
	const closed = new Promise<void>((resolve) => oldClient.once('closed', () => resolve()))
	const exited = realRequest.call(oldClient, 'test/exit').catch(() => undefined)
	await closed
	await exited
	await owner.reconnect(project.id)
	peers.resolve({ v: 1, palId: 'one', peers: [] })
	await rejected
})
it('honestly handles an older runtime without invoking any unadvertised communication route', async () => {
	const { owner, session, calls } = await fixture(true)
	const view = await owner.palCommunication(session.id, 'one')
	expect(view.supported).toBe(false)
	expect(view.peersNotice).toContain('does not support')
	expect(calls.filter(({ method }) => method.includes('/communication/'))).toEqual([])
})
it('reads the inbox alone without taking the settings dialog’s snapshot, and nothing for an older runtime', async () => {
	const { owner, session, calls } = await fixture()
	const view = await owner.palCommunication(session.id, 'one')
	const rows = await owner.palInbox(session.id, 'one')
	expect(Array.isArray(rows)).toBe(true)
	// The dialog's snapshot stays valid: reading the inbox did not supersede it.
	const peer = view.peers[0]
	if (!peer) throw new Error('Missing peer')
	await expect(
		owner.updatePalPermission(session.id, 'one', {
			snapshotId: view.snapshotId,
			peerPalId: peer.palId,
			enabled: true,
			allowWake: false,
		}),
	).resolves.toBeDefined()
	await expect(owner.palInbox('missing', 'one')).rejects.toThrow('first')
	expect(calls.filter(({ method }) => method.endsWith('/communication/inbox')).length).toBe(3)
})
it('reads no inbox from an older runtime', async () => {
	const { owner, session, calls } = await fixture(true)
	expect(await owner.palInbox(session.id, 'one')).toEqual([])
	expect(calls.filter(({ method }) => method.includes('/communication/'))).toEqual([])
})
it('does not treat an unrelated successful mutation reply as confirmation or automatically repeat it', async () => {
	const { owner, session, client } = await fixture()
	const first = await owner.palCommunication(session.id, 'one')
	const request = client().request.bind(client())
	const writes: unknown[] = []
	vi.spyOn(client(), 'request').mockImplementation((method, params, timeout) => {
		if (method.endsWith('/permissions/update')) {
			writes.push(params)
			return Promise.resolve({
				v: 1,
				palId: 'foreign',
				permission: { revision: 1, enabled: true, allowWake: false },
			})
		}
		return request(method, params, timeout)
	})
	const change = { snapshotId: first.snapshotId, peerPalId: 'two', enabled: true, allowWake: false }
	await expect(owner.updatePalPermission(session.id, 'one', change)).rejects.toThrow(
		'could not be confirmed',
	)
	await expect(owner.updatePalPermission(session.id, 'one', change)).rejects.toThrow('refresh')
	expect(writes).toHaveLength(1)
})

it('starts a Pal only on a click main validates, mints the evidence itself, and starts once for repeated clicks', async () => {
	const { owner, calls } = await fixture()
	const waiting = await owner.palInboxStart('one')
	expect(waiting).toEqual({ v: 1, palId: 'one', waiting: 1, state: 'waiting' })
	// Looking never starts anything.
	expect(calls.some(({ method }) => method === 'namzu/pals/inbox/start')).toBe(false)
	const [first, second] = await Promise.all([
		owner.startPalInbox('one'),
		owner.startPalInbox('one'),
	])
	expect(first.state).toBe('reading')
	expect(second).toEqual(first)
	const starts = calls.filter(({ method }) => method === 'namzu/pals/inbox/start')
	expect(starts).toHaveLength(1)
	const params = starts[0]?.params as { palId: string; clickId: string }
	expect(Object.keys(params).sort()).toEqual(['clickId', 'palId'])
	expect(params.clickId).toMatch(/^[0-9a-f-]{36}$/)
	// No run, no computer call and no prompt came from the start question itself.
	expect(calls.filter(({ method }) => method === 'session/prompt')).toEqual([])
})
it('refuses to start an unknown Pal and an older runtime without starting anything', async () => {
	const { owner, calls } = await fixture()
	await expect(owner.startPalInbox('')).rejects.toThrow('Invalid Pal')
	await expect(owner.startPalInbox('missing')).rejects.toThrow('unavailable')
	expect(calls.some(({ method }) => method === 'namzu/pals/inbox/start')).toBe(false)
	const older = await fixture(false, { FIXTURE_NO_INBOX_START: '1' })
	await expect(older.owner.startPalInbox('one')).rejects.toThrow('Update Namzu')
	expect(older.calls.some(({ method }) => method === 'namzu/pals/inbox/start')).toBe(false)
})
