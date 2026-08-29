/** Agent-owned text is escaped on the actual App → Ink → terminal path. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, PermissionRequest } from '../agent.js'
import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import {
	MAX_PERMISSION_REVIEW_BYTES,
	PERMISSION_REVIEW_PAGE_ROWS,
} from '../permission-review.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const BEL = String.fromCodePoint(0x07)
const CSI = String.fromCodePoint(0x9b)
const BIDI = String.fromCodePoint(0x202e)
const UNSAFE = `SOURCE${BEL} bell ${CSI}31m colour ${BIDI}reordered`
const VISIBLE = 'SOURCE\\u{0007} bell \\u{009b}31m colour \\u{202e}reordered'
const PERMISSION_VISIBLE = 'SOURCE\\u0007 bell \\u{009b}31m colour \\u{202e}reordered'
const PROGRESS_UNSAFE = `PROGRESS${BEL}${CSI}${BIDI}compiled 40/120`
const PROGRESS_VISIBLE = 'PROGRESS\\u{0007}\\u{009b}\\u{202e}compiled 40/120'
const LINK_TARGET = 'https://docs.example.test/guide'
const LINK_LABEL = 'operator guide'
const LINK_OSC = `\u001b]8;;${LINK_TARGET}\u001b\\${LINK_LABEL}\u001b]8;;\u001b\\`
const LOCAL_TARGET = 'file:///tmp/private'
function permissionRequest(input: unknown): PermissionRequest {
	const toolCalls = Object.freeze([
		Object.freeze({
			id: 'call-unsafe',
			name: `bash${BEL}${CSI}${BIDI}`,
			input,
			isDestructive: true,
		}),
	])
	return Object.freeze({ toolCalls })
}

const REQUEST = permissionRequest(Object.freeze({ command: UNSAFE }))
const REQUEST_SOURCE = structuredClone(REQUEST)
const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

let releaseLiveTool: (() => void) | null = null
let nowMs = 1_000_000
let activeRequest: PermissionRequest = REQUEST
const permissionDecisions: unknown[] = []

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
				yield {
					kind: 'delta',
					text: `permission follows — [${LINK_LABEL}](${LINK_TARGET}) and [local](${LOCAL_TARGET})\n\n`,
				} as AgentEvent
				// Real stream chunks arrive across async pulls. Let Ink publish this
				// one before the permission callback temporarily owns the viewport.
				await new Promise<void>((resolve) => setImmediate(resolve))
				const decision = await options?.onPermission?.(activeRequest)
				if (decision) permissionDecisions.push(decision)
				if (!decision || decision.kind === 'reject') return
				yield {
					kind: 'tool-start',
					toolUseId: 'call-unsafe',
					toolName: 'bash',
					summary: UNSAFE,
					detail: [UNSAFE],
				} as AgentEvent
				yield {
					kind: 'tool-progress',
					toolUseId: 'call-unsafe',
					toolName: 'bash',
					message: PROGRESS_UNSAFE,
					fraction: 0.33,
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
	activeRequest = REQUEST
	permissionDecisions.length = 0
	vi.stubEnv('TERM_PROGRAM', 'WezTerm')
	vi.stubEnv('TERM', 'xterm-256color')
	vi.stubEnv('TMUX', '')
	vi.stubEnv('STY', '')
	vi.stubEnv('SSH_TTY', '')
	vi.stubEnv('SSH_CONNECTION', '')
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(async () => {
	releaseLiveTool?.()
	await mounted?.unmount()
	mounted = null
	vi.unstubAllEnvs()
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
	expect(screen.writes().join('')).toContain(LINK_OSC)
	expect(painted(screen)).toContain(LINK_LABEL)
	expect(painted(screen)).not.toContain(`(${LINK_TARGET})`)
	expect(painted(screen)).toContain(`local (${LOCAL_TARGET})`)
	expect(painted(screen)).toContain(PERMISSION_VISIBLE)
	expectNoAgentControls(screen)
	expect(REQUEST).toEqual(REQUEST_SOURCE)

	nowMs += APPROVAL_SETTLE_MS + 1
	screen.press('y')
	await waitUntil(screen, () => painted(screen).includes(`33% · ${PROGRESS_VISIBLE}`))
	expect(painted(screen)).toContain(`Bash(${VISIBLE})`)
	expectNoAgentControls(screen)

	releaseLiveTool?.()
	releaseLiveTool = null
	await waitUntil(screen, () => painted(screen).includes(`✓ Bash(${VISIBLE})`))
	expect(painted(screen)).toContain(VISIBLE)
	expectNoAgentControls(screen)
	expect(REQUEST).toEqual(REQUEST_SOURCE)
})

it('pages a single long JSON string by physical rows in a narrow terminal', async () => {
	const suffix = 'DANGER_TAIL'
	activeRequest = permissionRequest(
		Object.freeze({ command: 'x'.repeat(480), tail: suffix }),
	)
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 40, rows: 24 })
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to a-provider'))
	await submit(screen, 'run the long proposed call')
	await waitUntil(screen, () => screen.viewport().join('\n').includes('Exact prepared input'))

	const first = screen.viewport().join('\n')
	expect(first).not.toContain(suffix)
	const firstRows = screen.viewport()
	const firstStart = firstRows.findIndex((row) => row.includes('Exact prepared input'))
	const firstEnd = firstRows.findIndex((row) => row.includes('↑↓ row'))
	expect(
		firstRows
			.slice(firstStart + 1, firstEnd)
			.filter((row) => /^\s*│\s+[│↳]/u.test(row)).length,
	).toBe(PERMISSION_REVIEW_PAGE_ROWS)

	for (let page = 0; page < 20 && !screen.viewport().join('\n').includes(suffix); page += 1) {
		screen.press('\u001b[6~')
		await screen.waitForRender()
	}

	const last = screen.viewport().join('\n')
	expect(last).toContain(suffix)
	const lastRows = screen.viewport()
	const lastStart = lastRows.findIndex((row) => row.includes('Exact prepared input'))
	const lastEnd = lastRows.findIndex((row) => row.includes('↑↓ row'))
	expect(
		lastRows
			.slice(lastStart + 1, lastEnd)
			.filter((row) => /^\s*│\s+[│↳]/u.test(row)).length,
	).toBe(PERMISSION_REVIEW_PAGE_ROWS)
	const commandCloseRow = lastRows.find((row) => row.includes('",'))
	expect(commandCloseRow).toMatch(/",\s*│\s*$/u)
	expect(activeRequest.toolCalls[0]?.input).toEqual({
		command: 'x'.repeat(480),
		tail: suffix,
	})
})

it('refuses a TUI batch whose complete input cannot fit without truncation', async () => {
	const input = Object.freeze({ command: 'x'.repeat(MAX_PERMISSION_REVIEW_BYTES) })
	activeRequest = permissionRequest(input)
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 80, rows: 24 })
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to a-provider'))
	await submit(screen, 'run an oversized proposed call')
	await waitUntil(screen, () => permissionDecisions.length === 1)

	expect(permissionDecisions).toEqual([
		expect.objectContaining({
			kind: 'reject',
			feedback: expect.stringContaining('complete tool batch exceeds'),
		}),
	])
	expect(screen.viewport().join('\n')).not.toContain('wants to run')
	expect(activeRequest.toolCalls[0]?.input).toBe(input)
})

it('keeps the destination visible when the terminal path is not known to support links', async () => {
	vi.stubEnv('TERM_PROGRAM', 'Apple_Terminal')
	vi.stubEnv('TERM', 'xterm-256color')
	for (const name of [
		'WT_SESSION',
		'KITTY_WINDOW_ID',
		'KONSOLE_VERSION',
		'VTE_VERSION',
		'ALACRITTY_SOCKET',
		'GHOSTTY_RESOURCES_DIR',
	]) {
		vi.stubEnv(name, '')
	}

	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 180,
		rows: 32,
	})
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to a-provider'))
	await submit(screen, 'run the proposed call')
	await waitUntil(screen, () => painted(screen).includes('wants to run'))

	expect(screen.writes().join('')).not.toContain('\u001b]8;;')
	expect(painted(screen)).toContain(`${LINK_LABEL} (${LINK_TARGET})`)
	expect(REQUEST).toEqual(REQUEST_SOURCE)
})
