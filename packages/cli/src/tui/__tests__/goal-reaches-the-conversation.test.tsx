/** A kernel goal is real only when App binds it to the active durable conversation. */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { DiskSessionGoalStore, type SessionGoalStore } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentSession, RunScope } from '../agent.js'
import type { TuiContext } from '../types.js'

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
const mounted: Array<{ unmount: () => void }> = []
const roots: string[] = []
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
	vi.restoreAllMocks()
	for (const harness of mounted.splice(0)) harness.unmount()
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

async function until(check: () => boolean, why: string): Promise<void> {
	const started = performance.now()
	while (!check() && performance.now() - started < 4_000) await tick()
	expect(check(), why).toBe(true)
}

async function submit(
	harness: { stdin: { write: (value: string) => void } },
	text: string,
): Promise<void> {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
	await tick(50)
}

it('writes /goal to the active Session and admits automatic work only there', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-goal-reach-'))
	roots.push(root)
	const harness = render(<App ctx={{ cwd: root, version: '0.0.0-test' } as TuiContext} />)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'the durable conversation never became ready')
	const source = scope?.sessionId
	if (!source) throw new Error('fixture requires a source conversation')

	await submit(harness, '/goal finish the durable release')
	await until(
		() => harness.frames.join('\n').includes('Goal created'),
		'the direct goal result never reached the transcript',
	)
	await until(() => sends === 1, 'the armed goal never admitted its automatic turn')
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
		() => harness.frames.join('\n').includes('No goal is currently set.'),
		'the new conversation did not read its own empty goal state',
	)
	expect(await reopened.goals.getGoal(source, reopened.tenantId)).toMatchObject({
		objective: 'finish the durable release',
	})
	expect(sends).toBe(1)
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

	const harness = render(<App ctx={{ cwd: root, version: '0.0.0-test' } as TuiContext} />)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'the durable conversation never became ready')
	const source = scope?.sessionId
	if (!source) throw new Error('fixture requires a source conversation')

	await submit(harness, '/goal ordered before new')
	await entered.promise
	await submit(harness, '/new')
	expect(scope?.sessionId).toBe(source)
	expect(harness.frames.join('\n')).toContain('A goal command is still reaching durable session state')

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
