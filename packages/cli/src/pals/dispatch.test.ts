import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLog,
	MockLLMProvider,
	type PalEnvironmentLease,
	PalRuntime,
	ProviderRegistry,
	type Sandbox,
	type SandboxId,
	type ToolContext,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { CommandContext } from '../commands/types.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/index.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createFormatter } from '../output/index.js'
import {
	cliPalCommunicationPolicy,
	cliPalCommunicationStore,
	createCliPalMessagingContext,
} from './communication.js'
import { claimPalConversation } from './conversations.js'
import { dispatchCliPalMessages } from './dispatch.js'
import { createPal, getCliPalStore, updatePal } from './store.js'

const controls = vi.hoisted(() => ({ probe: vi.fn(), runtime: vi.fn(), close: vi.fn() }))
vi.mock('../tui/agent.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../tui/agent.js')>()),
	probeAgentSession: controls.probe,
}))
vi.mock('./environment.js', () => ({
	getCliPalRuntime: controls.runtime,
	closeCliPalRuntime: controls.close,
}))

let root: string
const runtimes: PalRuntime[] = []
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-pal-dispatch-')))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	controls.runtime.mockReset()
	controls.close.mockReset().mockResolvedValue(undefined)
	controls.probe.mockReset().mockResolvedValue({
		preferences: null,
		detected: [
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'fixture-private-provider-key',
				source: { kind: 'env', envName: 'OPENAI_API_KEY' },
				alternatives: [],
			},
		],
		credentialGap: null,
		needsRepickReason: null,
	})
})
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function environment(palId: string): PalEnvironmentLease {
	const sandbox: Sandbox = {
		id: generateSessionId() as unknown as SandboxId,
		status: 'ready',
		rootDir: '/home/namzu/workspace',
		environment: 'linux-namespace',
		readFile: vi.fn(async () => Buffer.from('isolated guest result')),
		writeFile: vi.fn(async () => {}),
		listFiles: vi.fn(async () => []),
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
			timedOut: false,
			durationMs: 0,
		})),
		destroy: vi.fn(async () => {}),
	}
	return {
		palId,
		environmentId: 'fixture-isolated-guest',
		generation: 1,
		sandbox,
		computerUseHost: {
			id: 'fixture-guest-display',
			getDisplayGeometry: async () => ({ width: 1280, height: 800, scaleFactor: 1 }),
			capabilities: {
				displayServer: 'x11',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: false,
				clipboard: false,
			},
			execute: vi.fn(async () => {
				throw new Error('Unused guest display operation')
			}),
		},
		release: vi.fn(async () => {}),
	}
}

