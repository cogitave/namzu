/**
 * `/resume` on a parked turn hands the resumed turn the operator's mode.
 *
 * The interactive terminal creates its session WITHOUT a permission mode and
 * hands one to every turn it sends. `/resume` handed none, so the session fell
 * back to `auto`: an operator in plan mode resumed a parked turn and it — and
 * every child it delegated — had its changes approved. This drives a rendered
 * `<App>` into plan mode with Shift+Tab, types `/resume`, and reads what the
 * session was asked for, including the live read a later Shift+Tab reaches.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, ResumePausedParams } from '../agent.js'
import type { TuiContext } from '../types.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const CONVERSATION = '0ac90d46-4041-4402-8bc7-89c9a8c75f73'
const PARKED = '3b0329bb-f60a-48dc-9552-1b386c52cfe8'

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => ({ turnId: PARKED }),
	openSessions: async () => ({
		tenantId: 'tenant',
		projectId: '08c9b09c-4412-478c-878b-dc94927c760f',
		topicId: '4bd72c65-bcc9-475c-8d7c-27d622df04e8',
	}),
	startConversation: async () => CONVERSATION,
	loadResumableConversation: async () => [
		{ role: 'user', content: 'write the file', timestamp: 1 },
	],
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))

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
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
			presenter: genericPresenter,
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
			resumePaused: (params) => {
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
		}),
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
	for (const m of mounted.splice(0)) m.unmount()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SHIFT_TAB = '\u001b[Z'

async function until(check: () => boolean, what: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (check()) return
		await tick(20)
	}
	throw new Error(`${what} did not happen within ${budgetMs}ms`)
}

describe('/resume on a parked turn', () => {
	it('resumes it under the operator’s plan mode, read live', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await until(() => (harness.lastFrame() ?? '').includes('Type a message'), 'the composer')
		await tick(60)

		// prompt → accept-edits → plan
		harness.stdin.write(SHIFT_TAB)
		await until(
			() => (harness.lastFrame() ?? '').includes('Auto-approve edits'),
			'accept-edits',
		)
		harness.stdin.write(SHIFT_TAB)
		await until(() => (harness.lastFrame() ?? '').includes('Plan (read-only)'), 'plan mode')

		for (const ch of '/resume') {
			harness.stdin.write(ch)
			await tick(5)
		}
		await tick(60)
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resume')

		const params = resumed[0]
		expect(params?.turnId).toBe(PARKED)
		expect(params?.permissionMode).toBe('plan')
		expect(params?.currentPermissionMode?.()).toBe('plan')

		// Leaving plan mode later is what the running turn reads next.
		harness.stdin.write(SHIFT_TAB)
		await until(
			() => !(harness.lastFrame() ?? '').includes('Plan (read-only)'),
			'leaving plan mode',
		)
		expect(params?.currentPermissionMode?.()).toBe('prompt')
	})
})
