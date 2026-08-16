import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The driver is asked what the window is exactly once per run.
 *
 * The two consumers are synchronous and in the hot loop — the compaction
 * trigger and the per-iteration usage event. Turning either into an await
 * would put a network round trip on every iteration of every run, so the
 * answer is resolved at the door and carried.
 *
 * And a driver that cannot answer must not cost anything. The table is
 * still there; a listing endpoint that is down for a minute is not a reason
 * for a run to fail.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A provider that counts how often the runtime asks about its window. */
class ReportingProvider extends MockLLMProvider {
	calls = 0
	constructor(
		private readonly answer: () => Promise<number | undefined>,
		turns: number,
	) {
		super({
			turns: [
				...Array.from({ length: turns }, (_, i) => ({
					toolCalls: [{ id: `t${i}`, name: 'noop', args: {} }],
					finishReason: 'tool_calls' as const,
				})),
				{ text: 'done' },
			] as never,
		})
	}
	async resolveContextWindow(): Promise<number | undefined> {
		this.calls++
		return this.answer()
	}
}

function registry(): ToolRegistry {
	const r = new ToolRegistry()
	return r
}

async function run(provider: MockLLMProvider, iterations = 4) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-window-'))
	dirs.push(workingDirectory)
	const events: RunEvent[] = []

	const result = await drainQuery(
		{
			provider,
			tools: registry(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 20_000,
				tokenBudget: 200_000,
				maxIterations: iterations,
			},
			compactionConfig: {
				...CompactionConfigSchema.parse({}),
				// Small enough that the trigger fires, so the consumer that
				// reads the window actually runs.
				contextWindowTokens: undefined,
			},
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go '.repeat(500))],
			workingDirectory,
			sessionId: 'ses_w' as SessionId,
			topicId: 'top_w' as TopicId,
			projectId: 'prj_w' as ProjectId,
			tenantId: 'tnt_w' as TenantId,
		},
		(event: RunEvent) => {
			events.push(event)
		},
	)

	return { result, events }
}

describe('the context window is asked for once per run', () => {
	it('calls the driver exactly once however many iterations run', async () => {
		// Moving the call into the per-iteration path is the mistake this
		// exists to stop, and it would be invisible without a counter: the
		// answer would be identical every time.
		const provider = new ReportingProvider(async () => 1_000_000, 3)

		await run(provider)

		expect(provider.calls).toBe(1)
	})

	it('reports the source as `provider` on the surface a host reads', async () => {
		// Not just the trigger. A host reading `token_usage_updated` has to
		// be able to see WHERE the window came from, or a wrong number is
		// indistinguishable from a right one.
		const provider = new ReportingProvider(async () => 1_000_000, 2)

		const { events } = await run(provider)

		const usage = events.filter(
			(e): e is Extract<RunEvent, { type: 'token_usage_updated' }> =>
				e.type === 'token_usage_updated',
		)
		expect(usage.length).toBeGreaterThan(0)
		expect(usage.some((e) => e.windowSource === 'provider')).toBe(true)
		expect(usage.some((e) => e.contextWindowTokens === 1_000_000)).toBe(true)
	})

	it('completes on the table when the driver rejects', async () => {
		// A run that would have worked must not fail because a listing
		// endpoint was down. The window is an optimisation over a working
		// default, not a prerequisite.
		const provider = new ReportingProvider(async () => {
			throw new Error('models endpoint is down')
		}, 2)

		const { result, events } = await run(provider)

		expect(result.status).toBe('completed')
		const usage = events.filter(
			(e): e is Extract<RunEvent, { type: 'token_usage_updated' }> =>
				e.type === 'token_usage_updated',
		)
		expect(usage.every((e) => e.windowSource !== 'provider')).toBe(true)
	})

	it('completes on the table when the driver answers `undefined`', async () => {
		const provider = new ReportingProvider(async () => undefined, 2)

		const { result, events } = await run(provider)

		expect(result.status).toBe('completed')
		expect(provider.calls).toBe(1)
		const usage = events.filter(
			(e): e is Extract<RunEvent, { type: 'token_usage_updated' }> =>
				e.type === 'token_usage_updated',
		)
		expect(usage.every((e) => e.windowSource !== 'provider')).toBe(true)
	})

	it('does not ask a driver that has no such member', async () => {
		// The absent case, which is every driver in the tree but one. It has
		// to be exactly as it was — a missing member is not an error and not
		// a reason to log anything.
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		const { result } = await run(provider, 2)

		expect(result.status).toBe('completed')
	})
})
