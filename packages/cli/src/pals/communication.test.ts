import { EventEmitter } from 'node:events'
import {
	type FSWatcher,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	watch,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskPalCommunicationStore,
	DiskSessionLog,
	MockLLMProvider,
	type PalRouteBinding,
	type ToolContext,
	autoApproveHandler,
	createUserMessage,
	drainQuery,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	startConversation,
} from '../integrations/sessions/store.js'
import {
	cliPalCommunicationPolicy,
	cliPalCommunicationStore,
	createCliPalMessageHost,
	createCliPalMessagingContext,
} from './communication.js'
import { claimPalConversation, palConversationBinding } from './conversations.js'
import { createPal, getCliPalStore, updatePal } from './store.js'

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>()
	return { ...original, watch: vi.fn(original.watch) }
})

let root: string
const states: CliSessions[] = []
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-cli-pal-communication-')))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	for (const state of states.splice(0)) closeSessions(state)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function sessions(workspace: string): Promise<CliSessions> {
	const state = await openSessions(workspace)
	states.push(state)
	return state
}

async function fixture() {
	const sender = createPal({ name: 'Research', purpose: 'Research explicit tasks.' })
	const recipient = createPal({ name: 'Review', purpose: 'Review explicit results.' })
	const sessionId = generateSessionId()
	await claimPalConversation(sender.workspace, sender.id, sessionId)
	const senderState = await sessions(sender.workspace)
	const assertActive = vi.fn()
	const context = createCliPalMessagingContext(
		sender,
		{ sessionId, tenantId: senderState.tenantId },
		assertActive,
	)
	const source = { tenantId: senderState.tenantId, palId: sender.id }
	const target = { tenantId: senderState.tenantId, palId: recipient.id }
	const policy = cliPalCommunicationPolicy()
	const store = cliPalCommunicationStore()
	const execution: ToolContext = {
		sessionId,
		turnId: generateTurnId(),
		toolBatchId: 'fixture-executor-batch',
		toolUseId: 'fixture-executor-call',
		workingDirectory: '/unused-execution-root',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
	const tool = (name: string) => {
		const selected = context.tools.find((candidate) => candidate.name === name)
		if (!selected) throw new Error('Missing messaging fixture tool.')
		return selected
	}
	async function grant() {
		return policy.update({
			source,
			recipient: target,
			expectedRevision: 0,
			enabled: true,
			allowWake: false,
		})
	}
	async function accepted(body = 'Review this explicit finding.') {
		await grant()
		const result = await tool('send_pal_message').execute({ palId: recipient.id, body }, execution)
		expect(result.success).toBe(true)
		const snapshot = await store.read(target)
		const message = snapshot?.messages[0]
		const binding = snapshot?.routes[0]
		if (!message || !binding) throw new Error('No durable Pal acceptance.')
		return { result, message, binding }
	}
	return {
		sender,
		recipient,
		sessionId,
		senderState,
		assertActive,
		context,
		source,
		target,
		policy,
		store,
		execution,
		tool,
		grant,
		accepted,
	}
}

function fakeWatcher() {
	const close = vi.fn()
	const watcher = Object.assign(new EventEmitter(), { close }) as unknown as FSWatcher
	vi.mocked(watch).mockImplementationOnce((...args) => {
		const listener = args.at(-1)
		if (typeof listener === 'function') watcher.on('change', listener)
		return watcher
	})
	return { watcher, close }
}

describe('CLI Pal messaging over real disk and session ownership', () => {
	it('denies sending and discovery without a current directed permission', async () => {
		const f = await fixture()
		expect(JSON.parse((await f.tool('list_pals').execute({}, f.execution)).output)).toEqual({
			pals: [],
		})
		const denied = await f
			.tool('send_pal_message')
			.execute({ palId: f.recipient.id, body: 'Must not enqueue.' }, f.execution)
		expect(denied.success).toBe(false)
		expect(denied.error).toContain('No current directed Pal communication permission')
		expect(await f.store.read(f.target)).toBeNull()
		expect(f.assertActive).toHaveBeenCalled()
	})
	it('accepts a granted tool send once and hides unrelated or revoked recipients', async () => {
		const f = await fixture()
		const unrelated = createPal({ name: 'Unrelated' })
		const { message, result } = await f.accepted()
		expect(message).toMatchObject({
			source: { address: f.source, conversationId: f.sessionId },
			recipient: f.target,
			phase: 'pending',
			claim: null,
			receipt: null,
		})
		expect(result.data).toMatchObject({
			status: 'accepted',
			messageId: message.id,
			recipientPalId: f.recipient.id,
		})
		const repeated = await f
			.tool('send_pal_message')
			.execute({ palId: f.recipient.id, body: message.body }, f.execution)
		expect(repeated.data).toEqual(result.data)
		expect((await f.store.read(f.target))?.messages).toHaveLength(1)
		const visible = await f.tool('list_pals').execute({}, f.execution)
		expect(JSON.parse(visible.output)).toEqual({
			pals: [{ palId: f.recipient.id, name: f.recipient.name }],
		})
		expect(visible.output).not.toContain(unrelated.id)
		await f.policy.update({
			source: f.source,
			recipient: f.target,
			expectedRevision: 1,
			enabled: false,
			allowWake: false,
		})
		expect(JSON.parse((await f.tool('list_pals').execute({}, f.execution)).output)).toEqual({
			pals: [],
		})
		const denied = await f
			.tool('send_pal_message')
			.execute(
				{ palId: f.recipient.id, body: 'After revocation.' },
				{ ...f.execution, toolUseId: 'next-call' },
			)
		expect(denied.success).toBe(false)
		expect((await f.store.read(f.target))?.messages).toHaveLength(1)
	})
	it('creates a recipient root at the accepted immutable profile revision after a current profile edit', async () => {
		const f = await fixture()
		const { binding } = await f.accepted()
		updatePal(f.recipient.id, 1, { purpose: 'Changed later purpose.' })
		const host = createCliPalMessageHost()
		await host.ensureConversation(binding, new AbortController().signal)
		const membership = await palConversationBinding(f.recipient.workspace, binding.sessionId)
		expect(membership).toMatchObject({
			pal: { revision: 2 },
			definition: { revision: 1, purpose: f.recipient.purpose },
		})
		const access = await host.openConversation(binding, new AbortController().signal)
		const first = (await access.log.readAll()).entries[0]?.record
		expect(first).toMatchObject({
			type: 'session_started',
			tenantId: f.target.tenantId,
			origin: {
				protocol: 'desktop',
				externalSessionId: JSON.stringify(['namzu-pal', f.recipient.id, 1, binding.sessionId]),
			},
		})
	})
	it('never repairs an ordinary or foreign-tenant existing root into a Pal route', async () => {
		for (const foreignTenant of [false, true]) {
			const f = await fixture()
			const { binding } = await f.accepted()
			const state = await sessions(f.recipient.workspace)
			await startConversation(foreignTenant ? { ...state, tenantId: generateTenantId() } : state, {
				id: binding.sessionId,
				...(foreignTenant
					? {
							origin: {
								protocol: 'desktop' as const,
								externalSessionId: JSON.stringify([
									'namzu-pal',
									f.recipient.id,
									1,
									binding.sessionId,
								]),
							},
						}
					: {}),
			})
			const path = state.paths.sessionLog({ sessionId: binding.sessionId })
			const original = readFileSync(path)
			await expect(
				createCliPalMessageHost().ensureConversation(binding, new AbortController().signal),
			).rejects.toThrow('not claimed')
			expect(readFileSync(path)).toEqual(original)
			expect((await f.store.read(f.target))?.messages[0]?.phase).toBe('pending')
		}
	})
	it('refuses a foreign query before creating or activating the recipient route', async () => {
		const f = await fixture()
		const { binding } = await f.accepted()
		const context = createCliPalMessagingContext(
			f.recipient,
			{
				sessionId: binding.sessionId,
				tenantId: f.target.tenantId,
			},
			() => {},
		).durableInbound
		await expect(
			context.claim({
				sessionId: generateSessionId(),
				turnId: generateTurnId(),
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('Foreign')
		const snapshot = await f.store.read(f.target)
		expect(snapshot?.routes[0]).toEqual(binding)
		expect(snapshot?.routes[0]?.phase).toBe('reserved')
		const state = await sessions(f.recipient.workspace)
		const log = DiskSessionLog.at(state.paths, { sessionId: binding.sessionId })
		expect((await log.readAll()).entries).toEqual([])
	})
	it('refuses a foreign route tenant before publishing a new recipient root', async () => {
		const f = await fixture()
		const { binding } = await f.accepted()
		const state = await sessions(f.recipient.workspace)
		const foreign: PalRouteBinding = {
			...binding,
			key: {
				...binding.key,
				recipient: { ...binding.key.recipient, tenantId: generateTenantId() },
			},
		}
		const host = createCliPalMessageHost()
		await expect(host.ensureConversation(foreign, new AbortController().signal)).rejects.toThrow(
			'tenant',
		)
		await expect(host.openConversation(foreign, new AbortController().signal)).rejects.toThrow(
			'tenant',
		)
		expect(existsSync(state.paths.sessionLog({ sessionId: binding.sessionId }))).toBe(false)
	})
	it('appends and acknowledges incoming context through the actual SDK query before inference', async () => {
		const f = await fixture()
		const body = 'EXPLICIT_REVIEW_FINDING_20261002 Türkçe 🧪'
		const { binding, message } = await f.accepted(body)
		await createCliPalMessageHost().ensureConversation(binding, new AbortController().signal)
		const state = await sessions(f.recipient.workspace)
		const log = DiskSessionLog.at(state.paths, { sessionId: binding.sessionId })
		expect((await log.readAll()).entries).toHaveLength(1)
		const context = createCliPalMessagingContext(
			f.recipient,
			{ sessionId: binding.sessionId, tenantId: state.tenantId },
			vi.fn(),
		)
		const provider = new MockLLMProvider({ turns: [{ text: 'Reviewed explicit finding.' }] })
		const turn = await drainQuery({
			provider,
			toolsets: [],
			resumeHandler: autoApproveHandler,
			agentId: f.recipient.id,
			agentName: f.recipient.name,
			messages: [createUserMessage('Read the explicit incoming finding.')],
			workingDirectory: f.recipient.workspace,
			paths: state.paths,
			sessionLog: log,
			sessionId: binding.sessionId,
			topicId: state.topicId,
			projectId: state.projectId,
			tenantId: state.tenantId,
			durableInbound: context.durableInbound,
			turnConfig: { model: 'fixture', tokenBudget: 0, timeoutMs: 0, maxIterations: 2 },
		})
		expect(turn.status).toBe('completed')
		expect(provider.requests).toHaveLength(1)
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain(body)
		const delivered = (await f.store.read(f.target))?.messages.find(
			(item) => item.id === message.id,
		)
		expect(delivered).toMatchObject({
			phase: 'recorded',
			claim: { sessionId: binding.sessionId, turnId: turn.id },
			receipt: {
				sessionId: binding.sessionId,
				turnId: turn.id,
				ref: { namespace: 'namzu-pal-message/1', id: message.id, digest: message.digest },
			},
		})
		if (!delivered?.receipt) throw new Error('Real query did not confirm durable delivery.')
		const read = await log.readAll({ expectHead: delivered.receipt.through.pointer })
		const record = read.entries.find(
			({ record }) =>
				record.type === 'message' && record.messageId === delivered.receipt?.messageId,
		)?.record
		expect(record).toMatchObject({
			type: 'message',
			role: 'user',
			content: {
				source: {
					type: 'runtime-context',
					kind: 'peer-message',
					deliveryRef: delivered.receipt.ref,
				},
			},
		})
		expect(JSON.stringify(record)).toContain(body)
	})
	it.each(['abort', 'change', 'error'] as const)(
		'closes its notification watcher and abort listener on %s',
		async (ending) => {
			const f = await fixture()
			let source = f.context.durableInbound
			if (ending === 'change') {
				const { binding } = await f.accepted()
				source = createCliPalMessagingContext(
					f.recipient,
					{
						sessionId: binding.sessionId,
						tenantId: f.target.tenantId,
					},
					() => {},
				).durableInbound
			}
			const { watcher, close } = fakeWatcher()
			const controller = new AbortController()
			const add = vi.spyOn(controller.signal, 'addEventListener')
			const remove = vi.spyOn(controller.signal, 'removeEventListener')
			const pending = source.wait!(controller.signal)
			const error = new Error('Explicit wait termination.')
			if (ending === 'abort') controller.abort(error)
			else if (ending === 'change') watcher.emit('change', 'change', 'signal')
			else watcher.emit('error', error)
			if (ending === 'change') await pending
			else await expect(pending).rejects.toBe(error)
			const abortListener = add.mock.calls.find(([name]) => name === 'abort')?.[1]
			expect(abortListener).toBeDefined()
			expect(remove).toHaveBeenCalledWith('abort', abortListener)
			expect(close).toHaveBeenCalledOnce()
			controller.abort()
			expect(close).toHaveBeenCalledOnce()
		},
	)
	it('refuses an owned pending route while another conversation has an unresolved delivery claim', async () => {
		const f = await fixture()
		const { binding } = await f.accepted()
		const host = createCliPalMessageHost()
		await host.ensureConversation(binding, new AbortController().signal)
		const active = await f.store.activate(binding, {
			binding,
			definition: getCliPalStore().getRevision(f.recipient.id, binding.profileRevision),
			access: await host.openConversation(binding, new AbortController().signal),
		})
		await f.store.claim(active, {
			turnId: generateTurnId(),
			generation: 1,
			content: () => 'Unresolved real store claim.',
		})
		const originalReceiver = createCliPalMessagingContext(
			f.recipient,
			{
				sessionId: binding.sessionId,
				tenantId: f.target.tenantId,
			},
			() => {},
		).durableInbound
		const originalWatcher = fakeWatcher()
		await expect(originalReceiver.wait!(new AbortController().signal)).rejects.toThrow(
			'requires reconciliation',
		)
		expect(originalWatcher.close).toHaveBeenCalledOnce()
		const senderSession = generateSessionId()
		await claimPalConversation(f.sender.workspace, f.sender.id, senderSession)
		const sender = createCliPalMessagingContext(
			f.sender,
			{
				sessionId: senderSession,
				tenantId: f.source.tenantId,
			},
			() => {},
		)
		const sent = await sender.tools
			.find((tool) => tool.name === 'send_pal_message')!
			.execute(
				{ palId: f.recipient.id, body: 'Pending in a second route.' },
				{ ...f.execution, sessionId: senderSession },
			)
		expect(sent.success).toBe(true)
		const snapshot = await f.store.read(f.target)
		const owned = snapshot?.routes.find((route) => route.key.senderConversationId === senderSession)
		if (!owned) throw new Error('No second owned route.')
		const recipient = createCliPalMessagingContext(
			f.recipient,
			{
				sessionId: owned.sessionId,
				tenantId: f.target.tenantId,
			},
			() => {},
		)
		await expect(
			recipient.durableInbound.claim({
				sessionId: owned.sessionId,
				turnId: generateTurnId(),
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('requires reconciliation')
		const { close } = fakeWatcher()
		const controller = new AbortController()
		await expect(recipient.durableInbound.wait!(controller.signal)).rejects.toThrow(
			'requires reconciliation',
		)
		expect(close).toHaveBeenCalledOnce()
	})
	it('ignores unrelated notification hints and leaves the wait open until explicitly aborted', async () => {
		const f = await fixture()
		const { watcher, close } = fakeWatcher()
		const read = DiskPalCommunicationStore.prototype.read
		let inspected!: Promise<Awaited<ReturnType<typeof read>>>
		vi.spyOn(DiskPalCommunicationStore.prototype, 'read').mockImplementation(function (
			this: DiskPalCommunicationStore,
			address,
		) {
			inspected = read.call(this, address)
			return inspected
		})
		const controller = new AbortController()
		const waiting = f.context.durableInbound.wait!(controller.signal)
		const ended = waiting.catch(() => {})
		try {
			await inspected
			watcher.emit('change', 'rename', 'unrelated.tmp')
			await inspected
			watcher.emit('change', 'change', 'signal')
			await inspected
			await Promise.resolve()
			expect(close).not.toHaveBeenCalled()
		} finally {
			controller.abort(new Error('End the explicit test wait.'))
			await ended
		}
		expect(close).toHaveBeenCalledOnce()
	})
	it.skipIf(process.platform === 'win32')(
		'refuses notification directory aliases before writing outside its owned home',
		async () => {
			const f = await fixture()
			const foreign = join(root, 'foreign')
			mkdirSync(foreign)
			const wake = join(root, 'state', 'pal-message-wake')
			mkdirSync(wake)
			symlinkSync(foreign, join(wake, f.recipient.id))
			await expect(
				Promise.resolve().then(() => createCliPalMessageHost().notify?.(f.target)),
			).rejects.toThrow()
			expect(existsSync(join(foreign, 'signal'))).toBe(false)
		},
	)
})
