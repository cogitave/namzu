import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLog,
	MockLLMProvider,
	autoApproveHandler,
	createUserMessage,
	drainQuery,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { createPalCommand } from '../commands/pal.js'
import { EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { type CliSessions, closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createFormatter } from '../output/index.js'
import { publishCliPalActivity, subscribeCliPalActivity } from './activity.js'
import {
	cliPalActivitySubscriptionPolicy,
	cliPalActivitySubscriptionStore,
	cliPalCommunicationStore,
} from './communication.js'
import { claimPalConversation } from './conversations.js'
import { createPal, updatePal } from './store.js'

let root: string
const states: CliSessions[] = []
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-cli-pal-activity-')))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	for (const state of states.splice(0)) closeSessions(state)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})
const signal = () => new AbortController().signal
const limits = (subscriptionId: string) => ({
	subscriptionId,
	signal: signal(),
	maxRecords: 64,
	maxReadBytes: 1024 * 1024,
	causalityReadBytes: 1024 * 1024,
	causalityRecords: 1000,
})
async function fixture(prompt = true) {
	const source = createPal({ name: 'Research', purpose: 'PRIVATE PURPOSE' })
	const recipient = createPal({ name: 'Review' })
	const sessionId = generateSessionId()
	await claimPalConversation(source.workspace, source.id, sessionId)
	const state = await openSessions(source.workspace)
	states.push(state)
	const log = DiskSessionLog.at(state.paths, { sessionId })
	const provider = new MockLLMProvider({ responseText: 'PRIVATE ANSWER' })
	if (prompt) {
		const turn = await drainQuery({
			provider,
			toolsets: [],
			resumeHandler: autoApproveHandler,
			agentId: source.id,
			agentName: source.name,
			messages: [createUserMessage('PRIVATE USER TEXT')],
			workingDirectory: source.workspace,
			paths: state.paths,
			sessionLog: log,
			sessionId,
			topicId: state.topicId,
			projectId: state.projectId,
			tenantId: state.tenantId,
			turnConfig: {
				model: 'fixture',
				tokenBudget: 0,
				timeoutMs: 0,
				maxIterations: 2,
			},
		})
		expect(turn.status).toBe('completed')
	}
	return {
		source,
		recipient,
		sessionId,
		state,
		log,
		provider,
		subscribe: () =>
			subscribeCliPalActivity({
				sourcePalId: source.id,
				sourceSessionId: sessionId,
				recipientPalId: recipient.id,
				wake: false,
				signal: signal(),
			}),
	}
}

it('publishes original closed activity once across fresh stores without inference or changing the source journal', async () => {
	const f = await fixture()
	const before = createHash('sha256').update(readFileSync(f.log.file)).digest('hex')
	updatePal(f.source.id, f.source.revision, {
		paused: true,
		purpose: 'NEW PRIVATE PURPOSE',
	})
	const subscription = await f.subscribe()
	expect(subscription.scope.profileRevision).toBe(1)
	const first = await publishCliPalActivity(limits(subscription.id))
	expect(first.accepted.length).toBeGreaterThan(0)
	const inbox = await cliPalCommunicationStore().readIngress(subscription.recipient)
	expect(
		inbox?.messages.every(
			(message) =>
				'kind' in message && message.kind === 'observation' && message.phase === 'pending',
		),
	).toBe(true)
	expect(JSON.stringify(inbox)).not.toContain('PRIVATE')
	expect((await cliPalActivitySubscriptionPolicy().get(subscription.id))?.wake).toBe(false)
	expect(await publishCliPalActivity(limits(subscription.id))).toMatchObject({
		accepted: [],
		complete: true,
	})
	expect(
		(await cliPalCommunicationStore().readIngress(subscription.recipient))?.messages,
	).toHaveLength(first.accepted.length)
	expect(f.provider.requests).toHaveLength(1)
	expect(createHash('sha256').update(readFileSync(f.log.file)).digest('hex')).toBe(before)
})

it('refuses unknown first-request lineage without accepting messages or advancing progress', async () => {
	const f = await fixture(false)
	const lease = await f.log.claim({
		holder: 'activity-fixture',
		now: Date.now(),
		ttlMs: 60_000,
	})
	if (!lease) throw new Error('Missing writer.')
	try {
		await f.log.beginTurn(lease, {
			turnId: generateTurnId(),
			userMessageId: generateMessageId(),
			systemPrompt: 'PRIVATE',
			config: { model: 'fixture', tokenBudget: 0, timeoutMs: 0 },
		})
	} finally {
		await f.log.release(lease)
	}
	const subscription = await f.subscribe()
	await expect(publishCliPalActivity(limits(subscription.id))).rejects.toThrow(
		'Complete owned original',
	)
	expect((await cliPalActivitySubscriptionStore().get(subscription.id))?.cursor).toBeNull()
	expect(await cliPalCommunicationStore().readIngress(subscription.recipient)).toBeNull()
})

it('checks each current grant again and refuses changed consent without progress', async () => {
	const f = await fixture()
	const subscription = await f.subscribe()
	const policy = cliPalActivitySubscriptionPolicy()
	await policy.update({
		subscriptionId: subscription.id,
		expectedRevision: 1,
		observe: true,
		disclose: false,
		receive: true,
		wake: false,
	})
	await expect(publishCliPalActivity(limits(subscription.id))).rejects.toThrow(
		'Current Pal observation',
	)
	expect((await cliPalActivitySubscriptionStore().get(subscription.id))?.cursor).toBeNull()
	expect(await cliPalCommunicationStore().readIngress(subscription.recipient)).toBeNull()
})

it('rejects foreign source membership and command option misuse, and disables with compare-and-set revision', async () => {
	const f = await fixture()
	await expect(
		subscribeCliPalActivity({
			sourcePalId: f.recipient.id,
			sourceSessionId: f.sessionId,
			recipientPalId: f.source.id,
			wake: true,
			signal: signal(),
		}),
	).rejects.toThrow('not claimed')
	const formatter = createFormatter('text', { quiet: true })
	vi.spyOn(formatter, 'print').mockImplementation(() => {})
	vi.spyOn(formatter, 'error').mockImplementation(() => {})
	const run = (...rawArgs: string[]) =>
		createPalCommand().handler({ ctx: { formatter, config: {} }, rawArgs })
	expect(await run('activity', 'id', '--wake')).toBe(EXIT_USAGE)
	expect(await run('activity', 'id', '--max-records', '257')).toBe(EXIT_USAGE)
	expect(await run('unsubscribe', 'id', '--revision', '')).toBe(EXIT_USAGE)
	const subscription = await f.subscribe()
	expect(await run('unsubscribe', subscription.id, '--revision', '1')).toBe(EXIT_UNAVAILABLE)
	expect((await cliPalActivitySubscriptionStore().get(subscription.id))?.enabled).toBe(true)
	expect(
		await run('unsubscribe', subscription.id, '--revision', String(subscription.revision)),
	).toBe(0)
	await expect(publishCliPalActivity(limits(subscription.id))).rejects.toThrow(
		'Current Pal observation',
	)
})
