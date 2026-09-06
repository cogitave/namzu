/** A kernel goal is real only when App binds it to the active durable conversation. */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { DiskSessionGoalStore, type SessionGoalStore } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentSession, RunScope } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

let scope: RunScope | undefined
let sends = 0

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
			options: { readonly scope?: RunScope; readonly sessionGoals?: SessionGoalStore },
		): Promise<AgentSession> => {
			scope = options.scope
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'goal-provider',
				modelSummary: 'goal-model',
				toolNames: () => [],
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
				send: async function* (_messages, sendOptions) {
					sends += 1
					if (sendOptions?.goalRound && options.sessionGoals) {
						await options.sessionGoals.completeGoal(
							sendOptions.goalRound.sessionId,
							sendOptions.goalRound.tenantId,
							sendOptions.goalRound,
						)
					}
					yield { kind: 'done', stopReason: 'end_turn' } as const
				},
			}
		},
	}
})

const { App } = await import('../App.js')
const { openSessions } = await import('../../integrations/sessions/store.js')
const mounted: Array<{ unmount: () => Promise<void>; screen: Screen }> = []
const roots: string[] = []
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(async () => {
	vi.restoreAllMocks()
	for (const harness of mounted.splice(0)) await harness.unmount()
	for (const root of roots.splice(0)) removeTempDir(root)
	scope = undefined
	sends = 0
})

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void
	return {
		promise: new Promise<void>((done) => {
			resolve = done
		}),
		resolve,
	}
}

async function renderApp(root: string) {
	const screen = await renderToScreen(
		<App ctx={{ cwd: root, version: '0.0.0-test' } as TuiContext} />,
		{ cols: 100, rows: 30 },
	)
	return {
		screen,
		stdin: { write: (value: string) => screen.press(value) },
		lastFrame: () => screen.viewport().join('\n'),
		get frames() {
			return [screen.scrollback().join('\n')]
		},
		unmount: () => screen.unmount(),
	}
}

async function until(check: () => boolean, why: string): Promise<void> {
	await vi.waitFor(
		async () => {
			for (const harness of mounted) await harness.screen.waitForRender()
			expect(check(), why).toBe(true)
		},
		{ timeout: 4_000 },
	)
}

async function submit(harness: Awaited<ReturnType<typeof renderApp>>, text: string): Promise<void> {
	harness.stdin.write(text)
	await harness.screen.waitForRender()
	harness.stdin.write('\r')
	await harness.screen.waitForRender()
}

it('writes /goal to the active Session and admits automatic work only there', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-goal-reach-'))
	roots.push(root)
	const harness = await renderApp(root)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'the durable conversation never became ready')

	await submit(harness, '/goal finish the durable release')
	await until(
		() => harness.frames.join('\n').includes('Goal created'),
		'the direct goal result never reached the transcript',
	)
	await until(() => sends === 1, 'the armed goal never admitted its automatic turn')
	const source = scope?.sessionId
	if (!source) throw new Error('fixture requires a source conversation')
	const reopened = await openSessions(root)
	await vi.waitFor(
		async () => {
			expect(await reopened.goals.getGoal(source, reopened.tenantId)).toMatchObject({
				sessionId: source,
				objective: 'finish the durable release',
				phase: 'complete',
			})
		},
		{ timeout: 4_000 },
	)
	expect(sends).toBe(1)

	await submit(harness, '/new')
	await until(() => scope?.sessionId !== source, 'the new conversation did not replace the scope')
	await submit(harness, '/goal')
	await until(
		() => harness.frames.join('\n').includes('No goal set for this conversation.'),
		'the new conversation did not read its own empty goal state',
	)
	expect(await reopened.goals.getGoal(source, reopened.tenantId)).toMatchObject({
		objective: 'finish the durable release',
	})
	expect(sends).toBe(1)
})