async function fixture(
	provider = new MockLLMProvider({ responseText: 'Reviewed incoming finding.' }),
	allowWake = true,
) {
	const sender = createPal({ name: 'Research' })
	const recipient = createPal({
		name: 'Review',
		purpose: 'Review the accepted original evidence.',
		model: { provider: 'openai', model: 'pinned-review-model' },
	})
	const sessionId = generateSessionId()
	await claimPalConversation(sender.workspace, sender.id, sessionId)
	const state = await openSessions(sender.workspace)
	const tenantId = state.tenantId
	closeSessions(state)
	const source = { tenantId, palId: sender.id }
	const target = { tenantId, palId: recipient.id }
	const policy = cliPalCommunicationPolicy()
	await policy.update({ source, recipient: target, expectedRevision: 0, enabled: true, allowWake })
	const execution: ToolContext = {
		sessionId,
		turnId: generateTurnId(),
		toolBatchId: 'actual-sender-batch',
		toolUseId: 'actual-sender-call',
		workingDirectory: '/unused',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
	async function send(conversationId = sessionId, body = 'Review this accepted finding.') {
		if (conversationId !== sessionId)
			await claimPalConversation(sender.workspace, sender.id, conversationId)
		const context = createCliPalMessagingContext(
			sender,
			{ sessionId: conversationId, tenantId },
			() => {},
		)
		const tool = context.tools.find((item) => item.name === 'send_pal_message')!
		const result = await tool.execute(
			{ palId: recipient.id, body },
			{ ...execution, sessionId: conversationId },
		)
		expect(result.success).toBe(true)
		return result
	}
	await send()
	const store = cliPalCommunicationStore()
	const guest = environment(recipient.id)
	const acquire = vi.fn(async () => guest)
	const runtime = new PalRuntime({ store: getCliPalStore(), environments: { acquire } })
	runtimes.push(runtime)
	controls.runtime.mockResolvedValue(runtime)
	controls.close.mockImplementation(() => runtime.close())
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const ctx: CommandContext = {
		config: { limits: { tokenBudget: 0, timeoutMs: 0, maxIterations: 5 } },
		formatter: createFormatter('text', { quiet: true }),
	}
	const revoke = () =>
		policy.update({
			source,
			recipient: target,
			expectedRevision: 1,
			enabled: false,
			allowWake: false,
		})
	return {
		sender,
		recipient,
		source,
		target,
		provider,
		policy,
		store,
		guest,
		runtime,
		acquire,
		ctx,
		send,
		revoke,
	}
}

describe('finite CLI Pal dispatch with actual SDK delivery', () => {
	it('does not acquire a guest or query a provider when the directed grant has no wake permission', async () => {
		const f = await fixture(undefined, false)
		expect(
			await dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).toEqual({
			status: 'blocked',
			reason: 'This Pal communication permission does not allow wakeup.',
		})
		expect(controls.probe).not.toHaveBeenCalled()
		expect(controls.runtime).not.toHaveBeenCalled()
		expect(f.acquire).not.toHaveBeenCalled()
		expect(f.provider.requests).toEqual([])
		expect((await f.store.read(f.target))?.messages[0]).toMatchObject({
			phase: 'pending',
			receipt: null,
		})
	})
	it('records one owned route with the accepted immutable profile and leaves another route pending', async () => {
		const f = await fixture()
		await f.send(generateSessionId(), 'A second independently accepted route.')
		updatePal(f.recipient.id, 1, {
			purpose: 'Changed later purpose.',
			model: { provider: 'openai', model: 'changed-model' },
		})
		const outcome = await dispatchCliPalMessages(
			f.ctx,
			f.recipient.id,
			new AbortController().signal,
		)
		expect(outcome.status).toBe('ran')
		expect(f.provider.requests).toHaveLength(1)
		expect(f.provider.requests[0]?.model).toBe('pinned-review-model')
		expect(JSON.stringify(f.provider.requests)).toContain('Review the accepted original evidence.')
		expect(JSON.stringify(f.provider.requests)).not.toContain('Changed later purpose.')
		expect(JSON.stringify(f.provider.requests)).not.toContain('fixture-private-provider-key')
		const snapshot = await f.store.read(f.target)
		expect(snapshot?.messages.map((message) => message.phase)).toEqual(['recorded', 'pending'])
		const delivered = snapshot?.messages[0]
		if (!delivered?.receipt) throw new Error('Actual query did not acknowledge its recorded input')
		const state = await openSessions(f.recipient.workspace)
		try {
			const log = DiskSessionLog.at(state.paths, { sessionId: delivered.receipt.sessionId })
			const record = (
				await log.readAll({ expectHead: delivered.receipt.through.pointer })
			).entries.find(
				(entry) =>
					entry.record.type === 'message' &&
					entry.record.messageId === delivered.receipt?.messageId,
			)?.record
			expect(record).toMatchObject({
				type: 'message',
				role: 'user',
				content: {
					source: {
						type: 'runtime-context',
						kind: 'peer-message',
						deliveryRef: {
							namespace: 'namzu-pal-message/1',
							id: delivered.id,
							digest: delivered.digest,
						},
					},
				},
			})
		} finally {
			closeSessions(state)
		}
		expect(f.acquire).toHaveBeenCalledOnce()
		expect(f.guest.release).toHaveBeenCalledOnce()
		expect(f.runtime.busy(f.recipient.id)).toBe(false)
	})
	it('rechecks revocation after computer admission and refuses delivery before inference', async () => {
		const f = await fixture()
		const original = f.runtime.admit.bind(f.runtime)
		vi.spyOn(f.runtime, 'admit').mockImplementation(async (request) => {
			const admission = await original(request)
			await f.revoke()
			return admission
		})
		await expect(
			dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).rejects.toThrow('permission')
		expect(f.provider.requests).toEqual([])
		expect(f.guest.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.guest.sandbox.writeFile).not.toHaveBeenCalled()
		expect((await f.store.read(f.target))?.messages[0]?.phase).toBe('pending')
		expect(f.guest.release).toHaveBeenCalledOnce()
	})
	it('rechecks revocation at a tool boundary and does not make another inference call', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] },
				{ text: 'Must not continue after consent withdrawal.' },
			],
		})
		const f = await fixture(provider)
		const stream = provider.chatStream.bind(provider)
		vi.spyOn(provider, 'chatStream').mockImplementation(async function* (params) {
			yield* stream(params)
			await f.revoke()
		})
		await expect(
			dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).rejects.toThrow('step_refused')
		expect(provider.requests).toHaveLength(1)
		expect(f.guest.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.guest.sandbox.writeFile).not.toHaveBeenCalled()
		expect((await f.store.read(f.target))?.messages[0]?.phase).toBe('recorded')
		expect(f.guest.release).toHaveBeenCalledOnce()
	})
	it('keeps strict tool review separate from directed wake permission', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ name: 'write', args: { path: 'unapproved.txt', content: 'Must not write.' } },
					],
				},
				{ text: 'The requested write needs separate review.' },
			],
		})
		const f = await fixture(provider)
		await dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal)
		expect(f.guest.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'tool',
					isError: true,
					content: expect.stringContaining('no rule covers this call'),
				}),
			]),
		)
	})
	it('removes the sender signal listener when an admitted query is explicitly interrupted', async () => {
		const f = await fixture()
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, 'addEventListener')
		const remove = vi.spyOn(controller.signal, 'removeEventListener')
		const original = f.runtime.admit.bind(f.runtime)
		vi.spyOn(f.runtime, 'admit').mockImplementation(async (request) => {
			const admission = await original(request)
			controller.abort(new Error('Explicit dispatch cancellation.'))
			return admission
		})
		await expect(dispatchCliPalMessages(f.ctx, f.recipient.id, controller.signal)).rejects.toThrow(
			'cancellation',
		)
		for (const [type, listener] of add.mock.calls) {
			if (type === 'abort') expect(remove).toHaveBeenCalledWith('abort', listener)
		}
		expect(add.mock.calls.some(([type]) => type === 'abort')).toBe(true)
		expect(f.provider.requests).toEqual([])
		expect(f.guest.release).toHaveBeenCalledOnce()
	})
})
