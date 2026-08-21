/** Agent-owned text is escaped on the actual App → Ink → terminal path. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, PermissionRequest } from '../agent.js'
import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const BEL = String.fromCodePoint(0x07)
const CSI = String.fromCodePoint(0x9b)
const BIDI = String.fromCodePoint(0x202e)
const UNSAFE = `SOURCE${BEL} bell ${CSI}31m colour ${BIDI}reordered`
const VISIBLE = 'SOURCE\\u{0007} bell \\u{009b}31m colour \\u{202e}reordered'
const REQUEST: PermissionRequest = Object.freeze({
	toolCalls: Object.freeze([
		Object.freeze({
			id: 'call-unsafe',
			name: `bash${BEL}${CSI}${BIDI}`,
			summary: UNSAFE,
			preview: Object.freeze([UNSAFE]),
			isDestructive: true,
		}),
	]),
})
const REQUEST_SOURCE = structuredClone(REQUEST)
const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

let releaseLiveTool: (() => void) | null = null
let nowMs = 1_000_000

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
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
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			resumeDurable: async () => {
				throw new Error('not used by this TUI path')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (_messages, options): AsyncIterable<AgentEvent> {
				yield { kind: 'delta', text: 'permission follows' } as AgentEvent
				const decision = await options?.onPermission?.(REQUEST)
				if (!decision || decision.kind === 'reject') return
				yield {
					kind: 'tool-start',
					toolUseId: 'call-unsafe',
					toolName: 'bash',
					summary: UNSAFE,
					detail: [UNSAFE],
				} as AgentEvent
				await new Promise<void>((resolve) => {
					releaseLiveTool = resolve
				})
				yield {
					kind: 'tool-end',
					toolUseId: 'call-unsafe',
					toolName: 'bash',
					summary: UNSAFE,
					detail: [UNSAFE],
					isError: false,
				} as AgentEvent
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }
let mounted: Screen | null = null

beforeEach(() => {
	releaseLiveTool = null
	nowMs = 1_000_000
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(async () => {
	releaseLiveTool?.()
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

function painted(screen: Screen): string {
	return screen.scrollback().join('\n')
}

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 120): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate()).toBe(true)
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

function expectNoAgentControls(screen: Screen): void {
	const writes = screen.writes().join('')
	expect(writes).not.toContain(BEL)
	expect(writes).not.toContain(CSI)
	expect(writes).not.toContain(BIDI)
}

it('escapes permission, live-tool and transcript output while preserving the request DTO', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 180, rows: 32 })
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to a-provider'))

	await submit(screen, 'run the proposed call')
	await waitUntil(screen, () => painted(screen).includes('wants to run'))
	expect(painted(screen)).toContain(VISIBLE)
	expectNoAgentControls(screen)
	expect(REQUEST).toEqual(REQUEST_SOURCE)

	nowMs += APPROVAL_SETTLE_MS + 1
	screen.press('y')
	await waitUntil(screen, () => painted(screen).includes(`Bash(${VISIBLE})`))
	expectNoAgentControls(screen)

	releaseLiveTool?.()
	releaseLiveTool = null
	await waitUntil(screen, () => painted(screen).includes(`✓ Bash(${VISIBLE})`))
	expect(painted(screen)).toContain(VISIBLE)
	expectNoAgentControls(screen)
	expect(REQUEST).toEqual(REQUEST_SOURCE)
})
