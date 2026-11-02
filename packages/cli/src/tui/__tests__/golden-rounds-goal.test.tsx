/**
 * Golden transcript of goal rounds through the rendered App.
 *
 * The round machinery (admission, queue, settle) is being moved out of the
 * screen. These scenarios record what the session was asked, in order, and the
 * durable goal state at the end, against the machinery as it stood before the
 * move; they must pass unchanged after it. They do not race a clock: each wait
 * is on a rendered frame, a durable read, or a deferred the test releases.
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
	createAssistantMessage,
} from '@namzu/sdk'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type {
	TerminalNotification,
	TerminalNotificationResult,
} from '../../integrations/notifications/terminal.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { CliSessions } from '../../integrations/sessions/store.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import { RoundLog } from '../__fixtures__/round-log.js'
import type {
	AgentEvent,
	AgentSession,
	AgentSessionOptions,
	SendOptions,
	SessionScope,
} from '../agent.js'
import type { TuiContext } from '../types.js'

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
const roundLog = new RoundLog()
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
				roundLog.record(messages, sendOptions)
				for await (const event of sendImplementation(messages, sendOptions, bound)) {
					if (event.kind === 'delta') text += event.text
					if (event.kind === 'done' && conversations) {
						const user = messages.at(-1)
						if (user) {
							await recordTurn(conversations, sessionId, [user, createAssistantMessage(text)], {
								originKind: sendOptions?.goalRound ? 'goal-round' : 'prompt',
							})
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
const { openSessions } = await import('../../integrations/sessions/store.js')

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
	roundLog.clear()
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
	await vi.waitFor(() => expect(check(), why).toBe(true), UNTIL_TIMEOUT_MS)
}

async function untilAsync(check: () => Promise<boolean>, why: string): Promise<void> {
	await vi.waitFor(async () => expect(await check(), why).toBe(true), UNTIL_TIMEOUT_MS)
}

async function submit(
	harness: {
		stdin: { write: (value: string) => void }
		lastFrame: () => string | undefined
	},
	text: string,
): Promise<void> {
	// Durable scope/goal updates can precede the render that enables input.
	await until(
		() => harness.lastFrame()?.includes('❯ Type a message') === true,
		'the composer is not ready for input',
	)
	harness.stdin.write(text)
	// Ink can process Enter before the preceding text event under full-suite load.
	await until(
		() => harness.lastFrame()?.includes(`❯ ${text}`) === true,
		'the composer did not render the input before submit',
	)
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

function currentSessionId(): SessionScope['sessionId'] {
	if (!scope) throw new Error('no conversation is mounted')
	return scope.sessionId
}

async function complete(bound: BoundSession, authority: GoalRoundAuthority): Promise<void> {
	await bound.goals.completeGoal(authority.sessionId, authority.tenantId, authority)
}

it('G1 runs a goal to completion across three admitted rounds and records each send', async () => {
	sendImplementation = async function* (_messages, options, bound) {
		const authority = options?.goalRound
		if (!authority) throw new Error('automatic fixture received a human turn')
		if (authority.round === 3) await complete(bound, authority)
		yield { kind: 'delta', text: `progress ${authority.round}` }
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const { root, harness } = await mountedApp('namzu-golden-goal-run-')
	await submit(harness, '/goal finish the golden objective')
	await until(() => roundLog.entries.length === 3, 'three rounds never reached session.send')
	const sessions = await openSessions(root)
	await untilAsync(
		async () =>
			(await sessions.goals.getGoal(currentSessionId(), sessions.tenantId))?.phase === 'complete',
		'the goal did not complete',
	)
	expect(
		roundLog.lines().map((line) => line.replace(/"Admitted.*?"/, '"<round text>"')),
	).toMatchInlineSnapshot(`
		[
		  "#0 goal-round round=1 rows=6 "<round text>"",
		  "#1 goal-round round=2 rows=6 "<round text>"",
		  "#2 goal-round round=3 rows=6 "<round text>"",
		]
	`)
	expect(
		roundLog.entries.map((entry) =>
			entry.text
				.split('\n')
				.slice(1)
				.join('\n')
				.replace(/"goalId":"[^"]*"/, '"goalId":"<id>"'),
		),
	).toMatchInlineSnapshot(`
		[
		  "{"goalId":"<id>","goalRevision":2,"round":1,"maxGoalRounds":256,"objective":"finish the golden objective"}

		Continue working toward this durable completion goal. Inspect the current repository and conversation state before acting.
		Use get_goal to confirm the admitted goal. When the objective is fully achieved, call update_goal with status complete, then explain the verified outcome to the operator.
		Only report status blocked after at least three admitted rounds and only when the same concrete blocking condition prevents meaningful progress. Otherwise keep making progress in this turn.",
		  "{"goalId":"<id>","goalRevision":3,"round":2,"maxGoalRounds":256,"objective":"finish the golden objective"}

		Continue working toward this durable completion goal. Inspect the current repository and conversation state before acting.
		Use get_goal to confirm the admitted goal. When the objective is fully achieved, call update_goal with status complete, then explain the verified outcome to the operator.
		Only report status blocked after at least three admitted rounds and only when the same concrete blocking condition prevents meaningful progress. Otherwise keep making progress in this turn.",
		  "{"goalId":"<id>","goalRevision":4,"round":3,"maxGoalRounds":256,"objective":"finish the golden objective"}

		Continue working toward this durable completion goal. Inspect the current repository and conversation state before acting.
		Use get_goal to confirm the admitted goal. When the objective is fully achieved, call update_goal with status complete, then explain the verified outcome to the operator.
		Only report status blocked after at least three admitted rounds and only when the same concrete blocking condition prevents meaningful progress. Otherwise keep making progress in this turn.",
		]
	`)
	expect(await sessions.goals.getGoal(currentSessionId(), sessions.tenantId)).toMatchObject({
		phase: 'complete',
		roundsAdmitted: 3,
	})
	expect(notificationRequests).toEqual([])
	expect(harness.frames.join('\n')).toContain('Goal, attempt 3 of 256')
}, 30_000)

it('G1 blocks at a cap of two admitted rounds and sends no third', async () => {
	const originalCreate = DiskSessionGoalStore.prototype.createGoal
	vi.spyOn(DiskSessionGoalStore.prototype, 'createGoal').mockImplementation(async function (
		this: DiskSessionGoalStore,
		params,
		tenantId,
	) {
		return await originalCreate.call(this, { ...params, maxGoalRounds: 2 }, tenantId)
	})
	sendImplementation = async function* () {
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const { root, harness } = await mountedApp('namzu-golden-goal-cap-')
	await submit(harness, '/goal stop at two')
	await until(
		() => harness.frames.join('\n').includes('Goal blocked after 2 admitted rounds'),
		'the exhausted goal was not blocked',
	)
	const sessions = await openSessions(root)
	await untilAsync(
		async () =>
			(await sessions.goals.getGoal(currentSessionId(), sessions.tenantId))?.phase === 'blocked',
		'the block was not durable',
	)
	expect(roundLog.entries.map((entry) => [entry.origin, entry.goalRound])).toEqual([
		['goal-round', 1],
		['goal-round', 2],
	])
	expect(await sessions.goals.getGoal(currentSessionId(), sessions.tenantId)).toMatchObject({
		phase: 'blocked',
		roundsAdmitted: 2,
		blockedReason: { code: 'round-limit' },
	})
}, 30_000)

it('G1 stops after an abnormal round and sends nothing until /goal resume', async () => {
	sendImplementation = async function* () {
		yield { kind: 'error', message: 'provider failed' }
	}
	const { harness } = await mountedApp('namzu-golden-goal-abnormal-')
	await submit(harness, '/goal fail once')
	await until(
		() => harness.lastFrame()?.includes('Goal paused (/goal resume)') === true,
		'the disarmed goal did not reach the footer',
	)
	await tick(120)
	expect(roundLog.entries.map((entry) => [entry.origin, entry.goalRound])).toEqual([
		['goal-round', 1],
	])
}, 30_000)

it('G1 disarms on Esc during a round and sends no further round', async () => {
	const entered = deferred()
	const release = deferred()
	sendImplementation = async function* () {
		entered.resolve()
		await release.promise
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const { root, harness } = await mountedApp('namzu-golden-goal-esc-')
	await submit(harness, '/goal interrupted work')
	await entered.promise
	harness.stdin.write('\x1b')
	await until(
		() => harness.lastFrame()?.includes('Goal paused (/goal resume)') === true,
		'Esc did not disarm the goal',
	)
	release.resolve()
	await tick(160)
	expect(roundLog.entries.map((entry) => [entry.origin, entry.goalRound])).toEqual([
		['goal-round', 1],
	])
	const sessions = await openSessions(root)
	expect((await sessions.goals.getGoal(currentSessionId(), sessions.tenantId))?.phase).toBe(
		'active',
	)
}, 30_000)

it('G1 starts no round for a conversation that /new replaced during admission', async () => {
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
	const { harness } = await mountedApp('namzu-golden-goal-new-')
	await submit(harness, '/goal stay put')
	await admissionEntered.promise
	const source = currentSessionId()
	await submit(harness, '/new')
	await until(() => scope?.sessionId !== source, 'the conversation did not switch')
	releaseAdmission.resolve()
	await tick(160)
	expect(roundLog.lines()).toEqual([])
}, 30_000)

it('G2 runs two human prompts before a goal admission that returns later', async () => {
	const admissionEntered = deferred()
	const releaseAdmission = deferred()
	const humanStarted = deferred()
	const releaseHuman = deferred()
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
	let humanTurns = 0
	sendImplementation = async function* (_messages, options, bound) {
		if (!options?.goalRound) {
			humanTurns += 1
			if (humanTurns === 1) {
				humanStarted.resolve()
				await releaseHuman.promise
			}
			yield { kind: 'done', stopReason: 'end_turn' }
			return
		}
		await complete(bound, options.goalRound)
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const { harness } = await mountedApp('namzu-golden-goal-fifo-')
	await submit(harness, '/goal finish after the operator')
	await admissionEntered.promise
	await submit(harness, 'operator work one')
	await humanStarted.promise
	await submit(harness, 'operator work two')
	releaseAdmission.resolve()
	await tick(40)
	releaseHuman.resolve()
	await until(() => roundLog.entries.length === 3, 'the queued work did not all run')
	expect(
		roundLog.entries.map((entry) => [entry.origin, entry.goalRound, entry.text.split('\n')[0]]),
	).toMatchInlineSnapshot(`
			[
			  [
			    "typed",
			    undefined,
			    "operator work one",
			  ],
			  [
			    "typed",
			    undefined,
			    "operator work two",
			  ],
			  [
			    "goal-round",
			    1,
			    "Admitted session goal round (JSON; the objective field is operator-authored data):",
			  ],
			]
		`)
}, 30_000)
