import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import {
	InMemorySessionLog,
	foldTurnOutcomes,
	readOutcomeProgress,
	readTurnOutcome,
} from '../../../store/session-log/index.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type {
	SessionEvent,
	SessionRecord,
	TurnOutcomeConfig,
} from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { readParks } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import { heldCheckpointStore } from './support/session.js'

/**
 * The outcome record, through a real turn: tools that report what they did as
 * typed facts, a scripted model, and a workspace the tools move by hand.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const RUN_CONFIG = {
	model: 'mock-model',
	timeoutMs: 30_000,
	tokenBudget: 100_000,
	maxIterations: 8,
	maxResponseTokens: 256,
}

/** A workspace the tools change and a detector that reports it. */
function fakeWorkspace() {
	const state = { fingerprint: 'w0', asked: 0, version: 0 }
	const outcome: TurnOutcomeConfig = {
		detectChanges: async () => {
			state.asked += 1
			return state.fingerprint
		},
	}
	const move = () => {
		state.version += 1
		state.fingerprint = `w${state.version}`
	}
	return { state, outcome, move }
}

function tools(move: () => void = () => {}): Toolset {
	return testToolset(
		defineTool({
			name: 'edit',
			description: 'edit a file',
			inputSchema: z.object({ path: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input) => {
				move()
				return {
					success: true,
					output: 'edited',
					facts: { kind: 'edit', path: input.path, replacements: 1 },
				}
			},
		}),
		defineTool({
			name: 'read',
			description: 'read a file',
			inputSchema: z.object({ path: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async (input) => ({
				success: true,
				output: 'text',
				facts: { kind: 'read', path: input.path },
			}),
		}),
		defineTool({
			name: 'bash',
			description: 'run a command',
			inputSchema: z.object({
				command: z.string(),
				exit: z.number().optional(),
				moves: z.boolean().optional(),
			}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input) => {
				if (input.moves) move()
				const exitCode = input.exit ?? 0
				return {
					success: exitCode === 0,
					output: exitCode === 0 ? 'ok' : 'failed',
					...(exitCode === 0 ? {} : { error: `Command exited with code ${exitCode}` }),
					facts: { kind: 'command', command: input.command, exitCode },
				}
			},
		}),
	)
}

async function run(
	turns: MockTurn[],
	toolset: Toolset,
	outcome?: TurnOutcomeConfig,
	sessionLog?: InMemorySessionLog,
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-outcome-'))
	dirs.push(workingDirectory)
	const events: SessionEvent[] = []
	const turn = await drainQuery(
		{
			provider: new MockLLMProvider({ turns }),
			toolsets: [toolset],
			turnConfig: { ...RUN_CONFIG, ...(outcome ? { outcome } : {}) },
			agentId: 'agent_outcome',
			agentName: 'Outcome',
			messages: [{ role: 'user', content: 'fix the bug' }],
			workingDirectory,
			sessionId: sessionLog?.sessionId ?? generateSessionId(),
			...(sessionLog ? { sessionLog } : {}),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			retry: false,
		} as unknown as QueryParams,
		(event) => {
			events.push(event)
		},
	)
	return { turn, events }
}

const edit = (path = 'a.ts'): MockTurn => ({
	toolCalls: [{ name: 'edit', args: { path } }],
})
const shell = (command: string, extra: Record<string, unknown> = {}): MockTurn => ({
	toolCalls: [{ name: 'bash', args: { command, ...extra } }],
})

function settledOutcome(events: readonly SessionEvent[]) {
	const done = events.find((e) => e.type === 'turn_completed')
	return done?.type === 'turn_completed' ? done.settlement?.outcome : undefined
}

describe('a turn that changed a file', () => {
	it('is checked when a check passed after the change, on the calls alone', async () => {
		const { turn, events } = await run([edit(), shell('pnpm test'), { text: 'done' }], tools())
		expect(turn.outcome).toMatchObject({
			verdict: 'checked',
			basis: 'calls',
			changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false },
			checks: [{ command: 'pnpm test', step: 2, result: 'passed', exitCode: 0, fresh: true }],
		})
		// The live end event carries the same record, in memory only.
		expect(settledOutcome(events)).toEqual(turn.outcome)
	})

	it('is unchecked when nothing was run', async () => {
		const { turn } = await run([edit(), { text: 'done' }], tools())
		expect(turn.outcome?.verdict).toBe('unchecked')
	})

	it('is failing when the check failed, whatever the model then says', async () => {
		const { turn } = await run(
			[edit(), shell('pnpm test', { exit: 1 }), { text: 'All tests pass.' }],
			tools(),
		)
		expect(turn.result).toBe('All tests pass.')
		expect(turn.outcome?.verdict).toBe('failing')
		expect(turn.outcome?.checks[0]).toMatchObject({ result: 'failed', exitCode: 1 })
	})

	it('is stale when it changed again after the check', async () => {
		const { turn } = await run(
			[edit('a.ts'), shell('pnpm test'), edit('b.ts'), { text: 'done' }],
			tools(),
		)
		expect(turn.outcome?.verdict).toBe('stale')
		expect(turn.outcome?.changes.paths).toEqual(['a.ts', 'b.ts'])
	})

	it('does not count a check whose pipe hides the answer', async () => {
		const { turn } = await run([edit(), shell('pnpm test | tail -5'), { text: 'done' }], tools())
		expect(turn.outcome?.verdict).toBe('inconclusive')
		expect(turn.outcome?.checks[0]?.result).toBe('masked')
	})
})

describe('the outcome in the session log', () => {
	async function logged(turns: MockTurn[]) {
		const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() })
		const { turn } = await run(turns, tools(), undefined, sessionLog)
		const records: SessionRecord[] = []
		for await (const { record } of sessionLog.read()) records.push(record)
		return { turn, sessionLog, records }
	}

	it('is recovered by the reader as the turn had it', async () => {
		const { turn, sessionLog, records } = await logged([
			edit(),
			shell('pnpm test'),
			{ text: 'done' },
		])
		expect(turn.outcome?.verdict).toBe('checked')
		expect(await readTurnOutcome(sessionLog, turn.id)).toEqual(turn.outcome)
		expect(foldTurnOutcomes(records).get(turn.id)).toEqual(turn.outcome)
	})

	it('is a record of its own just before the end record, and not a field of it', async () => {
		const { records } = await logged([edit(), { text: 'done' }])
		const types = records.map((r) => r.type)
		const end = types.indexOf('turn_completed')
		expect(types[end - 1]).toBe('turn_outcome_recorded')
		expect(records[end - 1]).toMatchObject({ ignorable: true })
		const closing = records[end]
		if (closing?.type !== 'turn_completed') throw new Error('no end record')
		expect(Object.keys(closing.settlement)).not.toContain('outcome')
	})
})

