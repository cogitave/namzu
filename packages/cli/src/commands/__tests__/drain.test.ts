/**
 * `namzu drain` — the caller the cross-process claim never had.
 *
 * The tests that matter here are the REACHABILITY ones. Every piece this
 * command composes was already covered by its own unit tests when nothing
 * called any of it, so a suite that only re-tested the pieces would stay
 * green through the exact defect this command exists to fix. So: delete the
 * `drainRuns` call and the first block fails; delete `claimFence` from the
 * resume and the second block fails; delete the command from the registry
 * and the third fails.
 */

import { describe, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

const drainRuns = vi.fn()
const constructedStores: unknown[] = []

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		configureLogger: () => {},
		drainRuns: (params: unknown) => drainRuns(params),
		DiskCheckpointStore: class {
			constructor(config: unknown, attribution: unknown) {
				constructedStores.push({ config, attribution })
			}
		},
	}
})

// Standing in a trusted folder is the ordinary production state; the refusal
// for an untrusted one is the headless trust gate's own test.
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

// Declared WITH its parameter, so `mock.calls[0][0]` is a value rather than
// a tuple index that does not exist. A zero-arg `vi.fn` types the call tuple
// as `[]`, and the fence assertion below — the one this file exists for —
// would have had to be written against `undefined`.
const resumeDurable = vi.fn(async (_params: { entry: { runId: string }; claimFence?: number }) => ({
	resumed: true as const,
	run: { status: 'completed' },
	state: {},
}))

const sessionStub = fakeAgentSession({
	resumeDurable: resumeDurable as unknown as ReturnType<typeof fakeAgentSession>['resumeDurable'],
})

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => sessionStub),
}))

const { drainCommand, parseDrainFlags, resolveDrainScope } = await import('../drain.js')

function contextCapturing(): {
	ctx: CommandContext
	printed: unknown[]
	errors: string[]
	info: string[]
} {
	const printed: unknown[] = []
	const errors: string[] = []
	const info: string[] = []
	const ctx = {
		formatter: {
			name: 'json' as const,
			print: (d: unknown) => printed.push(d),
			info: (m: unknown) => info.push(String(m)),
			error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, printed, errors, info }
}

const SCOPE_ARGS = [
	'--store',
	'/tmp/runs',
	'--tenant',
	'tnt_x',
	'--project',
	'prj_x',
	'--session',
	'ses_x',
]

const ENTRY = {
	tenantId: 'tnt_x',
	projectId: 'prj_x',
	sessionId: 'ses_x',
	runId: 'run_1',
	checkpointCount: 2,
	latestCheckpointId: 'cp_2',
	latestCheckpointAt: 5,
}

const CLAIM = { holder: 'w', fence: 7, expiresAt: Date.now() + 60_000 }

/** A `drainRuns` that yields one run to whatever `onRun` it was handed. */
function drainsOneRun(): void {
	drainRuns.mockImplementation(async (params: { onRun: (e: unknown, c: unknown) => unknown }) => {
		await params.onRun(ENTRY, CLAIM)
		return {
			listed: 1,
			drained: ['run_1'],
			skipped: [],
			stale: [],
			failed: [],
			unreleased: [],
			stopped: false,
		}
	})
}

describe('refusing a pass whose scope nobody named', () => {
	it('refuses without a store rather than defaulting to a path', () => {
		const flags = parseDrainFlags(['--tenant', 'tnt_x'])
		expect(flags.store).toBeNull()
	})

	it('refuses a listing with no tenant', () => {
		expect(resolveDrainScope({ tenant: null, project: 'p', session: 's' })).toMatchObject({
			error: expect.stringContaining('--tenant is required'),
		})
	})

	it('refuses a disk store it cannot attribute', () => {
		expect(resolveDrainScope({ tenant: 't', project: null, session: 's' })).toMatchObject({
			error: expect.stringContaining('--project and --session'),
		})
	})

	it('takes the full prefix when it is given', () => {
		expect(resolveDrainScope({ tenant: 'tnt_a', project: 'prj_a', session: 'ses_a' })).toEqual({
			tenantId: 'tnt_a',
			projectId: 'prj_a',
			sessionId: 'ses_a',
		})
	})

	it('collects an unrecognised flag, and the value it stranded', () => {
		// Both, not just the flag. This command takes no positional arguments,
		// so `tnt_x` really is unrecognised once `--tenat` failed to consume
		// it — and reporting only the typo would leave the operator reading a
		// refusal that does not mention the id they thought they passed.
		expect(parseDrainFlags(['--tenat', 'tnt_x']).unknown).toEqual(['--tenat', 'tnt_x'])
	})

	it('reads a value written with an equals sign', () => {
		const flags = parseDrainFlags(['--store=/a/b', '--ttl=1234', '--max-concurrent=4'])
		expect(flags.store).toBe('/a/b')
		expect(flags.ttlMs).toBe(1234)
		expect(flags.maxConcurrent).toBe(4)
	})
})

describe('the command refuses before it opens anything', () => {
	it('exits 64 with no --store, and never reaches the drain', async () => {
		drainRuns.mockClear()
		const { ctx, errors } = contextCapturing()
		const code = await drainCommand.handler({ ctx, rawArgs: ['--tenant', 'tnt_x'] })
		expect(code).toBe(64)
		expect(errors[0]).toContain('--store is required')
		expect(drainRuns).not.toHaveBeenCalled()
	})

	it('exits 64 on a lease that has already expired', async () => {
		drainRuns.mockClear()
		const { ctx, errors } = contextCapturing()
		const code = await drainCommand.handler({ ctx, rawArgs: [...SCOPE_ARGS, '--ttl', '0'] })
		expect(code).toBe(64)
		expect(errors[0]).toContain('--ttl must be a positive number')
		expect(drainRuns).not.toHaveBeenCalled()
	})
})

describe('the drain is actually reached', () => {
	it('drains the scope the operator named, under a holder and a lease', async () => {
		drainRuns.mockClear()
		drainsOneRun()
		const { ctx } = contextCapturing()

		const code = await drainCommand.handler({
			ctx,
			rawArgs: [...SCOPE_ARGS, '--holder', 'w_one', '--ttl', '1000', '--max-concurrent', '3'],
		})

		expect(code).toBe(0)
		expect(drainRuns).toHaveBeenCalledTimes(1)
		expect(drainRuns.mock.calls[0]?.[0]).toMatchObject({
			scope: { tenantId: 'tnt_x', projectId: 'prj_x', sessionId: 'ses_x' },
			holder: 'w_one',
			ttlMs: 1000,
			maxConcurrent: 3,
		})
	})

	it('mints a per-process holder when none was named', async () => {
		drainRuns.mockClear()
		drainsOneRun()
		const { ctx } = contextCapturing()
		await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })
		const holder = (drainRuns.mock.calls[0]?.[0] as { holder: string }).holder
		// The claim contract says `holder` must be unique per PROCESS: two
		// workers sharing one string take live, unexpired claims from each
		// other instantly. A constant default would be exactly that bug.
		expect(holder).toContain(String(process.pid))
	})
})

