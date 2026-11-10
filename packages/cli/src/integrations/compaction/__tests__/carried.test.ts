import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionGoal, SessionId, TenantId } from '@namzu/sdk'
import {
	BackgroundJobRegistry,
	CompactionConfigSchema,
	MockLLMProvider,
	createUserMessage,
	drainQuery,
	registerMock,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createOutstandingFacts } from '../../outstanding/facts.js'
import { createOutstandingWorkStep } from '../../outstanding/note.js'
import { subagentParentFixture } from '../../subagents/__fixtures__/parent.js'
import {
	GOAL_NOTE_HEADER,
	MAX_CARRIED_GOAL_CHARS,
	carriedAcrossCompaction,
	goalCarriedAcrossCompaction,
} from '../carried.js'

registerMock()

const NOW = Date.UTC(2026, 10, 11, 9, 30, 0)
const tenant = 'tenant-1' as TenantId

function goal(over: Partial<SessionGoal> = {}): SessionGoal {
	return {
		id: 'goal-1',
		revision: 1,
		sessionId: 'session-1',
		tenantId: tenant,
		objective: 'Make the migration reversible',
		phase: 'active',
		maxGoalRounds: 8,
		roundsAdmitted: 3,
		createdAt: NOW - 1_000,
		updatedAt: NOW - 500,
		...over,
	} as SessionGoal
}
/** Answers only for the goal's own (session, tenant); anything else has no goal. */
const store = (g: SessionGoal | null) => ({
	getGoal: async (sessionId: SessionId, tenantId: TenantId) =>
		g && g.sessionId === sessionId && g.tenantId === tenantId ? g : null,
})
const session = 'session-1' as SessionId

describe('the goal carried across a compaction', () => {
	it('says what the goal is, stamped as of the compaction', async () => {
		const note =
			(await goalCarriedAcrossCompaction(store(goal()), session, tenant, () => NOW)) ?? ''
		expect(note).toContain('As of this compaction (2026-11-11T09:30:00.000Z)')
		expect(note).toContain('active')
		expect(note).toContain('3 of 8')
		expect(note).toContain('"Make the migration reversible"')
		expect(note).toContain('It may have changed since')
	})

	it('is absent with no goal, a completed goal, or a store that fails', async () => {
		expect(await goalCarriedAcrossCompaction(store(null), session, tenant)).toBeUndefined()
		expect(
			await goalCarriedAcrossCompaction(store(goal({ phase: 'complete' })), session, tenant),
		).toBeUndefined()
		const broken = {
			getGoal: async () => {
				throw new Error('disk')
			},
		}
		expect(await goalCarriedAcrossCompaction(broken, session, tenant)).toBeUndefined()
	})

	it('is scoped to the session and the tenant it is asked for', async () => {
		const g = goal()
		expect(
			await goalCarriedAcrossCompaction(store(g), 'session-2' as SessionId, tenant, () => NOW),
		).toBeUndefined()
		expect(
			await goalCarriedAcrossCompaction(store(g), session, 'tenant-2' as TenantId, () => NOW),
		).toBeUndefined()
		expect(await goalCarriedAcrossCompaction(store(g), session, tenant, () => NOW)).toContain(
			GOAL_NOTE_HEADER,
		)
		const getGoal = vi.fn(async () => null)
		await carriedAcrossCompaction({ goals: { getGoal }, sessionId: session, tenantId: tenant })
		expect(getGoal).toHaveBeenCalledWith(session, tenant)
	})

	it('never cuts a surrogate pair when it clips', async () => {
		const note =
			(await goalCarriedAcrossCompaction(
				store(goal({ objective: `${'x'.repeat(MAX_CARRIED_GOAL_CHARS - 1)}😀tail` })),
				session,
				tenant,
				() => NOW,
			)) ?? ''
		expect(note).toContain('[clipped]')
		expect(note).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i)
		expect(note).toContain('😀')
	})

	it('stays within a measured size: the header, the stamp and at most the clipped objective', async () => {
		const note =
			(await goalCarriedAcrossCompaction(
				store(goal({ objective: 'y'.repeat(10_000) })),
				session,
				tenant,
				() => NOW,
			)) ?? ''
		// Worst case measured on this fixture: about 0.8 KB of text, so well under 300 tokens.
		expect(Buffer.byteLength(note)).toBeLessThan(MAX_CARRIED_GOAL_CHARS + 350)
	})

	it('clips a long objective', async () => {
		const note =
			(await goalCarriedAcrossCompaction(
				store(goal({ objective: 'x'.repeat(MAX_CARRIED_GOAL_CHARS * 5) })),
				session,
				tenant,
				() => NOW,
			)) ?? ''
		expect(note).toContain('[clipped]')
		expect(note.length).toBeLessThan(MAX_CARRIED_GOAL_CHARS + 400)
	})

	it('is absent from the combined note when the host has neither a plan nor a goal', async () => {
		expect(await carriedAcrossCompaction({ sessionId: session, tenantId: tenant })).toBeUndefined()
		expect(
			await carriedAcrossCompaction({ goals: store(null), sessionId: session, tenantId: tenant }),
		).toBeUndefined()
	})
})

describe('the request after a compaction', () => {
	it('names the running job and the goal; with neither, names neither', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-carried-'))
		const parent = await subagentParentFixture(cwd)
		try {
			const registry = new BackgroundJobRegistry()
			const child = Object.assign(new EventEmitter(), {
				pid: undefined as number | undefined,
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			})
			const step = createOutstandingWorkStep(
				createOutstandingFacts({
					jobs: () => registry,
					jobOwner: 'session-1',
					activity: () => undefined,
					workflows: () => [],
				}),
				() => NOW,
			)
			const history = Array.from({ length: 40 }, (_, i) =>
				createUserMessage(`turn ${i} `.repeat(200)),
			)
			const run = async (goals: ReturnType<typeof store>) => {
				const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })
				await drainQuery({
					agentId: 'namzu',
					agentName: 'namzu',
					...parent.scope,
					turnId: parent.addTurn(),
					provider,
					toolsets: [],
					messages: [...history, createUserMessage('what is left?')],
					workingDirectory: cwd,
					prepareStep: [step],
					compactionConfig: {
						...CompactionConfigSchema.parse({}),
						contextWindowTokens: 100_000,
						keepRecentMessages: 2,
						llmVerification: false,
						richStateThreshold: 1_000,
						triggerThreshold: 0.01,
					},
					postCompactionContext: () =>
						carriedAcrossCompaction({ goals, sessionId: session, tenantId: tenant }, () => NOW),
					turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 3 },
				})
				return JSON.stringify(provider.requests[0]?.messages)
			}

			const none = await run(store(null))
			expect(none).toContain('COMPACTED CONTEXT')
			expect(none).not.toContain('still going')
			expect(none).not.toContain(GOAL_NOTE_HEADER)

			const job = registry.start({
				owner: 'session-1',
				command: 'npm test',
				workingDirectory: cwd,
				spawn: () => ({ child: child as never }),
			})
			const both = await run(store(goal()))
			expect(both).toContain('COMPACTED CONTEXT')
			expect(both).toContain(`job ${job.id} \\"npm test\\"`)
			expect(both).toContain(GOAL_NOTE_HEADER)
			expect(both).toContain('Make the migration reversible')
		} finally {
			removeTempDir(cwd)
		}
	})
})