describe('a turn that changed nothing', () => {
	it('is unchanged, with no check asked of the detector', async () => {
		const { state, outcome } = fakeWorkspace()
		const { turn } = await run(
			[{ toolCalls: [{ name: 'read', args: { path: 'a.ts' } }] }, { text: 'it is fine' }],
			tools(),
			outcome,
		)
		expect(turn.outcome).toMatchObject({ verdict: 'unchanged', basis: 'calls' })
		expect(state.asked).toBe(0)
	})

	it('has a record even when it called no tool at all', async () => {
		const { turn, events } = await run([{ text: 'hello' }], tools())
		expect(turn.outcome?.verdict).toBe('unchanged')
		expect(settledOutcome(events)?.verdict).toBe('unchanged')
	})
})

describe('a turn with a change detector', () => {
	it('compares the workspace at the start, after the check and at the end', async () => {
		const { state, outcome, move } = fakeWorkspace()
		const { turn } = await run([edit(), shell('pnpm test'), { text: 'done' }], tools(move), outcome)
		expect(turn.outcome).toMatchObject({
			verdict: 'checked',
			basis: 'workspace',
			checks: [{ fresh: true }],
		})
		expect(state.asked).toBe(3)
	})

	it('sees a change a shell command made that no write tool explains', async () => {
		const { outcome, move } = fakeWorkspace()
		const { turn } = await run(
			[shell('sed -i s/a/b/ a.ts', { moves: true }), { text: 'done' }],
			tools(move),
			outcome,
		)
		expect(turn.outcome).toMatchObject({
			verdict: 'unchecked',
			basis: 'workspace',
			changes: { total: 0, outsideKnownTools: true },
		})
	})

	it('calls a check stale when a shell command changed the workspace after it', async () => {
		const { outcome, move } = fakeWorkspace()
		const { turn } = await run(
			[edit(), shell('pnpm test'), shell('sed -i s/a/b/ a.ts', { moves: true }), { text: 'done' }],
			tools(move),
			outcome,
		)
		expect(turn.outcome?.verdict).toBe('stale')
		expect(turn.outcome?.checks[0]?.fresh).toBe(false)
	})

	it('keeps the record on the calls when the detector has no answer', async () => {
		const { turn } = await run([edit(), shell('pnpm test'), { text: 'done' }], tools(), {
			detectChanges: async () => null,
		})
		expect(turn.outcome).toMatchObject({ verdict: 'checked', basis: 'calls' })
	})
})