describe('the resume is actually reached, carrying the fence', () => {
	it('continues each claimed run under the fence of the claim it was given', async () => {
		drainRuns.mockClear()
		resumeDurable.mockClear()
		drainsOneRun()
		const { ctx } = contextCapturing()

		const code = await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })

		expect(code).toBe(0)
		expect(resumeDurable).toHaveBeenCalledTimes(1)
		const params = resumeDurable.mock.calls[0]?.[0] as unknown as {
			entry: { runId: string }
			claimFence: number
		}
		expect(params.entry.runId).toBe('run_1')
		// Deleting `claimFence` here leaves every durable write the resumed run
		// makes unfenced — so a drainer stalled past its lease overwrites the
		// record of whoever took the run over, with no error anywhere. This
		// assertion is the only thing standing between that and green.
		expect(params.claimFence).toBe(7)
	})

	it('reports a parked run instead of resuming past the question', async () => {
		drainRuns.mockClear()
		resumeDurable.mockClear()
		resumeDurable.mockResolvedValueOnce({
			resumed: false,
			reason: 'awaiting-decision',
		} as unknown as Awaited<ReturnType<typeof resumeDurable>>)
		drainsOneRun()
		const { ctx, printed } = contextCapturing()

		const code = await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })

		expect(code).toBe(0)
		expect(printed[0]).toMatchObject({ awaitingDecision: ['run_1'], resumed: 0 })
	})

	it('reports a run with nothing to continue as its own outcome', async () => {
		drainRuns.mockClear()
		resumeDurable.mockClear()
		resumeDurable.mockResolvedValueOnce({
			resumed: false,
			reason: 'no-checkpoint',
		} as unknown as Awaited<ReturnType<typeof resumeDurable>>)
		drainsOneRun()
		const { ctx, printed } = contextCapturing()

		await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })

		// Distinct from `awaitingDecision`: one is a question waiting on a
		// person and the other is a dead end, and an operator who cannot tell
		// them apart either chases a human who owes nothing or ignores one who
		// does.
		expect(printed[0]).toMatchObject({ noCheckpoint: ['run_1'], awaitingDecision: [] })
	})
})

describe('what the pass reports', () => {
	it('exits 1 and names the run when work failed', async () => {
		drainRuns.mockClear()
		drainRuns.mockResolvedValueOnce({
			listed: 2,
			drained: [],
			skipped: [],
			stale: [],
			failed: [{ runId: 'run_bad', error: 'provider refused' }],
			unreleased: [],
			stopped: false,
		})
		const { ctx, errors } = contextCapturing()

		const code = await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })

		expect(code).toBe(1)
		expect(errors.join(' ')).toContain('run_bad: provider refused')
	})

	it('surfaces a refusal from the drain rather than reporting an empty pass', async () => {
		drainRuns.mockClear()
		drainRuns.mockRejectedValueOnce(new Error('does not implement `claimRun`'))
		const { ctx, errors } = contextCapturing()

		const code = await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })

		// "Nothing was parked" and "this store cannot arbitrate a queue" are
		// opposite facts, and a command that reported the first for the second
		// would have an operator believe their inbox is empty.
		expect(code).toBe(1)
		expect(errors.join(' ')).toContain('claimRun')
	})

	it('reports a lease it could not hand back', async () => {
		drainRuns.mockClear()
		drainRuns.mockResolvedValueOnce({
			listed: 1,
			drained: ['run_1'],
			skipped: [],
			stale: [],
			failed: [],
			unreleased: [{ runId: 'run_1', error: 'disk went away' }],
			stopped: false,
		})
		const { ctx, errors, printed } = contextCapturing()

		const code = await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })

		// The work landed, so this is not a failure — but the run is invisible
		// to the next reader until the lease lapses, and that is a fact an
		// operator watching throughput has to be given.
		expect(code).toBe(0)
		expect(errors.join(' ')).toContain('lease not released')
		expect(printed[0]).toMatchObject({ unreleased: [{ runId: 'run_1' }] })
	})
})
