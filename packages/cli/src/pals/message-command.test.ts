import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type PalIngressIntentDraft,
	generateSessionId,
	generateTurnId,
	ingressIntentDigest,
	ingressIntentId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { CommandContext } from '../commands/types.js'
import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createFormatter } from '../output/index.js'
import { cliPalCommunicationPolicy, cliPalCommunicationStore } from './communication.js'
import { runPalMessageCommand } from './message-command.js'
import { createPal } from './store.js'

const controls = vi.hoisted(() => ({ dispatch: vi.fn() }))
vi.mock('./dispatch.js', () => ({ dispatchCliPalMessages: controls.dispatch }))

let root: string
let ctx: CommandContext
let print: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-pal-message-command-')))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	ctx = { config: {}, formatter: createFormatter('text', { quiet: false }) }
	print = vi.spyOn(ctx.formatter, 'print').mockImplementation(() => {})
	error = vi.spyOn(ctx.formatter, 'error').mockImplementation(() => {})
	controls.dispatch.mockReset().mockResolvedValue({ status: 'idle', reason: 'empty' })
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function addresses() {
	const sender = createPal({ name: 'Sender' })
	const recipient = createPal({ name: 'Recipient' })
	const state = await openSessions(sender.workspace)
	const tenantId = state.tenantId
	const projectId = state.projectId
	closeSessions(state)
	return {
		sender,
		recipient,
		source: { tenantId, palId: sender.id },
		target: { tenantId, palId: recipient.id },
		projectId,
	}
}