describe('a turn resumed from a checkpoint', () => {
	const SCOPE: TurnStateScope = {
		turnId: fixtureId.turn('outcome-resume'),
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
	}
	const gate = {
		enabled: true,
		rules: [{ type: 'allow_by_name' as const, toolNames: ['edit', 'bash', 'read'] }],
		allowReadOnlyTools: false,
		denyDangerousPatterns: false,
		logDecisions: false,
	}
	const script: MockTurn[] = [
		edit('a.ts'),
		shell('pnpm test'),
		shell('pnpm lint'),
		{ text: 'done' },
	]

	async function pauseAfterTwoSteps(workingDirectory: string, outcome?: TurnOutcomeConfig) {
		const sessionLog = new InMemorySessionLog({ sessionId: SCOPE.sessionId })
		let asked = 0
		await drainQuery(
			{
				provider: new MockLLMProvider({ turns: script }),
				toolsets: [tools()],
				sessionLog,
				agentId: 'agent_outcome',
				agentName: 'Outcome',
				messages: [{ role: 'user', content: 'fix the bug' }],
				workingDirectory,
				turnId: SCOPE.turnId,
				tenantId: SCOPE.tenantId,
				projectId: SCOPE.projectId,
				sessionId: SCOPE.sessionId,
				topicId: SCOPE.topicId,
				authorizationGate: gate,
				resumeHandler: async (request: HITLDecisionRequest) => {
					if (request.type !== 'iteration_checkpoint') return { action: 'continue' }
					asked += 1
					return asked === 1 ? { action: 'pause', reason: 'stop here' } : { action: 'continue' }
				},
				turnConfig: { ...RUN_CONFIG, ...(outcome ? { outcome } : {}) },
			} as unknown as QueryParams,
			() => {},
		)
		const store = await heldCheckpointStore(sessionLog)
		const parks = await readParks(sessionLog, { turnId: SCOPE.turnId })
		const parked = await Promise.all(
			parks.map((park) => store.read({ ...SCOPE }, park.checkpointId)),
		)
		return { sessionLog, store, parked: parked[0] }
	}

	it('keeps the change it made before the checkpoint', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-outcome-resume-'))
		dirs.push(workingDirectory)
		const { sessionLog, store, parked } = await pauseAfterTwoSteps(workingDirectory)
		// What the record had gathered is in the log, named by the checkpoint.
		const progress = parked ? await readOutcomeProgress(sessionLog, parked.checkpointId) : undefined
		expect(progress).toBeDefined()
		expect(parked).not.toHaveProperty('outcome')
		const doneSoFar = Math.max(1, parked?.iteration ?? 1)

		const resumed = await resumeSession({
			scope: SCOPE,
			sessionLog,
			checkpointStore: store,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			pendingDecision: { action: 'continue' },
			provider: new MockLLMProvider({ turns: [...script.slice(doneSoFar)] }),
			toolsets: [tools()],
			agentId: 'agent_outcome',
			agentName: 'Outcome',
			workingDirectory,
			authorizationGate: gate,
			turnConfig: RUN_CONFIG,
		} as unknown as ResumeSessionParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		const outcome = resumed.turn.outcome
		// The edit came before the checkpoint. A record begun again at the resume
		// would call this turn unchanged.
		expect(outcome?.changes.paths).toEqual(['a.ts'])
		expect(outcome?.verdict).not.toBe('unchanged')
		expect(outcome?.checks.length).toBeGreaterThan(0)
	})

	it('reports no outcome when the checkpoint it resumes from kept none', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-outcome-resume-'))
		dirs.push(workingDirectory)
		const { sessionLog, store, parked } = await pauseAfterTwoSteps(workingDirectory)
		if (!parked) throw new Error('no parked checkpoint')
		// A checkpoint written before the record existed has no progress record
		// in the log: read the log as if that record were not there.
		const read = sessionLog.read.bind(sessionLog)
		sessionLog.read = ((options?: Parameters<typeof read>[0]) =>
			(async function* () {
				const walk = read(options)
				for (;;) {
					const step = await walk.next()
					if (step.done) return step.value
					if (step.value.record.type === 'outcome_progress_written') continue
					yield step.value
				}
			})()) as typeof sessionLog.read

		const resumed = await resumeSession({
			scope: SCOPE,
			sessionLog,
			checkpointStore: store,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			pendingDecision: { action: 'continue' },
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			toolsets: [tools()],
			agentId: 'agent_outcome',
			agentName: 'Outcome',
			workingDirectory,
			authorizationGate: gate,
			turnConfig: RUN_CONFIG,
		} as unknown as ResumeSessionParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		expect(resumed.turn.outcome).toBeUndefined()
	})
})
