/**
 * A turn a tool paused for a person (`ToolResult.handoff`) has nothing to
 * approve. In the interactive terminal its notice says so and one key
 * answers it: Enter continues the turn, Esc stops it. A scheduled run parked
 * the same way puts Continue / Abandon on the choice screen when the
 * operator opens it (`namzu resume <id>`).
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, ResumePausedParams } from '../agent.js'
import type { TuiContext } from '../types.js'
import { PAUSED_TURN_LINES } from '../turn-interruption.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const CONVERSATION = '0ac90d46-4041-4402-8bc7-89c9a8c75f73'
const PARKED = '3b0329bb-f60a-48dc-9552-1b386c52cfe8'
const REASON = 'Sign in to example.test in the browser window'

const facts = vi.hoisted(() => ({ paused: false, scheduled: false }))

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => (facts.paused ? { turnId: PARKED, paused: true } : undefined),
	openSessions: async () => ({
		tenantId: 'tenant',
		projectId: '08c9b09c-4412-478c-878b-dc94927c760f',
		topicId: '4bd72c65-bcc9-475c-8d7c-27d622df04e8',
	}),
	startConversation: async () => CONVERSATION,
	loadResumableConversation: async () => [{ role: 'user', content: 'open the page', timestamp: 1 }],
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))

// The park is described rather than produced; the choice itself is the real
// one the scheduled resume puts on screen.
vi.mock('../schedule/resume.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../schedule/resume.js')>()
	const park = {
		job: { name: 'nightly-check' },
		runId: 'run-1',
		turnId: PARKED,
		model: { provider: 'openai', model: 'a-model' },
		toolCalls: [],
		handoff: { reason: REASON, detail: { origin: 'https://example.test' } },
	}
	return {
		...actual,
		findScheduledPark: async () => (facts.scheduled ? park : undefined),
		prepareScheduledResume: async (input: Parameters<typeof actual.prepareScheduledResume>[0]) => {
			if (!facts.scheduled) return undefined
			const choice = await actual.chooseHandoffContinuation(park as never, input.choose, input.say)
			if (choice === 'continue')
				return { onPermission: input.ask, rules: [], permissionMode: 'prompt' }
			if (choice === 'abandon') return { abandon: 'abandoned at a handoff' }
			return { leave: true }
		},
	}
})

const resumed: ResumePausedParams[] = []
const abandoned: string[] = []
const sent = vi.hoisted(() => ({ handoff: false }))

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
		createAgentSession: async (): Promise<AgentSession> =>
			({
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
					facts.paused = false
					return (async function* (): AsyncIterable<AgentEvent> {
						yield { kind: 'done' } as AgentEvent
					})()
				},
				abandonTurn: async (turnId: string) => {
					abandoned.push(turnId)
					facts.paused = false
				},
				close: async () => {},
				approvalLatched: () => false,
				resetApprovalLatch: () => {},
				setPermissionMode: async () => {},
				promptExemptTools: () => [],
				send: async function* (): AsyncIterable<AgentEvent> {
					sent.handoff = true
					facts.paused = true
					yield {
						kind: 'paused',
						turnId: PARKED,
						checkpointId: 'cp-1',
						reason: REASON,
						handoff: { kind: 'human-required', reason: REASON },
					} as AgentEvent
				},
			}) as unknown as AgentSession,
	}
})

const { App } = await import('../App.js')

const ctx = (initialConversationId?: string): TuiContext =>
	({
		cwd: process.cwd(),
		version: '0.0.0-test',
		rules: [],
		skipPermissions: false,
		...(initialConversationId ? { initialConversationId } : {}),
	}) as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	resumed.length = 0
	abandoned.length = 0
	facts.paused = false
	facts.scheduled = false
	sent.handoff = false
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

async function pausedByHandoff() {
	const harness = render(<App ctx={ctx()} />)
	mounted.push(harness)
	await until(() => (harness.lastFrame() ?? '').includes('Type a message'), 'the composer')
	await tick(60)
	for (const ch of 'open the page') {
		harness.stdin.write(ch)
		await tick(5)
	}
	await tick(40)
	harness.stdin.write('\r')
	await until(
		() => (harness.lastFrame() ?? '').includes('press Enter to continue'),
		'the handoff notice',
	)
	const frame = harness.lastFrame() ?? ''
	expect(frame).toContain(`needs you: ${REASON}`)
	expect(frame).toContain('Esc to stop')
	expect(frame).toContain('enter continue · esc stop')
	return harness
}

describe('a turn a tool paused for a person', () => {
	it('continues on Enter', async () => {
		const harness = await pausedByHandoff()
		expect(resumed).toHaveLength(0)
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.turnId).toBe(PARKED)
		expect(resumed[0]?.pendingDecision).toBeUndefined()
		// Told why it goes on now; the last result alone read as final.
		expect(resumed[0]?.systemNote).toContain(`a tool needed a person: ${REASON}`)
		expect(resumed[0]?.systemNote).toContain('Try the step that stopped again')
		expect(abandoned).toHaveLength(0)
		await until(
			() => (harness.lastFrame() ?? '').includes(PAUSED_TURN_LINES.resuming),
			'the continuing line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
	})

	it('stops on Esc', async () => {
		const harness = await pausedByHandoff()
		harness.stdin.write('\u001b')
		await until(() => abandoned.length > 0, 'the abandoned turn')
		expect(abandoned[0]).toBe(PARKED)
		expect(resumed).toHaveLength(0)
		await until(() => !(harness.lastFrame() ?? '').includes('enter continue'), 'the hint cleared')
		await until(
			() => (harness.lastFrame() ?? '').includes('Stopped the paused turn.'),
			'the stopped line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
	})
})

describe('namzu resume <id> of a scheduled run a tool paused for a person', () => {
	async function opened() {
		facts.paused = true
		facts.scheduled = true
		const harness = render(<App ctx={ctx(CONVERSATION)} />)
		mounted.push(harness)
		await until(
			() => (harness.lastFrame() ?? '').includes('Continue the scheduled run?'),
			'the Continue / Abandon choice',
		)
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('Continue')
		expect(frame).toContain('Abandon')
		expect(frame).toContain('needs you: Sign in to example.test')
		expect(resumed).toHaveLength(0)
		return harness
	}

	it('continues the run on Continue', async () => {
		const harness = await opened()
		harness.stdin.write('1')
		await tick(40)
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.turnId).toBe(PARKED)
		expect(resumed[0]?.permissionMode).toBe('prompt')
		expect(abandoned).toHaveLength(0)
		await until(
			() => (harness.lastFrame() ?? '').includes(PAUSED_TURN_LINES.resuming),
			'the continuing line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
	})

	it('abandons the run on Abandon', async () => {
		const harness = await opened()
		harness.stdin.write('2')
		await tick(40)
		harness.stdin.write('\r')
		await until(() => abandoned.length > 0, 'the abandoned turn')
		expect(abandoned[0]).toBe(PARKED)
		expect(resumed).toHaveLength(0)
		await until(
			() => (harness.lastFrame() ?? '').includes(PAUSED_TURN_LINES.abandonedScheduled),
			'the stopped line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
		expect(harness.lastFrame() ?? '').not.toContain(PAUSED_TURN_LINES.resuming)
	})
})
