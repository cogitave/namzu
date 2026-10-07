import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
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
function harness(mode = 'eligible', fixture = 'rpc-retry-process.mjs') {
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const log = join(mkdtempSync(join(tmpdir(), 'namzu-retry-')), 'requests.jsonl')
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL(`./__fixtures__/${fixture}`, import.meta.url))],
			env: { ...process.env, FIXTURE_RETRY_MODE: mode, FIXTURE_REQUEST_LOG: log },
		},
		(event) => {
			recorded.push(event)
			events.emit('event', event)
		},
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
	const requests = () =>
		readFileSync(log, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
	return { owner, recorded, wait, requests }
}
const settled = (event: DesktopEvent) => event.kind === 'state' && !event.running
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}

it('holds settlement ownership across a deferred status read and atomically starts only the already authored queue', async () => {
	const entered = deferred<void>()
	const status = deferred<unknown>()
	let reads = 0
	const request = RuntimeClient.prototype.request
	vi.spyOn(RuntimeClient.prototype, 'supportsTurnRetry').mockReturnValue(true)
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		if (method === 'namzu/sessions/retry-status') {
			if (++reads === 2) {
				entered.resolve()
				return status.promise
			}
			return Promise.resolve({})
		}
		return request.call(this, method, params, timeout)
	})
	const { owner, wait, requests, recorded } = harness('old', 'rpc-process.mjs')
	try {
		const project = await owner.openProject(process.cwd())
		const session = await owner.newConversation(project.id)
		const review = wait((event) => event.kind === 'permission')
		await owner.send(session.id, 'First admitted prompt')
		const first = await review
		if (first.kind !== 'permission') throw new Error('Missing approval')
		await owner.send(session.id, 'Already authored queued prompt')
		owner.respondPermission(session.id, first.request.id, { outcome: 'approve' })
		await entered.promise
		owner.saveDraft(session.id, 'New prompt during settlement refresh')
		expect(() => owner.send(session.id, 'New prompt during settlement refresh')).toThrow(
			'admission',
		)
		await expect(owner.selectProvider(session.id, 'fixture', 'new')).rejects.toThrow('Stop')
		await expect(owner.selectHarness(session.id, 'codex-cli')).rejects.toThrow('Stop')
		await expect(owner.setPluginEnabled(session.id, 'fixture', true)).rejects.toThrow('Stop')
		expect((await owner.openConversation(project.id, session.id)).thread?.queued).toEqual([
			'Already authored queued prompt',
		])
		expect(requests().filter((item) => item.method === 'session/prompt')).toHaveLength(1)
		const queuedReview = wait((event) => event.kind === 'permission')
		status.resolve({})
		await queuedReview
		expect(
			requests()
				.filter((item) => item.method === 'session/prompt')
				.map((item) => item.params?.prompt),
		).toEqual(['First admitted prompt', 'Already authored queued prompt'])
		expect((await owner.openConversation(project.id, session.id)).thread?.permissions).toHaveLength(
			1,
		)
		expect(owner.draft(session.id)).toBe('New prompt during settlement refresh')
		expect(recorded.filter((event) => event.kind === 'prompt')).toHaveLength(2)
		const cancelled = wait(settled)
		await owner.cancel(session.id)
		await cancelled
	} finally {
		status.resolve({})
	}
})