describe('explicit Pal message commands', () => {
	it('creates a directed grant without wake, upgrades with CAS, and revokes without granting reverse disclosure', async () => {
		const f = await addresses()
		const ids = [f.sender.id, f.recipient.id]
		expect(await runPalMessageCommand(ctx, 'grant', ids)).toBe(EXIT_OK)
		const policy = cliPalCommunicationPolicy()
		expect(await policy.get(f.source, f.target)).toMatchObject({
			revision: 1,
			enabled: true,
			allowWake: false,
		})
		expect(await policy.get(f.target, f.source)).toBeNull()
		expect(await runPalMessageCommand(ctx, 'grant', [...ids, '--wake', '--revision', '1'])).toBe(
			EXIT_OK,
		)
		expect(await policy.get(f.source, f.target)).toMatchObject({ revision: 2, allowWake: true })
		expect(await runPalMessageCommand(ctx, 'revoke', [...ids, '--revision', '1'])).toBe(EXIT_USAGE)
		expect(error).toHaveBeenLastCalledWith({
			message: 'Pal communication permission changed; reload it.',
		})
		expect(await policy.get(f.source, f.target)).toMatchObject({ revision: 2, enabled: true })
		expect(await runPalMessageCommand(ctx, 'revoke', ids)).toBe(EXIT_OK)
		expect(await policy.get(f.source, f.target)).toMatchObject({
			revision: 3,
			enabled: false,
			allowWake: false,
		})
		expect(print).toHaveBeenCalledTimes(3)
	})
	it.each([
		['grant', []],
		['grant', ['one']],
		['grant', ['one', 'two', '--wake', '--wake']],
		['grant', ['one', 'two', '--revision']],
		['grant', ['one', 'two', '--revision', '-1']],
		['grant', ['one', 'two', '--revision', '1.5']],
		['grant', ['one', 'two', '--revision', '1', '--revision', '1']],
		['grant', ['one', 'two', '--json', '--json']],
		['revoke', ['one', 'two', '--wake']],
		['inbox', ['one', '--revision', '0']],
		['dispatch', ['one', '--wake']],
		['dispatch', ['one', '--unknown']],
	] as const)(
		'refuses malformed %s arguments without state or dispatcher effects: %j',
		async (verb, args) => {
			const before = readdirSync(join(root, 'state'), { recursive: true }).sort()
			expect(await runPalMessageCommand(ctx, verb, args)).toBe(EXIT_USAGE)
			expect(readdirSync(join(root, 'state'), { recursive: true }).sort()).toEqual(before)
			expect(controls.dispatch).not.toHaveBeenCalled()
			expect(print).not.toHaveBeenCalled()
			expect(error).toHaveBeenCalledOnce()
		},
	)
	it('reports a missing Pal without creating a communication grant', async () => {
		expect(await runPalMessageCommand(ctx, 'grant', ['pal_missing', 'pal_other'])).toBe(EXIT_USAGE)
		expect(readdirSync(join(root, 'state'))).toEqual(['pals'])
		expect(controls.dispatch).not.toHaveBeenCalled()
	})
	it('prints an empty inbox without dispatching or waking a Pal', async () => {
		const pal = createPal({ name: 'Idle' })
		expect(await runPalMessageCommand(ctx, 'inbox', [pal.id])).toBe(EXIT_OK)
		expect(print).toHaveBeenCalledWith([])
		expect(controls.dispatch).not.toHaveBeenCalled()
	})
	it('prints truthful source metadata for the shared inbox without exposing message bodies or grants', async () => {
		const f = await addresses()
		const senderSession = generateSessionId()
		const subscriptionId = randomUUID()
		const scope = {
			tenantId: f.source.tenantId,
			projectId: f.projectId,
			palId: f.sender.id,
			profileRevision: f.sender.revision,
			sessionId: senderSession,
		}
		const native = {
			provider: 'native-fixture',
			connectionId: 'configured-connection',
			externalTenantId: 'verified-external-tenant',
			nativeConversationId: 'private-native-conversation',
			nativeChannelId: null,
			nativeThreadId: 'private-native-thread',
		}
		const common = {
			recipient: f.target,
			replyTo: null,
			grant: { id: 'private-acceptance-audit', revision: '1' },
			createdAt: 100,
		} as const
		const drafts: PalIngressIntentDraft[] = [
			{
				...common,
				operationId: 'sender-tool-call',
				source: {
					address: f.source,
					conversationId: senderSession,
					profileRevision: f.sender.revision,
				},
				routeKey: {
					v: 1,
					kind: 'pal',
					sender: f.source,
					senderConversationId: senderSession,
					recipient: f.target,
					dialogKey: 'default',
				},
				body: 'Private peer body',
			},
			{
				...common,
				kind: 'observation',
				operationId: 'b'.repeat(64),
				source: { kind: 'host-observation', subscriptionId, scope },
				routeKey: { v: 1, kind: 'observation', recipient: f.target, subscriptionId, scope },
				fact: {
					id: 'b'.repeat(64),
					type: 'turn_started',
					sessionId: senderSession,
					turnId: generateTurnId(),
					seq: 2,
					generation: 1,
					at: '2026-10-02T00:00:00.000Z',
					status: 'running',
				},
				subscriptionTrail: [subscriptionId],
			},
			{
				...common,
				kind: 'channel',
				operationId: 'verified-provider-event',
				source: {
					kind: 'channel',
					tenantId: f.target.tenantId,
					...native,
					actorId: 'verified-event-actor',
					eventId: 'verified-provider-event',
				},
				routeKey: { v: 1, kind: 'channel', recipient: f.target, ...native },
				body: 'Private channel body',
			},
		]
		const receipts = []
		for (const draft of drafts) {
			const id = ingressIntentId(draft)
			receipts.push(
				await cliPalCommunicationStore().acceptIngress(
					{ ...draft, id, digest: ingressIntentDigest({ ...draft, id }) },
					f.recipient.revision,
				),
			)
		}
		expect(await runPalMessageCommand(ctx, 'inbox', [f.recipient.id])).toBe(EXIT_OK)
		const shared = receipts.map((receipt) => ({
			id: receipt.id,
			status: 'pending',
			conversationId: receipt.sessionId,
		}))
		expect(print).toHaveBeenCalledWith([
			{ ...shared[0], sourcePalId: f.sender.id },
			{
				...shared[1],
				sourceKind: 'host-observation',
				subscriptionId,
				observedPalId: f.sender.id,
			},
			{
				...shared[2],
				sourceKind: 'channel',
				provider: native.provider,
				connectionId: native.connectionId,
				actorId: 'verified-event-actor',
			},
		])
		expect(controls.dispatch).not.toHaveBeenCalled()
	})
	it('dispatches once and removes both process interruption listeners after success', async () => {
		const pal = createPal({ name: 'Idle' })
		const sigint = process.listenerCount('SIGINT')
		const sigterm = process.listenerCount('SIGTERM')
		expect(await runPalMessageCommand(ctx, 'dispatch', [pal.id])).toBe(EXIT_OK)
		expect(controls.dispatch).toHaveBeenCalledOnce()
		// Typing the command is the owner starting the Pal, the one consent that also wakes it for an owner message.
		expect(controls.dispatch).toHaveBeenCalledWith(ctx, pal.id, expect.any(AbortSignal), {
			operatorWake: true,
		})
		expect(print).toHaveBeenCalledWith({ status: 'idle', reason: 'empty' })
		expect(process.listenerCount('SIGINT')).toBe(sigint)
		expect(process.listenerCount('SIGTERM')).toBe(sigterm)
	})
	it('forwards process interruption to the finite operation and removes listeners on failure', async () => {
		const pal = createPal({ name: 'Interrupted' })
		const sigint = process.listenerCount('SIGINT')
		const sigterm = process.listenerCount('SIGTERM')
		let began!: () => void
		const started = new Promise<void>((resolve) => {
			began = resolve
		})
		controls.dispatch.mockImplementation(
			(_ctx, _palId, signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), { once: true })
					began()
				}),
		)
		const running = runPalMessageCommand(ctx, 'dispatch', [pal.id])
		await started
		process.emit('SIGINT')
		expect(await running).toBe(EXIT_UNAVAILABLE)
		expect(error).toHaveBeenCalledWith({ message: 'Pal message dispatch interrupted.' })
		expect(print).not.toHaveBeenCalled()
		expect(process.listenerCount('SIGINT')).toBe(sigint)
		expect(process.listenerCount('SIGTERM')).toBe(sigterm)
	})
})
