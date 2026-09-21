/** Exercise the actual /config picker and subsequent send boundary. */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentSession, SendOptions } from '../agent.js'

const sent = vi.hoisted(() => ({ options: [] as SendOptions[] }))

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

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
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			reasoningEffortLevels: ['low'],
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
			send: async function* (_messages, options) {
				sent.options.push(options ?? {})
				yield { kind: 'done', stopReason: 'end_turn' } as const
			},
		}),
	}
})

const { App } = await import('../App.js')
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
let mounted: { unmount: () => void } | undefined

afterEach(() => {
	mounted?.unmount()
	mounted = undefined
	sent.options.length = 0
	vi.restoreAllMocks()
})

async function waitFor(
	harness: { readonly frames: readonly string[] },
	text: string,
): Promise<void> {
	const started = performance.now()
	while (!harness.frames.join('\n').includes(text) && performance.now() - started < 3_000) {
		await tick(20)
	}
	expect(harness.frames.join('\n')).toContain(text)
}


async function command(harness: ReturnType<typeof render>, text: string) {
	harness.stdin.write(text)
	await vi.waitFor(() => expect(harness.lastFrame()).toContain(text))
	harness.stdin.write('\r')
	await tick(80)
}

it('opens limits from /config, edits a field, and forwards the next run without recreating its session', async () => {
	const harness = render(<App ctx={{ cwd: '/w', version: '0.0.0-test', limits: { tokenBudget: 2000, maxIterations: 3, timeoutMs: 1000 } }} />)
	mounted = harness
	await waitFor(harness, '› Type a message')
	await command(harness, '/config')
	await waitFor(harness, 'Turn limits')
	// Model, effort, permissions, then run limits.
	harness.stdin.write('\u001b[B\u001b[B\u001b[B')
	await tick()
	harness.stdin.write('\r')
	await tick(80)
	expect(harness.lastFrame()).toContain('Token budget')
	expect(harness.lastFrame()).toContain('2,000')
	harness.stdin.write('\r')
	await tick(80)
	expect(harness.lastFrame()).toContain('0 = unlimited')
	harness.stdin.write('\u0015')
	await tick()
	harness.stdin.write('0')
	await tick()
	harness.stdin.write('\r')
	await tick(80)
	expect(harness.lastFrame()).toContain('Updated.')
	expect(harness.lastFrame()).toContain('Unlimited')
	harness.stdin.write('\u001b')
	await vi.waitFor(() => expect(harness.lastFrame()).toContain('› Type a message'))
	await command(harness, 'hello')
	await vi.waitFor(() => expect(sent.options.at(-1)?.limits).toEqual({ tokenBudget: 0, maxIterations: 3, timeoutMs: 1000 }))
	await command(harness, '/config limits unlimited')
	harness.stdin.write('\u001b')
	await tick()
	await command(harness, 'hello again')
	await vi.waitFor(() => expect(sent.options.at(-1)?.limits).toEqual({ tokenBudget: 0, maxIterations: 0, timeoutMs: 0 }))
	expect(sent.options[0]?.limits).toEqual({ tokenBudget: 0, maxIterations: 3, timeoutMs: 1000 })
})

it('opens with unlimited values when no file sets limits and leaves them unchanged on cancel', async () => {
	const harness = render(<App ctx={{ cwd: '/w', version: '0.0.0-test' }} />)
	mounted = harness
	await waitFor(harness, '› Type a message')
	await command(harness, '/config limits')
	expect(harness.lastFrame()?.match(/Unlimited/g)).toHaveLength(4)
	harness.stdin.write('\u001b')
	await tick()
	await command(harness, '/config limits time')
	await vi.waitFor(() => expect(harness.lastFrame()).toContain('Run duration (ms; 0 = unlimited)'))
	harness.stdin.write('\u0015')
	await tick()
	harness.stdin.write('2h')
	await vi.waitFor(() => expect(harness.lastFrame()).toContain('2h'))
	harness.stdin.write('\u001b')
	await vi.waitFor(() => expect(harness.lastFrame()).toContain('› Type a message'))
	await command(harness, 'hello')
	await vi.waitFor(() => expect(sent.options.at(-1)?.limits).toEqual({ tokenBudget: 0, maxIterations: 0, timeoutMs: 0 }))
})
