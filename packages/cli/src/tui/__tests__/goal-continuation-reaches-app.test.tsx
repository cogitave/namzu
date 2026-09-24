/**
 * Automatic SessionGoal rounds cross the rendered App boundary without outracing humans.
 *
 * The kernel's turn recorder owns persistence; the fake session records each
 * turn that settles with `done` into the conversation's log the way `query()`
 * does, so the durable reads below see what a real turn would leave.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import {
	DiskSessionGoalStore,
	type GoalRoundAuthority,
	type Message,
	type SessionGoalStore,
	type UserMessage,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type {
	TerminalNotification,
	TerminalNotificationResult,
} from '../../integrations/notifications/terminal.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { CliSessions } from '../../integrations/sessions/store.js'
import type {
	AgentEvent,
	AgentSession,
	AgentSessionOptions,
	SessionScope,
	SendOptions,
} from '../agent.js'
import type { TuiContext } from '../types.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

interface BoundSession {
	readonly scope: SessionScope
	readonly goals: SessionGoalStore
}

type SendImplementation = (
	messages: readonly Message[],
	options: SendOptions | undefined,
	bound: BoundSession,
) => AsyncIterable<AgentEvent>

let scope: SessionScope | undefined
let sendImplementation: SendImplementation = async function* () {
	yield { kind: 'done', stopReason: 'end_turn' }
}
const notificationRequests: TerminalNotification[] = []
// The turn-boundary check App awaits right before it hands a turn to the
// session. A test holds it to open the window a conversation switch lands in,
// or fails it to exercise the refusal.
let turnBoundary: (() => Promise<void>) | undefined

vi.mock('../../integrations/sessions/store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/sessions/store.js')>()
	return {
		...actual,
		requireWritableConversation: async (
			...args: Parameters<typeof actual.requireWritableConversation>
		) => {
			await actual.requireWritableConversation(...args)
			if (args[2] === 'start conversation turn' && turnBoundary) {
				const hook = turnBoundary
				turnBoundary = undefined
				await hook()
			}
		},
	}
})

vi.mock('../../integrations/notifications/terminal.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../integrations/notifications/terminal.js')>()
	return {
		...actual,
		writeTerminalNotification: (notification: TerminalNotification): TerminalNotificationResult => {
			notificationRequests.push(notification)
			return { kind: 'request-sent' }
		},
	}
})

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (
			_preferences: Preferences,
			_detected: readonly unknown[],
			options: AgentSessionOptions,
		): Promise<AgentSession> => {
			if (!options.scope || !options.sessionGoals) {
				throw new Error('fixture requires the App durable scope and goal store')
			}
			scope = options.scope
			const bound = { scope: options.scope, goals: options.sessionGoals }
			const conversations = options.conversationSessions as CliSessions | undefined
			// Each turn that settles with `done` is recorded, user prompt and answer.
			async function* recorded(
				messages: readonly Message[],
				sendOptions: SendOptions | undefined,
			): AsyncIterable<AgentEvent> {
				const sessionId = bound.scope.sessionId
				let text = ''
				for await (const event of sendImplementation(messages, sendOptions, bound)) {
					if (event.kind === 'delta') text += event.text
					if (event.kind === 'done' && conversations) {
						const user = messages.at(-1)
						if (user) {
							await recordTurn(
								conversations,
								sessionId,
								[user, createAssistantMessage(text)],
								{ originKind: sendOptions?.goalRound ? 'goal-round' : 'prompt' },
							)
						}
					}
					yield event
				}
			}
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'goal-provider',
				modelSummary: 'goal-model',
				toolNames: () => [],
				presenter: genericPresenter,
				errorHint: null,
				errorKind: null,
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				agentIds: [],
				configNotices: [],
				approvalLatched: () => false,
				promptExemptTools: () => [],
				resumeDurable: async () => {
					throw new Error('not used')
				},
				resumePaused: () => {
					throw new Error('resumePaused is not part of this test')
				},
				close: async () => {},
				send: (messages, sendOptions) => recorded(messages, sendOptions),
			}
		},
	}
})

const { App } = await import('../App.js')
const { listRecent, loadConversation, openSessions, startConversation } = await import(
	'../../integrations/sessions/store.js'
)

const roots: string[] = []
const mounted: Array<{ unmount: () => void }> = []
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
	vi.restoreAllMocks()
	for (const harness of mounted.splice(0)) harness.unmount()
	for (const root of roots.splice(0)) removeTempDir(root)
	scope = undefined
	turnBoundary = undefined
	notificationRequests.length = 0
	sendImplementation = async function* () {
		yield { kind: 'done', stopReason: 'end_turn' }
	}
})

function deferred(): {
	readonly promise: Promise<void>
	readonly resolve: () => void
} {
	let resolve!: () => void
	return {
		promise: new Promise<void>((done) => {
			resolve = done
		}),
		resolve,
	}
}

// `until`/`untilAsync` poll a rendered frame or a durable store read after a
// driven event rather than sleeping a fixed delay, but the poll itself still
// needs a ceiling to fail instead of hanging forever. 5s was tuned against an
// idle machine; under a CPU-starved full-suite run the same setTimeout/promise
// callbacks this loop depends on land late, so the ceiling can be reached
// before the render or disk write it is waiting on has actually failed — the
// assertion below then fires early on a system that would have passed given a
// few more seconds. 20s keeps that assertion, not vitest's own `testTimeout`,
// as the thing that fails a genuine hang; each `it` in this file raises its
// own timeout to 30s (see the trailing argument on every test below) so the
// package's global 15s default (packages/cli/vitest.config.ts) cannot cut a
// slow-but-correct run off first.
const UNTIL_TIMEOUT_MS = 20_000

async function until(check: () => boolean, why: string): Promise<void> {
	const started = performance.now()
	while (!check() && performance.now() - started < UNTIL_TIMEOUT_MS) await tick()
	expect(check(), why).toBe(true)
}

async function untilAsync(check: () => Promise<boolean>, why: string): Promise<void> {
	const started = performance.now()
	let matched = await check()
	while (!matched && performance.now() - started < UNTIL_TIMEOUT_MS) {
		await tick()
		matched = await check()
	}
	expect(matched, why).toBe(true)
}

async function submit(
	harness: { stdin: { write: (value: string) => void }; lastFrame: () => string | undefined },
	text: string,
): Promise<void> {
	// Durable scope/goal updates can precede the render that enables input.
	await until(
		() => harness.lastFrame()?.includes('Type a message') === true,
		'the composer is not ready for input',
	)
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
	await tick(40)
}

async function mountedApp(prefix: string, tui?: TuiContext['tui']) {
	const root = await mkdtemp(join(tmpdir(), prefix))
	roots.push(root)
	const harness = render(
		<App
			ctx={
				{
					cwd: root,
					version: '0.0.0-test',
					...(tui ? { tui } : {}),
				} as TuiContext
			}
		/>,
	)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'the durable conversation never became ready')
	return { root, harness }
}

async function complete(bound: BoundSession, authority: GoalRoundAuthority): Promise<void> {
	await bound.goals.completeGoal(authority.sessionId, authority.tenantId, authority)
}

it('continues across admitted rounds, completes through run authority, and persists provenance', async () => {
	const calls: Array<{
		readonly messages: readonly Message[]
		readonly options?: SendOptions
	}> = []
	sendImplementation = async function* (messages, options, bound) {
		calls.push({ messages, ...(options ? { options } : {}) })
		const authority = options?.goalRound
		if (!authority) throw new Error('automatic fixture received a human turn')
		if (authority.round === 2) await complete(bound, authority)
		yield { kind: 'delta', text: `progress ${authority.round}` }
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { root, harness } = await mountedApp('namzu-goal-app-rounds-')
	await submit(harness, '/goal finish the verified release')
	await until(() => calls.length === 2, 'the second admitted round never reached session.send')
	const sessionId = scope!.sessionId

	const sessions = await openSessions(root)
	await untilAsync(
		async () => (await loadConversation(sessions, sessionId)).length === 4,
		'rounds were not persisted',
	)
	const durable = await loadConversation(sessions, sessionId)
	const goalUsers = durable.filter(
		(message): message is UserMessage =>
			message.role === 'user' && message.source?.type === 'goal-round',
	)
	expect(goalUsers.map((message) => message.source)).toEqual([
		expect.objectContaining({
			objective: 'finish the verified release',
			round: 1,
		}),
		expect.objectContaining({
			objective: 'finish the verified release',
			round: 2,
		}),
	])
	expect(calls.map((call) => call.options?.goalRound?.round)).toEqual([1, 2])
	expect(await sessions.goals.getGoal(sessionId, sessions.tenantId)).toMatchObject({
		phase: 'complete',
		roundsAdmitted: 2,
	})
	expect(
		(await listRecent(sessions)).find((conversation) => conversation.id === sessionId)?.title,
	).toBe('finish the verified release')
	expect(harness.frames.join('\n')).toContain('Goal round 2 / 256')
	expect(harness.frames.join('\n')).not.toContain('Admitted session goal round')

	await submit(harness, '/new')
	await until(
		() => scope?.sessionId !== sessionId,
		'the fresh conversation never replaced the source',
	)
	await submit(harness, '/resume')
	await until(
		() => (harness.lastFrame() ?? '').includes('Resume a conversation'),
		'the durable source was not offered for resume',
	)
	harness.stdin.write('\r')
	await until(
		() => (harness.lastFrame() ?? '').includes('Resumed: finish the verified release'),
		'the durable goal conversation was not restored',
	)
	expect(harness.lastFrame()).toContain('Goal round 2 / 256')
	expect(harness.lastFrame()).not.toContain('Admitted session goal round')
	await tick(100)
	expect(calls).toHaveLength(2)
}, 30_000)

it('keeps a human prompt ahead of a goal admission that returns later', async () => {
	const admissionEntered = deferred()
	const releaseAdmission = deferred()
	const humanStarted = deferred()
	const releaseHuman = deferred()
	const order: string[] = []
	let humanTurns = 0
	const originalAdmission = DiskSessionGoalStore.prototype.admitRound
	let held = false
	vi.spyOn(DiskSessionGoalStore.prototype, 'admitRound').mockImplementation(async function (
		this: DiskSessionGoalStore,
		sessionId,
		tenantId,
		ref,
	) {
		if (!held) {
			held = true
			admissionEntered.resolve()
			await releaseAdmission.promise
		}
		return await originalAdmission.call(this, sessionId, tenantId, ref)
	})
	sendImplementation = async function* (_messages, options, bound) {
		if (!options?.goalRound) {
			humanTurns += 1
			order.push(`human-${humanTurns}`)
			if (humanTurns === 1) {
				humanStarted.resolve()
				await releaseHuman.promise
			}
			yield { kind: 'delta', text: `human answer ${humanTurns}` }
			yield { kind: 'done', stopReason: 'end_turn' }
			return
		}
		order.push('goal')
		await complete(bound, options.goalRound)
		yield { kind: 'delta', text: 'goal answer' }
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { root, harness } = await mountedApp('namzu-goal-app-fifo-')
	await submit(harness, '/goal finish after the operator prompt')
	await admissionEntered.promise
	const sessionId = scope!.sessionId
	await submit(harness, 'operator work one')
	await humanStarted.promise
	await submit(harness, 'operator work two')
	releaseAdmission.resolve()
	await tick(40)
	releaseHuman.resolve()
	await until(() => order.length === 3, 'the reserved goal turn overtook or lost queued human work')
	expect(order).toEqual(['human-1', 'human-2', 'goal'])

	const sessions = await openSessions(root)
	await untilAsync(
		async () => (await loadConversation(sessions, sessionId)).length === 6,
		'FIFO was not persisted',
	)
	const durable = await loadConversation(sessions, sessionId)
	expect(
		durable
			.filter((message) => message.role === 'user')
			.map((message) => message.source?.type ?? 'human'),
	).toEqual(['human', 'human', 'goal-round'])
}, 30_000)

it('does not start an admitted old-conversation round after /new crosses the boundary', async () => {
	const admissionEntered = deferred()
	const releaseAdmission = deferred()
	const originalAdmission = DiskSessionGoalStore.prototype.admitRound
	vi.spyOn(DiskSessionGoalStore.prototype, 'admitRound').mockImplementation(async function (
		this: DiskSessionGoalStore,
		sessionId,
		tenantId,
		ref,
	) {
		admissionEntered.resolve()
		await releaseAdmission.promise
		return await originalAdmission.call(this, sessionId, tenantId, ref)
	})
	const sends: SendOptions[] = []
	sendImplementation = async function* (_messages, options) {
		if (options) sends.push(options)
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { harness } = await mountedApp('namzu-goal-app-switch-')
	await submit(harness, '/goal stay in the source conversation')
	await admissionEntered.promise
	const source = scope!.sessionId
	await submit(harness, '/new')
	await until(() => scope?.sessionId !== source, 'the conversation did not switch')
	releaseAdmission.resolve()
	await tick(150)

	expect(sends).toEqual([])
}, 30_000)

it('rechecks ownership after the turn-boundary await and before creating the provider generator', async () => {
	const evidenceEntered = deferred()
	const releaseEvidence = deferred()
	turnBoundary = async () => {
		evidenceEntered.resolve()
		await releaseEvidence.promise
	}
	let sends = 0
	sendImplementation = async function* () {
		sends += 1
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { harness } = await mountedApp('namzu-goal-app-pregenerator-')
	await submit(harness, '/goal stop before provider creation')
	await evidenceEntered.promise
	const source = scope!.sessionId
	await submit(harness, '/new')
	await until(() => scope?.sessionId !== source, 'the conversation did not switch during the boundary')
	releaseEvidence.resolve()
	await tick(160)

	expect(sends).toBe(0)
}, 30_000)

it('disarms after an abnormal turn and requires an explicit /goal resume', async () => {
	let calls = 0
	sendImplementation = async function* (_messages, options, bound) {
		calls += 1
		if (!options?.goalRound) throw new Error('fixture expected goal authority')
		if (calls === 1) {
			yield { kind: 'error', message: 'provider failed' }
			return
		}
		await complete(bound, options.goalRound)
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { root, harness } = await mountedApp('namzu-goal-app-failure-')
	await submit(harness, '/goal recover only when asked')
	await until(() => calls === 1, 'the first goal round never started')
	await tick(120)
	expect(calls).toBe(1)

	const sessions = await openSessions(root)
	await submit(harness, '/goal pause')
	await untilAsync(
		async () =>
			(await sessions.goals.getGoal(scope!.sessionId, sessions.tenantId))?.phase === 'paused',
		'the pause command did not reach durable goal state',
	)
	await until(
		() => harness.lastFrame()?.includes('Goal paused (/goal resume)') === true,
		'the durable paused goal did not reach the footer',
	)
	const statusFrame = harness.frames.length
	await submit(harness, '/goal status')
	await until(
		() =>
			/\bGoal\s*\n\s*Status: paused/.test(harness.frames.slice(statusFrame).join('\n')) &&
			harness.frames.slice(statusFrame).join('\n').includes('Automatic continuation: paused'),
		'the abnormal turn did not expose its disarmed state',
	)
	const resumeFrame = harness.frames.length
	await submit(harness, '/goal resume')
	await until(
		() => harness.frames.slice(resumeFrame).join('\n').includes('Goal resumed'),
		'the explicit resume command did not reach durable state',
	)
	await until(() => calls === 2, 'explicit resume did not admit another round')
	await tick(100)
	expect(calls).toBe(2)
}, 30_000)

it('does not let an abnormal automatic goal round pause queued human work', async () => {
	const goalEntered = deferred()
	const releaseGoal = deferred()
	const order: string[] = []
	sendImplementation = async function* (_messages, options) {
		if (options?.goalRound) {
			order.push('goal')
			goalEntered.resolve()
			await releaseGoal.promise
			yield { kind: 'error', message: 'goal provider failed' }
			return
		}
		order.push('human')
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { harness } = await mountedApp('namzu-goal-app-human-after-failure-')
	await submit(harness, '/goal fail without owning the human queue')
	await goalEntered.promise
	await submit(harness, 'independent operator work')
	releaseGoal.resolve()
	await until(() => order.length === 2, 'the failed goal round paused independent human work')

	expect(order).toEqual(['goal', 'human'])
	expect(harness.frames.join('\n')).not.toContain('paused after a failed turn')
}, 30_000)

it('durably blocks at the configured cap instead of starting an unbounded turn', async () => {
	const originalCreate = DiskSessionGoalStore.prototype.createGoal
	vi.spyOn(DiskSessionGoalStore.prototype, 'createGoal').mockImplementation(async function (
		this: DiskSessionGoalStore,
		params,
		tenantId,
	) {
		return await originalCreate.call(this, { ...params, maxGoalRounds: 1 }, tenantId)
	})
	let sends = 0
	sendImplementation = async function* () {
		sends += 1
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { root, harness } = await mountedApp('namzu-goal-app-cap-')
	await submit(harness, '/goal stop at the cap')
	await until(
		() => harness.frames.join('\n').includes('Goal blocked after 1 admitted round'),
		'the exhausted goal was not durably blocked',
	)
	const sessionId = scope!.sessionId
	await tick(100)
	expect(sends).toBe(1)
	const sessions = await openSessions(root)
	expect(await sessions.goals.getGoal(sessionId, sessions.tenantId)).toMatchObject({
		phase: 'blocked',
		roundsAdmitted: 1,
		blockedReason: { code: 'round-limit' },
	})
}, 30_000)

it('fails closed when the goal turn cannot pass its turn boundary', async () => {
	turnBoundary = async () => {
		throw new Error('conversation log unavailable')
	}
	let sends = 0
	sendImplementation = async function* () {
		sends += 1
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { root, harness } = await mountedApp('namzu-goal-app-boundary-')
	await submit(harness, '/goal require a writable conversation')
	await until(
		() => harness.frames.join('\n').includes('This turn was not started'),
		'the boundary refusal did not reach the operator',
	)
	const sessionId = scope!.sessionId
	expect(sends).toBe(0)
	const sessions = await openSessions(root)
	expect(await sessions.goals.getGoal(sessionId, sessions.tenantId)).toMatchObject({
		phase: 'active',
		roundsAdmitted: 1,
	})
	await submit(harness, '/goal status')
	await until(
		() => harness.frames.join('\n').includes('Automatic continuation: paused'),
		'the failed turn boundary did not disarm automatic work',
	)
}, 30_000)

it('suppresses per-round settled notifications while automatic work continues', async () => {
	let sends = 0
	sendImplementation = async function* (_messages, options, bound) {
		sends += 1
		if (!options?.goalRound) throw new Error('fixture expected goal authority')
		await complete(bound, options.goalRound)
		yield { kind: 'done', stopReason: 'end_turn' }
	}

	const { harness } = await mountedApp('namzu-goal-app-notification-', {
		notifications: ['turn-settled'],
	})
	await submit(harness, '/goal finish without per-round noise')
	await until(() => sends === 1, 'the admitted round never ran')
	await tick(120)
	expect(notificationRequests).toEqual([])
}, 30_000)

it.each(['resume', 'later'] as const)('asks before activating a resumed goal: %s', async (decision) => {
 const root = await mkdtemp(join(tmpdir(), 'namzu-goal-resume-choice-'))
 roots.push(root)
 const sessions = await openSessions(root)
 const sessionId = await startConversation(sessions)
 await recordTurn(sessions, sessionId, [createUserMessage('remember this work')])
 await sessions.goals.createGoal({ sessionId, objective: 'Finish the saved objective' }, sessions.tenantId)
 let resumedRounds = 0
 sendImplementation = async function* (_messages: readonly Message[], options: SendOptions | undefined, bound: BoundSession) {
  if (options?.goalRound) { resumedRounds++; await complete(bound, options.goalRound) }
  yield { kind: 'done', stopReason: 'end_turn' }
 }
 const harness = render(<App ctx={{ cwd: root, version: 'test', initialConversationId: sessionId }} />)
 mounted.push(harness)
 await until(() => harness.lastFrame()?.includes('Continue the saved goal?') === true, 'goal decision missing')
 expect(harness.lastFrame()).toContain('Finish the saved objective')
 expect(resumedRounds).toBe(0)
 await tick(40)
 if (decision === 'later') { harness.stdin.write('\x1b[B'); await tick(40) }
 harness.stdin.write('\r')
 if (decision === 'resume') await until(() => resumedRounds === 1, 'goal did not resume')
 else { await tick(100); expect(resumedRounds).toBe(0); expect(harness.lastFrame()).toContain('Goal paused (/goal resume)') }
}, 30_000)
