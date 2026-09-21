/**
 * `namzu drain` — the caller the cross-process claim never had.
 *
 * The tests that matter here are the REACHABILITY ones. Every piece this
 * command composes (the index, the session lease, the resume) is covered by
 * its own unit tests, so a suite that only re-tested the pieces would stay
 * green through the exact defect this command exists to fix. So: delete the
 * `claimSession` call and the first block fails; drop the lease from the
 * resume and the second block fails; delete the command from the registry
 * and the third fails.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

const TENANT = '6ab233e0-9e27-4517-8861-61d4b85f396e'
const PROJECT = '3f488113-b658-4c23-833c-69d1e9072a19'
const SESSION = '02b19846-c793-4e21-9c6e-21962a7d2de5'
const TURN = '0199a8d2-37dd-7f8e-9e13-4e57937fd048'
const TOPIC = '66b7abae-e8da-4a77-9f42-3405e7b7d5f5'
const LEASE = { holder: 'w', fence: 7, expiresAt: Date.now() + 60_000 }

const spies = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	getSession: vi.fn(),
	listPendingDecisions: vi.fn(),
	closeIndex: vi.fn(),
	activeTurn: vi.fn(),
	claimSession: vi.fn(),
	releaseSession: vi.fn(),
	readSessionStart: vi.fn(),
	logAt: vi.fn(),
}))

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		configureLogger: () => {},
		openSessionIndex: async () => ({
			getSession: spies.getSession,
			listPendingDecisions: spies.listPendingDecisions,
			close: spies.closeIndex,
		}),
		DiskSessionLog: {
			at: (...args: unknown[]) => {
				spies.logAt(...args)
				return { sessionId: SESSION, activeTurn: spies.activeTurn }
			},
		},
		claimSession: spies.claimSession,
		releaseSession: spies.releaseSession,
	}
})

vi.mock('../../integrations/resident/session-log-reads.js', () => ({
	readSessionStart: spies.readSessionStart,
}))

// Standing in a trusted folder is the ordinary production state; the refusal
// for an untrusted one is the headless trust gate's own test.
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

// Declared WITH its parameter, so `mock.calls[0][0]` is a value rather than
// a tuple index that does not exist.
const resumeDurable = vi.fn(
	async (_params: {
		entry: { turnId: string; sessionId: string }
		lease?: unknown
		sessionLog?: unknown
	}): Promise<unknown> => ({
		resumed: true as const,
		turn: { status: 'completed' },
		state: {},
	}),
)

const sessionStub = fakeAgentSession({
	resumeDurable: resumeDurable as unknown as ReturnType<typeof fakeAgentSession>['resumeDurable'],
})
spies.createAgentSession.mockResolvedValue(sessionStub)

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: spies.createAgentSession,
}))

const { drainCommand, parseDrainFlags, resolveDrainScope } = await import('../drain.js')

// `--store` must already be a namzu home: the drain refuses to create state
// in a directory it was pointed at.
const HOME = mkdtempSync(join(tmpdir(), 'namzu-drain-home-'))
mkdirSync(join(HOME, 'projects'))
afterAll(() => removeTempDir(HOME))

const SCOPE_ARGS = ['--store', HOME, '--tenant', TENANT, '--project', PROJECT, '--session', SESSION]

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

beforeEach(() => {
	for (const spy of Object.values(spies)) spy.mockReset()
	resumeDurable.mockClear()
	spies.createAgentSession.mockResolvedValue(sessionStub)
	spies.getSession.mockResolvedValue({
		id: SESSION,
		slug: '-workspace',
		projectId: PROJECT,
		rootId: SESSION,
		depth: 0,
		logPath: join(HOME, 'projects', '-workspace', `${SESSION}.jsonl`),
	})
	spies.readSessionStart.mockResolvedValue({
		type: 'session_started',
		seq: 1,
		sessionId: SESSION,
		projectId: PROJECT,
		tenantId: TENANT,
		topicId: TOPIC,
	})
	spies.listPendingDecisions.mockResolvedValue([])
	spies.activeTurn.mockResolvedValue({ turnId: TURN, state: 'interrupted', paused: false })
	spies.claimSession.mockResolvedValue(LEASE)
	spies.releaseSession.mockResolvedValue(undefined)
})

describe('refusing a pass whose scope nobody named', () => {
	it('refuses without a store rather than defaulting to a path', () => {
		const flags = parseDrainFlags(['--tenant', TENANT])
		expect(flags.store).toBeNull()
	})

	it('refuses a drain with no tenant', () => {
		expect(resolveDrainScope({ tenant: null, project: 'p', session: 's' })).toMatchObject({
			error: expect.stringContaining('--tenant is required'),
		})
	})

	it('refuses a scope without its project and session', () => {
		expect(resolveDrainScope({ tenant: 't', project: null, session: 's' })).toMatchObject({
			error: expect.stringContaining('--project and --session'),
		})
	})

	// Present but MISTYPED, which is the case the two refusals above cannot
	// reach and the one an operator actually hits.
	it.each([
		['tenant', { tenant: 'tnt_old', project: PROJECT, session: SESSION }, 'tenant'],
		['project', { tenant: TENANT, project: 'prj_old', session: SESSION }, 'project'],
		[
			'session',
			{ tenant: TENANT, project: PROJECT, session: 'ses_unsupported_identifier' },
			'session',
		],
	])(
		'refuses a --%s that is not one, naming the entity field it rejected',
		(_flag, flags, prefix) => {
			const result = resolveDrainScope(flags)
			expect(result).toMatchObject({ error: expect.stringContaining(prefix) })
			expect(result).toMatchObject({
				error: expect.stringContaining('--tenant, --project and --session'),
			})
		},
	)

	it('accepts UUIDs in every scope field', () => {
		expect(resolveDrainScope({ tenant: TENANT, project: PROJECT, session: SESSION })).toEqual({
			tenantId: TENANT,
			projectId: PROJECT,
			sessionId: SESSION,
		})
	})

	it('collects an unrecognised flag, and the value it stranded', () => {
		expect(parseDrainFlags(['--tenat', TENANT]).unknown).toEqual(['--tenat', TENANT])
	})

	it('reads a value written with an equals sign', () => {
		const flags = parseDrainFlags(['--store=/a/b', '--ttl=1234', '--max-concurrent=4'])
		expect(flags.store).toBe('/a/b')
		expect(flags.ttlMs).toBe(1234)
		expect(flags.maxConcurrent).toBe(4)
	})
})

describe('the command refuses before it opens anything', () => {
	it('exits 64 with no --store, and never claims', async () => {
		const { ctx, errors } = contextCapturing()
		const code = await drainCommand.handler({ ctx, rawArgs: ['--tenant', TENANT] })
		expect(code).toBe(64)
		expect(errors[0]).toContain('--store is required')
		expect(spies.claimSession).not.toHaveBeenCalled()
	})

	it('exits 64 on a lease that has already expired', async () => {
		const { ctx, errors } = contextCapturing()
		const code = await drainCommand.handler({ ctx, rawArgs: [...SCOPE_ARGS, '--ttl', '0'] })
		expect(code).toBe(64)
		expect(errors[0]).toContain('--ttl must be a positive number')
		expect(spies.claimSession).not.toHaveBeenCalled()
	})

	it('exits 64 on a concurrency that is not a whole number above zero', async () => {
		const { ctx, errors } = contextCapturing()
		const code = await drainCommand.handler({
			ctx,
			rawArgs: [...SCOPE_ARGS, '--max-concurrent', '0'],
		})
		expect(code).toBe(64)
		expect(errors[0]).toContain('--max-concurrent')
	})

	it('exits 64 on a --store that is not a namzu home, creating nothing there', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'namzu-drain-empty-'))
		try {
			const { ctx, errors } = contextCapturing()
			const args = [...SCOPE_ARGS]
			args[1] = empty
			expect(await drainCommand.handler({ ctx, rawArgs: args })).toBe(64)
			expect(errors.join(' ')).toContain('holds no projects/ directory')
			expect(spies.createAgentSession).not.toHaveBeenCalled()
		} finally {
			removeTempDir(empty)
		}
	})
})

describe('the session is checked before a provider is built', () => {
	it.each([
		['an unindexed session', () => spies.getSession.mockResolvedValueOnce(undefined)],
		[
			'a session under another project',
			() =>
				spies.getSession.mockResolvedValueOnce({
					id: SESSION,
					slug: '-workspace',
					projectId: '193cc60e-d8ca-49c5-86e8-30428312e4c8',
					rootId: SESSION,
					depth: 0,
				}),
		],
		[
			'a child session',
			() =>
				spies.getSession.mockResolvedValueOnce({
					id: SESSION,
					slug: '-workspace',
					projectId: PROJECT,
					rootId: '193cc60e-d8ca-49c5-86e8-30428312e4c8',
					depth: 1,
				}),
		],
		[
			'a session opened under another tenant',
			() =>
				spies.readSessionStart.mockResolvedValueOnce({
					type: 'session_started',
					seq: 1,
					sessionId: SESSION,
					projectId: PROJECT,
					tenantId: '193cc60e-d8ca-49c5-86e8-30428312e4c8',
					topicId: TOPIC,
				}),
		],
		['a session with no log', () => spies.readSessionStart.mockResolvedValueOnce(null)],
	])('refuses %s with 64', async (_case, arrange) => {
		arrange()
		const { ctx, errors } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(64)
		expect(errors.join(' ')).toContain('cannot resolve the drain session')
		expect(spies.createAgentSession).not.toHaveBeenCalled()
		expect(spies.claimSession).not.toHaveBeenCalled()
		expect(spies.closeIndex).toHaveBeenCalled()
	})

	it('exits 1 when the state under --store cannot be read', async () => {
		// Not an argument the caller got wrong: the index read failed. The
		// docs row for 1 names "state unavailable".
		spies.getSession.mockRejectedValueOnce(
			Object.assign(new Error("EACCES: permission denied, scandir 'projects/-w'"), {
				code: 'EACCES',
			}),
		)
		const { ctx, errors } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(1)
		expect(errors.join(' ')).toContain('EACCES')
		expect(spies.createAgentSession).not.toHaveBeenCalled()
		expect(spies.claimSession).not.toHaveBeenCalled()
	})
})

describe('the drain is actually reached', () => {
	it('claims the session the operator named, under a holder and a lease', async () => {
		const { ctx } = contextCapturing()
		const code = await drainCommand.handler({
			ctx,
			rawArgs: [...SCOPE_ARGS, '--holder', 'w_one', '--ttl', '1000', '--max-concurrent', '3'],
		})
		expect(code).toBe(0)
		expect(spies.claimSession).toHaveBeenCalledTimes(1)
		expect(spies.claimSession.mock.calls[0]?.[0]).toBe(SESSION)
		expect(spies.claimSession.mock.calls[0]?.[1]).toMatchObject({ holder: 'w_one', ttlMs: 1000 })
		expect(spies.releaseSession).toHaveBeenCalledWith(SESSION, LEASE, expect.anything())
		expect(spies.createAgentSession).toHaveBeenCalledTimes(1)
		expect(spies.createAgentSession.mock.calls[0]?.[2]).toMatchObject({
			stateRoot: HOME,
			scope: { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION, topicId: TOPIC },
		})
	})

	it('mints a per-process holder when none was named', async () => {
		const { ctx } = contextCapturing()
		await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })
		const holder = (spies.claimSession.mock.calls[0]?.[1] as { holder: string }).holder
		// The lease contract says `holder` must be unique per PROCESS.
		expect(holder).toContain(String(process.pid))
	})

	it('keeps configured turn limits when constructing the resume host', async () => {
		const { ctx } = contextCapturing()
		const limits = { tokenBudget: 35000, maxIterations: 6 }
		await drainCommand.handler({
			ctx: { ...ctx, config: { ...ctx.config, limits } },
			rawArgs: SCOPE_ARGS,
		})
		expect(spies.createAgentSession.mock.calls[0]?.[2]).toMatchObject({ limits })
	})

	it('binds retrieval settings to the resume host', async () => {
		const { ctx } = contextCapturing()
		const config = {
			...ctx.config,
			compaction: { recallEvidence: true, retainedToolPreviewChars: 3000 },
			memory: { recall: false },
			web: { search: 'off' as const },
		}
		expect(await drainCommand.handler({ ctx: { ...ctx, config }, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(spies.createAgentSession.mock.calls[0]?.[2]).toMatchObject({
			compaction: config.compaction,
			memory: config.memory,
			web: config.web,
		})
	})
})

describe('the resume is actually reached, carrying the lease', () => {
	it('continues the active turn under the lease it claimed, in the same session log', async () => {
		const { ctx } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(resumeDurable).toHaveBeenCalledTimes(1)
		const params = resumeDurable.mock.calls[0]?.[0]
		expect(params?.entry).toEqual({
			tenantId: TENANT,
			projectId: PROJECT,
			sessionId: SESSION,
			turnId: TURN,
		})
		// Dropping the lease leaves every record the resumed turn appends
		// unfenced, so a drainer stalled past its lease writes over whoever
		// took the session over. This assertion stands between that and green.
		expect(params?.lease).toBe(LEASE)
		expect(params?.sessionLog).toMatchObject({ sessionId: SESSION })
	})

	it('reports a turn parked on a decision without claiming the session', async () => {
		spies.listPendingDecisions.mockResolvedValueOnce([
			{ decisionId: 'd', sessionId: SESSION, turnId: TURN, checkpointId: 'c' },
		])
		const { ctx, printed } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(spies.claimSession).not.toHaveBeenCalled()
		expect(resumeDurable).not.toHaveBeenCalled()
		expect(printed[0]).toMatchObject({ awaitingDecision: [TURN], resumed: 0 })
	})

	it('reports a turn the resume finds waiting on a decision', async () => {
		resumeDurable.mockResolvedValueOnce({ resumed: false, reason: 'awaiting-decision' })
		const { ctx, printed } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(printed[0]).toMatchObject({ awaitingDecision: [TURN], resumed: 0 })
	})

	it('reports a turn with nothing to continue as its own outcome', async () => {
		resumeDurable.mockResolvedValueOnce({ resumed: false, reason: 'no-checkpoint' })
		const { ctx, printed } = contextCapturing()
		await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })
		// Distinct from `awaitingDecision`: one is a question waiting on a
		// person and the other is a dead end.
		expect(printed[0]).toMatchObject({ noCheckpoint: [TURN], awaitingDecision: [] })
	})

	it('skips a session another process holds, and resumes nothing', async () => {
		spies.claimSession.mockResolvedValueOnce(null)
		const { ctx, printed } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(resumeDurable).not.toHaveBeenCalled()
		expect(spies.releaseSession).not.toHaveBeenCalled()
		expect(printed[0]).toMatchObject({ heldByOthers: [TURN], resumed: 0 })
	})

	it('reports a turn settled between the listing and the claim as already handled', async () => {
		spies.activeTurn
			.mockResolvedValueOnce({ turnId: TURN, state: 'interrupted', paused: false })
			.mockResolvedValueOnce(null)
		const { ctx, printed } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(resumeDurable).not.toHaveBeenCalled()
		expect(spies.releaseSession).toHaveBeenCalledTimes(1)
		expect(printed[0]).toMatchObject({ alreadyHandled: [TURN] })
	})

	it('reports an empty pass when the session has no active turn', async () => {
		spies.activeTurn.mockResolvedValueOnce(null)
		const { ctx, printed } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(spies.claimSession).not.toHaveBeenCalled()
		expect(printed[0]).toMatchObject({ listed: 0, resumed: 0 })
	})
})

describe('what the pass reports', () => {
	it.each(['failed', 'cancelled'])(
		'does not report a resumed %s turn as success',
		async (status) => {
			resumeDurable.mockResolvedValueOnce({ resumed: true, turn: { status }, state: {} })
			const { ctx, errors, info } = contextCapturing()
			expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(1)
			expect(errors.join(' ')).toContain(`Resumed turn ended with status "${status}"`)
			expect(info.some((message) => message.startsWith('✔'))).toBe(false)
			expect(spies.releaseSession).toHaveBeenCalledTimes(1)
		},
	)

	it('exits 1 and names the turn when work failed', async () => {
		resumeDurable.mockRejectedValueOnce(new Error('provider refused'))
		const { ctx, errors } = contextCapturing()
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(1)
		expect(errors.join(' ')).toContain(`${TURN}: provider refused`)
	})

	it('surfaces a refusal from the log rather than reporting an empty pass', async () => {
		spies.activeTurn.mockRejectedValueOnce(new Error('Session log chain is broken at seq 4'))
		const { ctx, errors } = contextCapturing()
		// "Nothing was parked" and "this log cannot be read" are opposite facts.
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(1)
		expect(errors.join(' ')).toContain('chain is broken')
	})

	it('reports a lease it could not hand back', async () => {
		spies.releaseSession.mockRejectedValueOnce(new Error('disk went away'))
		const { ctx, errors, printed } = contextCapturing()
		// The work landed, so this is not a failure — but the session is
		// unavailable to the next reader until the lease lapses.
		expect(await drainCommand.handler({ ctx, rawArgs: SCOPE_ARGS })).toBe(0)
		expect(errors.join(' ')).toContain('lease not released')
		expect(printed[0]).toMatchObject({ unreleased: [{ turnId: TURN }] })
	})
})