it.each(['send', 'retry'] as const)(
	'refuses engine/model/plugin changes during deferred %s preflight',
	async (kind) => {
		const { owner, wait, requests } = harness()
		const project = await owner.openProject(process.cwd())
		const session = await owner.newConversation(project.id)
		if (kind === 'retry') {
			const stopped = wait(settled)
			await owner.send(session.id, 'Build')
			await stopped
		}
		const entered = deferred<void>()
		const status = deferred<unknown>()
		const request = RuntimeClient.prototype.request
		vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
			this: RuntimeClient,
			method,
			params,
			timeout,
		) {
			if (method === 'namzu/sessions/retry-status') {
				entered.resolve()
				return status.promise
			}
			return request.call(this, method, params, timeout)
		})
		let admission: void | Promise<void>
		try {
			admission =
				kind === 'send'
					? owner.send(session.id, 'Build')
					: owner.retryTurn(session.id, 'original-turn', 'original-checkpoint')
			await entered.promise
			await expect(owner.selectProvider(session.id, 'fixture', 'new')).rejects.toThrow('Stop')
			await expect(owner.selectHarness(session.id, 'codex-cli')).rejects.toThrow('Stop')
			await expect(owner.setPluginEnabled(session.id, 'fixture', true)).rejects.toThrow('Stop')
			expect(
				requests().filter((item) =>
					[
						'namzu/providers/select',
						'namzu/harnesses/select',
						'namzu/plugins/set_enabled',
					].includes(item.method),
				),
			).toEqual([])
			// A noneligible authoritative response ends preflight without work.
			status.resolve({ notice: 'Paused settings retained.' })
			await expect(admission).rejects.toThrow('Paused settings retained')
		} finally {
			status.resolve({ notice: 'Paused settings retained.' })
		}
	},
)

it('rejects a stale readonly status response after a model selection changes', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const entered = deferred<void>()
	const status = deferred<unknown>()
	const request = RuntimeClient.prototype.request
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		if (method === 'namzu/sessions/retry-status') {
			entered.resolve()
			return status.promise
		}
		return request.call(this, method, params, timeout)
	})
	await owner.openConversation(project.id, session.id)
	const readiness = owner.readyConversation(project.id, session.id)
	const refused = expect(readiness).rejects.toThrow('settings changed')
	try {
		await entered.promise
		await owner.selectProvider(session.id, 'fixture', 'new')
		status.resolve({ retry: { turnId: 'stale', checkpointId: 'stale' } })
		await refused
	} finally {
		status.resolve({})
	}
})

it('explicitly resumes the original turn while retaining draft, attachments and authored queue without re-sending prompts', async () => {
	const { owner, recorded, wait, requests } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const review = wait((event) => event.kind === 'permission')
	await owner.send(session.id, 'Wait for pause', { permissionMode: 'prompt', effort: 'low' })
	const first = await review
	if (first.kind !== 'permission') throw new Error('Missing approval')
	await owner.send(session.id, 'Keep authored follow-up')
	const stopped = wait(settled)
	owner.respondPermission(session.id, first.request.id, { outcome: 'approve' })
	await stopped
	owner.saveDraft(session.id, 'Keep unsent draft')
	const files = await owner.addAttachments(session.id, [
		{ name: 'draft.txt', bytes: Buffer.from('kept') },
	])
	const paused = (await owner.openConversation(project.id, session.id)).thread
	expect(paused?.retry).toEqual({ turnId: 'original-turn', checkpointId: 'original-checkpoint' })
	const retryReview = wait((event) => event.kind === 'permission')
	await owner.retryTurn(session.id, 'original-turn', 'original-checkpoint')
	const second = await retryReview
	if (second.kind !== 'permission') throw new Error('Missing retry approval')
	expect((await owner.openConversation(project.id, session.id)).thread).toMatchObject({
		running: true,
		turn: 1,
		stopReason: undefined,
		queued: ['Keep authored follow-up'],
		messages: [{ role: 'user', text: 'Wait for pause' }],
	})
	const done = wait(settled)
	owner.respondPermission(session.id, second.request.id, { outcome: 'approve' })
	await done
	const restored = (await owner.openConversation(project.id, session.id)).thread
	expect(restored).toMatchObject({
		turn: 1,
		stopReason: 'end_turn',
		queued: ['Keep authored follow-up'],
	})
	expect(restored?.messages).toMatchObject([
		{ role: 'user', text: 'Wait for pause' },
		expect.objectContaining({ role: 'assistant', text: 'Continued original turn' }),
	])
	expect(owner.draft(session.id)).toBe('Keep unsent draft')
	expect(owner.attachments(session.id).map((file) => file.id)).toEqual(files.map((file) => file.id))
	expect(recorded.filter((event) => event.kind === 'prompt')).toHaveLength(1)
	expect(requests().filter((request) => request.method === 'session/prompt')).toHaveLength(1)
	expect(requests().find((request) => request.method === 'namzu/sessions/retry')?.params).toEqual({
		sessionId: session.id,
		turnId: 'original-turn',
		checkpointId: 'original-checkpoint',
	})
})

