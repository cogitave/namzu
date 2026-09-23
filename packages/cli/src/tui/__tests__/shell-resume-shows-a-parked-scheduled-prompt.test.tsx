/**
 * `namzu resume <id>` of a scheduled run parked on a decision puts the parked
 * call on the permission screen without the operator typing `/resume`: that
 * command is what the notification and `/schedule` tell them to run. Any
 * other parked turn is left alone until they ask.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, ResumePausedParams } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const CONVERSATION = '0ac90d46-4041-4402-8bc7-89c9a8c75f73'
const PARKED = '3b0329bb-f60a-48dc-9552-1b386c52cfe8'
const COMMAND = `out="$(date)"; printf '%s\\n' "$out" >> stamp.txt`

const facts = vi.hoisted(() => ({ paused: true, scheduled: true }))

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () =>
		facts.paused ? { turnId: PARKED, paused: true } : { turnId: PARKED },
	openSessions: async () => ({
		tenantId: 'tenant',
		projectId: '08c9b09c-4412-478c-878b-dc94927c760f',
		topicId: '4bd72c65-bcc9-475c-8d7c-27d622df04e8',
	}),
	startConversation: async () => CONVERSATION,
	loadResumableConversation: async () => [{ role: 'user', content: 'stamp the date', timestamp: 1 }],
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))

// The job store is the scheduler's; what matters here is what the App does
// with a park, so the park itself is described rather than produced.
vi.mock('../schedule/resume.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../schedule/resume.js')>()
	return {
		...actual,
		findScheduledPark: async () => (facts.scheduled ? { job: {}, runId: 'r', turnId: PARKED, toolCalls: [] } : undefined),
		prepareScheduledResume: async (input: Parameters<typeof actual.prepareScheduledResume>[0]) => {
			const answer = await input.ask({
				sessionId: input.sessionId as never,
				turnId: PARKED as never,
				toolCalls: [{ id: 'call_1', name: 'bash', input: { command: COMMAND }, isDestructive: true }],
				batchOnly: true,
			} as never)
			return {
				pendingDecision: answer.kind === 'reject' ? { action: 'reject_tools', feedback: 'no' } : { action: 'approve_tools' },
				onPermission: input.ask,
				rules: [],
				permissionMode: 'prompt',
			}
		},
	}
})

const resumed: ResumePausedParams[] = []

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
			sandbox: { unconfined: true, enforced: [], required: [], workspace: 'host' },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
			errorHint: null,
			errorKind: null,
			agentIds: [],
			configNotices: [],
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: (params: ResumePausedParams) => {
				resumed.push(params)
				return (async function* (): AsyncIterable<AgentEvent> {
					yield { kind: 'done' } as AgentEvent
				})()
			},
			close: async () => {},
			approvalLatched: () => false,
			resetApprovalLatch: () => {},
			setPermissionMode: async () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'done' } as AgentEvent
			},
		}) as unknown as AgentSession,
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = {
	cwd: process.cwd(),
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
	initialConversationId: CONVERSATION,
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	resumed.length = 0
	facts.paused = true
	facts.scheduled = true
	for (const m of mounted.splice(0)) m.unmount()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, what: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (check()) return
		await tick(20)
	}
	throw new Error(`${what} did not happen within ${budgetMs}ms`)
}

describe('namzu resume <id> of a conversation with a parked turn', () => {
	it('shows a parked scheduled call on the permission screen, then continues the turn', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await until(() => (harness.lastFrame() ?? '').includes('Bash command'), 'the parked prompt')
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain(`$ ${COMMAND}`)
		expect(frame).toContain('1. Yes')
		expect(frame).not.toContain('allow all')
		expect(resumed).toHaveLength(0)

		await tick(600) // the settle window before an approval is taken
		harness.stdin.write('y')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.turnId).toBe(PARKED)
		expect(resumed[0]?.pendingDecision).toEqual({ action: 'approve_tools' })
	})

	it.each([
		['a scheduled run not parked on a decision', { paused: false, scheduled: true }],
		['a parked turn that is not a scheduled run', { paused: true, scheduled: false }],
	])('leaves %s for /resume', async (_label, state) => {
		Object.assign(facts, state)
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await until(() => (harness.lastFrame() ?? '').includes('Type a message'), 'the composer')
		await tick(400)
		expect(resumed).toHaveLength(0)
		expect(harness.lastFrame() ?? '').not.toContain('Bash command')
	})
})
