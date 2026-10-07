import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
function harness(fixture = 'rpc-retry-process.mjs', mode = 'eligible') {
	const events = new EventEmitter()
	const log = join(mkdtempSync(join(tmpdir(), 'namzu-undo-')), 'requests.jsonl')
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL(`./__fixtures__/${fixture}`, import.meta.url))],
			env: { ...process.env, FIXTURE_RETRY_MODE: mode, FIXTURE_REQUEST_LOG: log },
		},
		(event) => events.emit('event', event),
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
	return { owner, wait }
}
const settled = (event: DesktopEvent) => event.kind === 'state' && !event.running
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
const row = (status: string) => ({
	turnId: 'turn-1',
	status,
	files: 2,
	added: 0,
	removed: 0,
	uncoveredShell: false,
	skipped: [],
})
const plan = (token = 'plan-1') => ({
	turnId: 'turn-1',
	status: 'applied',
	planToken: token,
	files: [{ turnId: 'turn-1', path: '/work/a.ts', rel: 'a.ts', action: 'restore' }],
	skipped: [],
	uncoveredShell: false,
	laterTurnsOnSameFiles: [],
})

/** Stands in for the CLI's three methods; every other request reaches the fixture. */
function fakeUndo(handlers: Record<string, (params: unknown) => unknown>) {
	const calls: { method: string; params: unknown }[] = []
	const request = RuntimeClient.prototype.request
	vi.spyOn(RuntimeClient.prototype, 'supportsTurnUndo').mockReturnValue(true)
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		const handler = handlers[method]
		if (!handler) return request.call(this, method, params, timeout)
		calls.push({ method, params })
		return Promise.resolve(handler(params))
	})
	return calls
}
async function settledSession(setup: ReturnType<typeof harness>) {
	const project = await setup.owner.openProject(process.cwd())
	const session = await setup.owner.newConversation(project.id)
	const stopped = setup.wait(settled)
	await setup.owner.send(session.id, 'Build')
	await stopped
	return { project, session }
}

it('reads undo state from the CLI after a turn and after each undo, and stamps the time it saw', async () => {
	let status = 'applied'
	const calls = fakeUndo({
		'namzu/turns/undo-status': () => ({ turns: [row(status)] }),
		'namzu/turns/undo-preview': () => plan(),
		'namzu/turns/undo': () => {
			status = 'undone'
			return { turnId: 'turn-1', status: 'undone', files: { '/work/a.ts': 'restored' } }
		},
	})
	const setup = harness()
	const { project, session } = await settledSession(setup)
	expect((await setup.owner.openConversation(project.id, session.id)).thread?.undo).toMatchObject({
		'turn-1': { status: 'applied', files: 2 },
	})
	await expect(setup.owner.undoPreview(session.id, 'turn-1')).resolves.toMatchObject({
		planToken: 'plan-1',
	})
	const result = await setup.owner.undoTurn(session.id, 'turn-1', 'plan-1', {
		resolutions: { '/work/a.ts': 'keep_copy' },
	})
	expect(result.status).toBe('undone')
	const undo = (await setup.owner.openConversation(project.id, session.id)).thread?.undo
	expect(undo?.['turn-1']?.status).toBe('undone')
	expect(undo?.['turn-1']?.undoneAt).toBeTypeOf('number')
	expect(calls.find((call) => call.method === 'namzu/turns/undo')?.params).toMatchObject({
		turnId: 'turn-1',
		planToken: 'plan-1',
		resolutions: { '/work/a.ts': 'keep_copy' },
	})
	// The write is followed by a fresh status read, never by a local guess.
	const order = calls.map((call) => call.method)
	expect(order.lastIndexOf('namzu/turns/undo-status')).toBeGreaterThan(
		order.indexOf('namzu/turns/undo'),
	)
})

