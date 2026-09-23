/**
 * A turn the browser paused because a page needs the operator. The notice
 * says what to do and where: in the browser window, under which profile,
 * when the browser has a window; the `namzu browser login` command, with
 * the session's browser closed to free the profile, when it has none. Enter
 * continues, as for any handoff.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, ResumePausedParams } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const CONVERSATION = '0ac90d46-4041-4402-8bc7-89c9a8c75f73'
const PARKED = '3b0329bb-f60a-48dc-9552-1b386c52cfe8'
const REASON = 'https://github.com is showing a sign-in page'

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
const sent = vi.hoisted(() => ({ handoff: false, headless: false, released: 0 }))

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
				toolNames: () => ['bash', 'browser', 'browser_act'],
				browser: {
					host: {},
					status: () => ({
						profile: 'work',
						engine: 'windows-cdp',
						browser: 'chrome',
						headless: sent.headless,
						running: true,
						warnings: [],
						sites: { '*': 'ask' },
						keepOpen: false,
					}),
					switchProfile: async () => {
						throw new Error('not used')
					},
					release: async () => {
						sent.released += 1
					},
					dispose: async () => {},
				},
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
						handoff: {
							kind: 'human-required',
							reason: REASON,
							detail: {
								tool: 'browser',
								cause: 'sign-in',
								origin: 'https://github.com',
								profile: 'work',
								loginCommand: 'namzu browser login work https://github.com/login',
							},
						},
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
	sent.headless = false
	sent.released = 0
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

async function paused(expected: string) {
	const harness = render(<App ctx={ctx()} />)
	mounted.push(harness)
	await until(() => (harness.lastFrame() ?? '').includes('Type a message'), 'the composer')
	await tick(60)
	for (const ch of 'sign me in') {
		harness.stdin.write(ch)
		await tick(5)
	}
	await tick(40)
	harness.stdin.write('\r')
	await until(() => (harness.lastFrame() ?? '').includes(expected), 'the browser notice')
	return harness
}

describe('a turn the browser paused for a sign-in', () => {
	it('sends the operator to the visible window, and continues on Enter', async () => {
		const harness = await paused('in the browser window (profile work)')
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('The browser needs you: https://github.com is showing a sign-in page.')
		expect(frame).toContain(
			'Sign in to https://github.com in the browser window (profile work), then press Enter',
		)
		expect(sent.released).toBe(0)
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.turnId).toBe(PARKED)
	})

	it('gives the login command, and frees the profile, when the browser has no window', async () => {
		sent.headless = true
		const harness = await paused('namzu browser login work https://github.com/login')
		expect(harness.lastFrame() ?? '').not.toContain('in the browser window (profile')
		await until(() => sent.released === 1, 'the browser released')
		harness.stdin.write('\u001b')
		await until(() => abandoned.length > 0, 'the abandoned turn')
	})
})
