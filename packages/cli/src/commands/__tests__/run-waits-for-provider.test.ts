import { describe, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { AgentEvent, AgentSession } from '../../tui/agent.js'
import { runCommand } from '../run.js'
import type { CommandContext } from '../types.js'

/**
 * `namzu run --wait-for-provider` waits out a provider pause and resumes the
 * run from its checkpoint in this process.
 *
 * Before this, a rate limit ended a headless run with the same code as a
 * failure, and the only way on was a wrapper re-prompting a fresh run from
 * whatever notes the first had left — the run's own context was gone. The
 * kernel had kept a checkpoint the whole time; nothing headless could reach it.
 */

const sessionStub = fakeAgentSession()

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'mock', subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => sessionStub),
}))

function contextCapturing(): {
	ctx: CommandContext
	printed: string[]
	errors: string[]
	infos: string[]
} {
	const printed: string[] = []
	const errors: string[] = []
	const infos: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (d: unknown) => printed.push(String((d as { text?: string })?.text ?? d)),
			info: (m: unknown) => infos.push(String(m)),
			error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, printed, errors, infos }
}

function stream(events: unknown[]): AsyncIterable<AgentEvent> {
	return (async function* () {
		for (const e of events) yield e as AgentEvent
	})()
}

const PAUSE = {
	kind: 'paused',
	runId: '060ef1b7-e8bb-474c-b405-c2d11930d39c',
	checkpointId: '227436b6-3082-4bdc-a441-7e828e479876',
	reason: 'slow down',
	// A millisecond, so the test waits for real rather than faking a clock:
	// the delay is the provider's number, and the policy honours it.
	providerError: {
		kind: 'throttle',
		providerId: 'mock',
		status: 429,
		retryAfterMs: 1,
		detail: '429',
	},
	explanation: {
		id: 'provider.rate_limit',
		message: 'The provider is rate limiting this run.',
		hint: 'Wait before continuing.',
	},
}

async function run(rawArgs: string[], config: Record<string, unknown> = {}) {
	const captured = contextCapturing()
	;(captured.ctx as unknown as { config: unknown }).config = config
	const code = (await runCommand.handler({ rawArgs, ctx: captured.ctx } as never)) as number
	return { code, ...captured }
}

describe('a paused run, given time to wait', () => {
	it('waits the provider delay, resumes from the checkpoint, and finishes with 0', async () => {
		sessionStub.send = (() =>
			stream([{ kind: 'delta', text: 'first half, ' }, PAUSE])) as AgentSession['send']
		const resumed = vi.fn((params: { runId: string; checkpointId: string }) =>
			stream([
				{ kind: 'delta', text: `second half from ${params.checkpointId}` },
				{ kind: 'done', stopReason: 'end_turn' },
			]),
		)
		sessionStub.resumePaused = resumed as unknown as AgentSession['resumePaused']

		const { code, printed, infos, errors } = await run(['--wait-for-provider', '30s', 'hello'])

		expect(code).toBe(0)
		expect(resumed).toHaveBeenCalledWith({
			runId: '060ef1b7-e8bb-474c-b405-c2d11930d39c',
			checkpointId: '227436b6-3082-4bdc-a441-7e828e479876',
		})
		expect(printed.join('')).toBe(
			'first half, second half from 227436b6-3082-4bdc-a441-7e828e479876',
		)
		expect(infos.join('\n')).toMatch(
			/waiting 1 second, then resuming from 227436b6-3082-4bdc-a441-7e828e479876/,
		)
		expect(errors).toEqual([])
	})

	it('stops with 75 when the next wait would overrun the budget, and says so', async () => {
		sessionStub.send = (() => stream([PAUSE])) as AgentSession['send']
		const resumed = vi.fn()
		sessionStub.resumePaused = resumed as unknown as AgentSession['resumePaused']

		// The provider asks for a second, the floor is a second, the budget is
		// half of one: nothing to wait with.
		const { code, errors } = await run(['--wait-for-provider', '500ms', 'hello'])

		expect(code).toBe(75)
		expect(resumed).not.toHaveBeenCalled()
		expect(errors.join('')).toContain('Not resumed:')
		expect(errors.join('')).toContain('Checkpoint preserved: 227436b6-3082-4bdc-a441-7e828e479876')
	})

	it('reads the budget from limits.waitForProviderMs when the flag is absent', async () => {
		sessionStub.send = (() => stream([PAUSE])) as AgentSession['send']
		sessionStub.resumePaused = (() =>
			stream([{ kind: 'done', stopReason: 'end_turn' }])) as AgentSession['resumePaused']

		const { code } = await run(['hello'], { limits: { waitForProviderMs: 30_000 } })

		expect(code).toBe(0)
	})

	it('does not wait at all without a budget: exit 75 at once, as before', async () => {
		sessionStub.send = (() => stream([PAUSE])) as AgentSession['send']
		const resumed = vi.fn()
		sessionStub.resumePaused = resumed as unknown as AgentSession['resumePaused']

		const { code } = await run(['hello'])

		expect(code).toBe(75)
		expect(resumed).not.toHaveBeenCalled()
	})

	it('does not wait on a pause with no provider behind it', async () => {
		// A run parked on something other than the provider is not a rate limit;
		// waiting would resume it into the same park.
		sessionStub.send = (() =>
			stream([
				{
					kind: 'paused',
					runId: '060ef1b7-e8bb-474c-b405-c2d11930d39c',
					checkpointId: '227436b6-3082-4bdc-a441-7e828e479876',
					reason: 'parked',
				},
			])) as AgentSession['send']
		const resumed = vi.fn()
		sessionStub.resumePaused = resumed as unknown as AgentSession['resumePaused']

		const { code } = await run(['--wait-for-provider', '30s', 'hello'])

		expect(code).toBe(75)
		expect(resumed).not.toHaveBeenCalled()
	})

	it('keeps waiting through a second pause while the budget lasts', async () => {
		sessionStub.send = (() => stream([PAUSE])) as AgentSession['send']
		let calls = 0
		sessionStub.resumePaused = (() => {
			calls += 1
			return calls === 1
				? stream([{ ...PAUSE, checkpointId: 'bd9701a4-993d-4294-ad4f-a3b6c1193b99' }])
				: stream([
						{ kind: 'delta', text: 'done at last' },
						{ kind: 'done', stopReason: 'end_turn' },
					])
		}) as AgentSession['resumePaused']

		const { code, printed } = await run(['--wait-for-provider', '30s', 'hello'])

		expect(code).toBe(0)
		expect(calls).toBe(2)
		expect(printed.join('')).toBe('done at last')
	})
})