it('shows an authoritative unsafe-usage notice, refusing retry and new prompt before consuming its draft or files', async () => {
	const { owner, recorded, wait, requests } = harness('unsafe')
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const stopped = wait(settled)
	await owner.send(session.id, 'Build')
	await stopped
	owner.saveDraft(session.id, 'Do not consume this')
	const files = await owner.addAttachments(session.id, [
		{ name: 'proof.txt', bytes: Buffer.from('proof') },
	])
	const paused = (await owner.openConversation(project.id, session.id)).thread
	expect(paused?.retry).toBeUndefined()
	expect(paused?.retryNotice).toContain('unresolved token usage')
	await expect(owner.retryTurn(session.id, 'original-turn', 'original-checkpoint')).rejects.toThrow(
		'unresolved token usage',
	)
	await expect(
		owner.send(session.id, 'Do not consume this', { attachmentIds: files.map((file) => file.id) }),
	).rejects.toThrow('unresolved token usage')
	expect(owner.draft(session.id)).toBe('Do not consume this')
	expect(owner.attachments(session.id).map((file) => file.id)).toEqual(files.map((file) => file.id))
	expect(recorded.filter((event) => event.kind === 'prompt')).toHaveLength(1)
	expect(requests().filter((request) => request.method === 'namzu/sessions/retry')).toHaveLength(0)
})

it('rejects stale checkpoint identity and allows cancellation of an admitted retry without another turn', async () => {
	const { owner, recorded, wait, requests } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const stopped = wait(settled)
	await owner.send(session.id, 'Build')
	await stopped
	await expect(owner.retryTurn(session.id, 'original-turn', 'stale-checkpoint')).rejects.toThrow(
		'no longer available',
	)
	const review = wait((event) => event.kind === 'permission')
	await owner.retryTurn(session.id, 'original-turn', 'original-checkpoint', {
		effort: 'low',
		permissionMode: 'plan',
	})
	await review
	expect(
		requests().find((request) => request.method === 'namzu/sessions/retry')?.params?.options,
	).toEqual({ effort: 'low', permissionMode: 'plan' })
	await expect(owner.retryTurn(session.id, 'original-turn', 'original-checkpoint')).rejects.toThrow(
		'active work',
	)
	const cancelled = wait(settled)
	await owner.cancel(session.id)
	await cancelled
	expect((await owner.openConversation(project.id, session.id)).thread).toMatchObject({
		turn: 1,
		stopReason: 'cancelled',
		reason: 'cancelled',
		permissions: [],
	})
	expect(recorded.filter((event) => event.kind === 'prompt')).toHaveLength(1)
})

it('keeps an older connection usable without inventing an unsupported retry route', async () => {
	const { owner, wait, requests } = harness('old')
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const stopped = wait(settled)
	owner.send(session.id, 'Build')
	await stopped
	expect((await owner.openConversation(project.id, session.id)).thread?.retry).toBeUndefined()
	await expect(owner.retryTurn(session.id, 'original-turn', 'original-checkpoint')).rejects.toThrow(
		'Update Namzu',
	)
	expect(() => owner.send(session.id, 'New prompt')).toThrow('paused turn')
	expect(requests().filter((request) => request.method.startsWith('namzu/sessions/retry'))).toEqual(
		[],
	)
})