it('inspects status without creating a goal, then starts only after an objective is submitted', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-goal-menu-'))
	roots.push(root)
	const harness = await renderApp(root)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'conversation did not become ready')
	await submit(harness, '/goal status')
	await until(
		() => harness.frames.join('\n').includes('No goal is currently set.'),
		'status was not read',
	)
	const sessions = await openSessions(root)
	const sessionId = scope!.sessionId
	expect(await sessions.goals.getGoal(sessionId, sessions.tenantId)).toBeNull()
	expect(sends).toBe(0)
	await submit(harness, '/goal')
	await until(() => harness.lastFrame()?.includes('/goal set') ?? false, 'goal menu did not open')
	expect(sends).toBe(0)
	harness.stdin.write('\r')
	await until(
		() => harness.lastFrame()?.includes('Set a goal') ?? false,
		'objective editor did not open',
	)
	expect(sends).toBe(0)
	await submit(harness, 'finish the menu flow')
	await vi.waitFor(
		async () => {
			expect(await sessions.goals.getGoal(sessionId, sessions.tenantId)).toMatchObject({
				objective: 'finish the menu flow',
				phase: 'complete',
			})
		},
		{ timeout: 4_000 },
	)
	expect(sends).toBe(1)
})

it('returns to help when an asynchronous goal menu is cancelled and ignores its late read', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-goal-menu-cancel-'))
	roots.push(root)
	const harness = await renderApp(root)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'conversation did not become ready')
	await submit(harness, '/goal status')
	await until(
		() => harness.frames.join('\n').includes('No goal is currently set.'),
		'initial read did not finish',
	)
	await submit(harness, '/help')
	const entered = deferred()
	const release = deferred()
	vi.spyOn(DiskSessionGoalStore.prototype, 'getGoal').mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
		return null
	})
	await submit(harness, '/goal')
	await entered.promise
	await until(
		() => harness.lastFrame()?.includes('Loading goal') ?? false,
		'goal loading menu never appeared',
	)
	harness.stdin.write('\x1B')
	await tick(50)
	expect(harness.lastFrame()).not.toContain('Loading goal')
	expect(harness.lastFrame()).toContain('/settings')
	release.resolve()
	await tick(75)
	expect(harness.lastFrame()).not.toContain('No goal set for this conversation.')
	expect(harness.lastFrame()).toContain('/settings')
	expect(sends).toBe(0)
})

it('shows effective settings without sending a turn or changing them on cancel', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-settings-menu-'))
	roots.push(root)
	const harness = await renderApp(root)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'conversation did not become ready')
	await submit(harness, '/settings')
	await until(
		() => harness.lastFrame()?.includes('Settings') ?? false,
		'settings menu did not open',
	)
	expect(harness.lastFrame()).toContain('goal-provider')
	expect(harness.lastFrame()).toContain('goal-model')
	expect(harness.lastFrame()).toContain('prompt')
	expect(sends).toBe(0)
	harness.stdin.write('\x1B')
	await tick(50)
	expect(harness.lastFrame()).not.toContain('Select a setting')
	expect(sends).toBe(0)
})

it('does not let a later conversation command overtake a pending durable goal write', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-goal-order-'))
	roots.push(root)
	const entered = deferred()
	const release = deferred()
	const createGoal = DiskSessionGoalStore.prototype.createGoal
	vi.spyOn(DiskSessionGoalStore.prototype, 'createGoal').mockImplementation(async function (
		this: DiskSessionGoalStore,
		params,
		tenantId,
	) {
		entered.resolve()
		await release.promise
		return await createGoal.call(this, params, tenantId)
	})

	const harness = await renderApp(root)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'the durable conversation never became ready')

	await submit(harness, '/goal ordered before new')
	await entered.promise
	const source = scope?.sessionId
	if (!source) throw new Error('fixture requires a source conversation')
	await submit(harness, '/new')
	expect(scope?.sessionId).toBe(source)
	expect(harness.frames.join('\n')).toContain(
		'A goal command is still reaching durable session state',
	)

	release.resolve()
	await until(
		() => harness.frames.join('\n').includes('Goal created'),
		'the held goal command never completed',
	)
	await submit(harness, '/new')
	await until(() => scope?.sessionId !== source, 'the later /new did not run after goal settlement')

	const reopened = await openSessions(root)
	expect(await reopened.goals.getGoal(source, reopened.tenantId)).toMatchObject({
		objective: 'ordered before new',
	})
	// Whether the armed turn starts before the SECOND /new is scheduler
	// timing after the durable goal write has already settled, not the
	// ordering invariant this case owns. The preceding case proves automatic
	// turn reachability; this one proves the held write cannot be overtaken.
})
