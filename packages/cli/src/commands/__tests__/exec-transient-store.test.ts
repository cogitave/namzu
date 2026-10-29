import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as stores from '../../integrations/sessions/store.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { createAgentSession } from '../../tui/agent.js'
import type { AgentEvent } from '../../tui/agent.js'
import { execCommand } from '../exec.js'
import { resolveResume } from '../resume.js'
import type { CommandContext } from '../types.js'

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true }))
vi.mock('../../config/trusted-project-context.js', () => ({
	resolveTrustedProjectContext: (ctx: unknown) => ctx,
}))
vi.mock('../stdin.js', () => ({ readStdin: async () => '' }))
vi.mock('../resume.js', () => ({ resolveResume: vi.fn(async () => ({ kind: 'fresh' })) }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: vi.fn(),
	closeSessions: vi.fn(),
	startConversation: vi.fn(),
	forkConversation: vi.fn(),
	discardConversation: vi.fn(),
	resolveConversation: vi.fn(),
	loadConversation: vi.fn(),
}))
vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: async () => ({
		preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
		detected: [],
	}),
	createAgentSession: vi.fn(),
}))

const ctx = {
	formatter: { name: 'text', print: vi.fn(), info: vi.fn(), error: vi.fn() },
	config: {},
} as unknown as CommandContext

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(resolveResume).mockResolvedValue({ kind: 'fresh' })
	vi.mocked(createAgentSession).mockResolvedValue(fakeAgentSession())
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

function assertNoDurableWrites() {
	expect(stores.startConversation).not.toHaveBeenCalled()
	expect(stores.forkConversation).not.toHaveBeenCalled()
	expect(stores.discardConversation).not.toHaveBeenCalled()
}

function run(args: string[]) {
	return execCommand.handler({ ctx, rawArgs: [...args, 'hello'] })
}

describe('headless transient log selection happens before session initialization', () => {
	it.each([{ mode: [] }, { mode: ['--json'] }, { mode: ['--json', '--no-session-persistence'] }])(
		'never opens a durable store for a transient run ($mode)',
		async ({ mode }) => {
			// Default JSON is stateless too; text requires the explicit switch.
			const flags = mode.length === 0 ? ['--no-session-persistence'] : mode
			vi.mocked(createAgentSession).mockImplementationOnce(async (_prefs, _detected, options) => {
				expect(options?.ephemeral).toBe(true)
				expect(options?.conversationSessions).toBeUndefined()
				expect(stores.openSessions).not.toHaveBeenCalled()
				assertNoDurableWrites()
				return fakeAgentSession()
			})
			expect(await run(flags)).toBe(0)
			assertNoDurableWrites()
		},
	)

	it.each(['--continue', '--resume'])(
		'reads %s history without creating a durable fork',
		async (flag) => {
			const source = {} as Awaited<ReturnType<typeof stores.openSessions>>
			vi.mocked(stores.openSessions).mockResolvedValueOnce(source)
			vi.mocked(resolveResume).mockResolvedValueOnce({
				kind: 'resumed',
				sessionId: '9bb21120-0065-447a-b526-bd897c581347',
				messages: [{ role: 'user', content: 'previous question', timestamp: 0 }],
			})
			const send = vi.fn(fakeAgentSession().send)
			vi.mocked(createAgentSession).mockImplementationOnce(async (_prefs, _detected, options) => {
				expect(options?.ephemeral).toBe(true)
				expect(options?.conversationSessions).toBeUndefined()
				expect(stores.closeSessions).toHaveBeenCalledWith(source)
				assertNoDurableWrites()
				return fakeAgentSession({ send })
			})
			const resume = flag === '--resume' ? [flag, '9bb21120-0065-447a-b526-bd897c581347'] : [flag]
			expect(await run(['--no-session-persistence', ...resume])).toBe(0)
			expect(stores.openSessions).toHaveBeenCalledWith(expect.any(String), { readOnly: true })
			expect(send.mock.calls[0]?.[0][0]?.content).toBe('previous question')
			assertNoDurableWrites()
		},
	)

	it('keeps the resume usage error when no source history exists', async () => {
		vi.mocked(stores.openSessions).mockRejectedValueOnce(
			Object.assign(new Error('No existing installation identity'), { code: 'ENOENT' }),
		)
		expect(await run(['--no-session-persistence', '--continue'])).toBe(64)
		expect(createAgentSession).not.toHaveBeenCalled()
		assertNoDurableWrites()
	})

	it('does not substitute deletion for transient storage on provider failure', async () => {
		vi.mocked(createAgentSession).mockResolvedValueOnce(fakeAgentSession({ hasProvider: false }))
		expect(await run(['--no-session-persistence'])).toBe(1)
		expect(stores.openSessions).not.toHaveBeenCalled()
		assertNoDurableWrites()
	})

	it('refuses a keyed JSON request instead of silently discarding its history', async () => {
		expect(await run(['--json', '--session', 'key', '--no-session-persistence'])).toBe(0)
		expect(createAgentSession).not.toHaveBeenCalled()
		expect(stores.openSessions).not.toHaveBeenCalled()
	})

	it('keeps wait-for-provider available with the transient log', async () => {
		vi.useFakeTimers()
		const resumePaused = vi.fn(() =>
			(async function* () {
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			})(),
		)
		vi.mocked(createAgentSession).mockResolvedValueOnce(
			fakeAgentSession({
				send: () =>
					(async function* () {
						yield {
							kind: 'paused',
							turnId: 'turn',
							checkpointId: 'checkpoint',
							reason: 'rate limit',
							providerError: { kind: 'throttle', providerId: 'mock', retryAfterMs: 1000 },
						} as AgentEvent
					})(),
				resumePaused,
			}),
		)
		const result = run(['--no-session-persistence', '--wait-for-provider', '30s'])
		await vi.runAllTimersAsync()
		expect(await result).toBe(0)
		expect(resumePaused).toHaveBeenCalledWith(
			expect.objectContaining({ checkpointId: 'checkpoint' }),
		)
		expect(stores.openSessions).not.toHaveBeenCalled()
		assertNoDurableWrites()
	})
})
