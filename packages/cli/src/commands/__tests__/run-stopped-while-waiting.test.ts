import { describe, expect, it, vi } from 'vitest'

import type { TerminationHandling, TerminationSignal } from '../../termination.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { AgentEvent, AgentSession } from '../../tui/agent.js'
import { runCommand } from '../run.js'
import type { CommandContext } from '../types.js'

/**
 * `namzu run --wait-for-provider` stopped by a signal while it waits out a
 * provider pause.
 *
 * Nothing is running then: the turn is recorded `turn_paused` with a
 * checkpoint, which is what `/resume` and `namzu drain` continue from. Telling
 * the operator it was "left interrupted" and to `/abandon` it would throw that
 * checkpoint away on a false premise, and resuming it after the signal would
 * start provider work in a process that is on its way out.
 *
 * The signal is simulated by running the cleanup the command registered, the
 * way `termination.ts` does after it has released the leases; a real signal
 * here would stop the test worker.
 */

const sessionStub = fakeAgentSession()
const cleanups: Array<(signal: TerminationSignal) => Promise<void> | void> = []

vi.mock('../../termination.js', () => ({
	withTerminationHandling:
		<A>(handler: (args: A, termination: TerminationHandling) => Promise<number>) =>
		(args: A) =>
			handler(args, {
				onTerminate: (cleanup) => {
					cleanups.push(cleanup)
				},
				dispose: () => {},
			}),
}))

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

const PAUSE = {
	kind: 'paused',
	turnId: '060ef1b7-e8bb-474c-b405-c2d11930d39c',
	checkpointId: '227436b6-3082-4bdc-a441-7e828e479876',
	reason: 'slow down',
	// One millisecond asked, so the wait is the policy's one-second floor.
	providerError: {
		kind: 'throttle',
		providerId: 'mock',
		status: 429,
		retryAfterMs: 1,
		detail: '429',
	},
}

describe('a run stopped while it waits for the provider', () => {
	it('says the turn is paused at its checkpoint, and does not resume it', async () => {
		const errors: string[] = []
		const infos: string[] = []
		const ctx = {
			formatter: {
				name: 'text' as const,
				print: () => {},
				info: (m: unknown) => infos.push(String(m)),
				error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
			},
			config: {},
		} as unknown as CommandContext
		sessionStub.send = (() =>
			(async function* () {
				yield PAUSE as AgentEvent
			})()) as AgentSession['send']
		const resumed = vi.fn()
		sessionStub.resumePaused = resumed as unknown as AgentSession['resumePaused']

		const done = runCommand.handler({
			rawArgs: ['--wait-for-provider', '30s', 'hello'],
			ctx,
		} as never) as Promise<number>
		const deadline = Date.now() + 5_000
		while (!infos.some((line) => line.includes('provider paused the turn: waiting'))) {
			if (Date.now() > deadline) throw new Error('the run never started waiting')
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		expect(cleanups).toHaveLength(1)
		await cleanups[0]?.('SIGTERM')
		await done

		const said = errors.join('\n')
		expect(said).not.toContain('left interrupted')
		expect(said).toContain(
			'stopped by SIGTERM while the turn was paused: it keeps checkpoint 227436b6-3082-4bdc-a441-7e828e479876',
		)
		expect(resumed).not.toHaveBeenCalled()
	})
})