it('holds the prompt queue while an undo is in flight and releases it afterwards', async () => {
	const gate = deferred<unknown>()
	fakeUndo({
		'namzu/turns/undo-status': () => ({ turns: [row('applied')] }),
		'namzu/turns/undo': () => gate.promise,
	})
	const setup = harness()
	const { session } = await settledSession(setup)
	const undoing = setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')
	await vi.waitFor(() => expect(() => setup.owner.send(session.id, 'Another')).toThrow('admission'))
	await expect(setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')).rejects.toThrow('active work')
	gate.resolve({ turnId: 'turn-1', status: 'undone', files: {} })
	await undoing
	// Admission is free again: the next refusal is the fixture's paused turn, not the undo.
	await expect(setup.owner.send(session.id, 'After the undo')).rejects.toThrow('paused turn')
})

it('refuses while a reply is running', async () => {
	const calls = fakeUndo({ 'namzu/turns/undo-status': () => ({ turns: [] }) })
	const setup = harness('rpc-process.mjs', 'old')
	const project = await setup.owner.openProject(process.cwd())
	const session = await setup.owner.newConversation(project.id)
	const review = setup.wait((event) => event.kind === 'permission')
	await setup.owner.send(session.id, 'Build')
	await review
	await expect(setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')).rejects.toThrow('active work')
	expect(calls.some((call) => call.method === 'namzu/turns/undo')).toBe(false)
	const stopped = setup.wait(settled)
	await setup.owner.cancel(session.id)
	await stopped
})

it('shows a changed plan instead of treating it as an undo', async () => {
	const calls = fakeUndo({
		'namzu/turns/undo-status': () => ({ turns: [row('applied')] }),
		'namzu/turns/undo': () => ({
			turnId: 'turn-1',
			status: 'plan-changed',
			files: {},
			replan: plan('plan-2'),
		}),
	})
	const setup = harness()
	const { project, session } = await settledSession(setup)
	const before = calls.filter((call) => call.method === 'namzu/turns/undo-status').length
	const result = await setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')
	expect(result).toMatchObject({ status: 'plan-changed', replan: { planToken: 'plan-2' } })
	expect(calls.filter((call) => call.method === 'namzu/turns/undo-status')).toHaveLength(before)
	expect(
		(await setup.owner.openConversation(project.id, session.id)).thread?.undo?.['turn-1']?.undoneAt,
	).toBeUndefined()
})

it('rejects a malformed result and still releases admission', async () => {
	fakeUndo({
		'namzu/turns/undo-status': () => ({ turns: [row('applied')] }),
		'namzu/turns/undo': () => ({ turnId: 'turn-1', status: 'exploded', files: {} }),
	})
	const setup = harness()
	const { session } = await settledSession(setup)
	await expect(setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')).rejects.toThrow('invalid')
	await expect(setup.owner.send(session.id, 'Still usable')).rejects.toThrow('paused turn')
})

it('validates its own arguments before asking the CLI', async () => {
	const calls = fakeUndo({})
	const setup = harness()
	const project = await setup.owner.openProject(process.cwd())
	const session = await setup.owner.newConversation(project.id)
	await expect(setup.owner.undoTurn(session.id, '', 'plan-1')).rejects.toThrow('Invalid')
	await expect(
		setup.owner.undoTurn(session.id, 'turn-1', 'plan-1', { force: true } as never),
	).rejects.toThrow('Invalid')
	await expect(
		setup.owner.undoTurn(session.id, 'turn-1', 'plan-1', {
			resolutions: { '/a': 'overwrite' as never },
		}),
	).rejects.toThrow('Invalid')
	expect(calls).toEqual([])
})

it('hides undo from an older CLI: no request, a plain refusal', async () => {
	const request = vi.spyOn(RuntimeClient.prototype, 'request')
	const setup = harness()
	const { session } = await settledSession(setup)
	await expect(setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')).rejects.toThrow('Update Namzu')
	await expect(setup.owner.undoPreview(session.id, 'turn-1')).rejects.toThrow('Update Namzu')
	expect(
		request.mock.calls.filter(([method]) => String(method).startsWith('namzu/turns/')),
	).toEqual([])
})

it('still marks the reply undone from the result when the status read after it fails', async () => {
	let reads = 0
	fakeUndo({
		'namzu/turns/undo-status': () => {
			reads += 1
			if (reads > 1) throw new Error('status unavailable')
			return { turns: [row('applied')] }
		},
		'namzu/turns/undo': () => ({
			turnId: 'turn-1',
			status: 'undone',
			files: { '/work/a.ts': 'restored' },
		}),
	})
	const setup = harness()
	const { project, session } = await settledSession(setup)
	await setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')
	const undo = (await setup.owner.openConversation(project.id, session.id)).thread?.undo
	expect(undo?.['turn-1']?.status).toBe('undone')
})

it('re-reads the status when an undo fails, since files may have changed', async () => {
	let status = 'applied'
	const calls = fakeUndo({
		'namzu/turns/undo-status': () => ({ turns: [row(status)] }),
		'namzu/turns/undo': () => {
			status = 'partially_undone'
			throw new Error('disk full')
		},
	})
	const setup = harness()
	const { project, session } = await settledSession(setup)
	await expect(setup.owner.undoTurn(session.id, 'turn-1', 'plan-1')).rejects.toThrow('disk full')
	expect(calls.filter((call) => call.method === 'namzu/turns/undo-status').length).toBe(2)
	const undo = (await setup.owner.openConversation(project.id, session.id)).thread?.undo
	expect(undo?.['turn-1']?.status).toBe('partially_undone')
})
