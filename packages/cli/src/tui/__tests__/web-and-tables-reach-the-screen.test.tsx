/**
 * A research turn — hosted searches, a page fetch, then an answer with a
 * table — as the operator sees it, at 160, 120, 80 and 40 columns.
 *
 * Every event goes through the real adapter (`toAgentEvent`), so this is the
 * path a provider's hosted search takes to the screen: the query on the row,
 * a settled `⎿` line under it, consecutive calls together, and a table drawn
 * as a box where it fits and as records where it does not, with its inline
 * markdown drawn rather than shown.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { WebFetchTool, createToolPresenter, generateTurnId, type SessionEvent , ToolManager } from '@namzu/sdk'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'
import { testToolset } from '../../test-support/toolset.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
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
			toolNames: () => ['computer_use'],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (messages): AsyncIterable<AgentEvent> {
				const last = messages.at(-1)
				if (typeof last?.content === 'string' && last.content.includes('count')) {
					// A turn that writes, reports its spend, writes more, and then
					// waits: the Working row is on screen with its count.
					yield { kind: 'delta', text: 'x'.repeat(2_000) }
					yield {
						kind: 'usage',
						totalTokens: 9_000,
						outputTokens: 1_000,
						cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
					} as AgentEvent
					yield { kind: 'reasoning', text: 'y'.repeat(400) }
					await new Promise<void>((resolve) => {
						release = resolve
					})
					yield { kind: 'done', stopReason: 'end_turn' }
					return
				}
				const registry = new ToolManager({ toolsets: [testToolset(...[WebFetchTool])], messages: () => [] })
				const presenter = createToolPresenter(registry)
				const turnId = generateTurnId()
				const hosted = (id: string, status: string, query?: string, results?: number) => ({
					type: 'hosted_tool',
					turnId,
					iteration: 1,
					tool: { id, name: 'web_search', status, ...(query ? { query } : {}), ...(results !== undefined ? { results } : {}) },
				})
				const events = [
					// The provider names the query only when the call completes.
					hosted('s1', 'running'),
					hosted('s1', 'completed', QUERY),
					hosted('s2', 'running', 'OpenClaw embedded runtime'),
					hosted('s2', 'completed', 'OpenClaw embedded runtime', 3),
					{ type: 'tool_executing', turnId, toolUseId: 'f1', toolName: 'web_fetch', input: { url: 'https://docs.openclaw.ai/agent-runtime' } },
					{ type: 'tool_completed', turnId, toolUseId: 'f1', toolName: 'web_fetch', result: 'x'.repeat(2048), isError: false, durationMs: 1_200 },
					{ type: 'text_delta', turnId, text: ANSWER },
				]
				for (const event of events) {
					const mapped = actual.toAgentEvent(event as unknown as SessionEvent, presenter)
					if (mapped) yield mapped
				}
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

let release: (() => void) | undefined

const QUERY = 'OpenClaw agent runtime built on pi-agent-core framework and its native harness layer'
const ANSWER = [
	'OpenClaw’ın native agent runtime’ı kendi gömülü çekirdeği üzerine kurulu; harici bir framework kullanılmıyor.',
	'',
	'Net stack',
	'',
	'| Katman | Kullanılan yapı |',
	'|---|---|',
	'| **Agent core** | `@openclaw/agent-core` — agent loop, harness tipleri, mesajlar, compaction yardımcıları ve oturum saklama sözleşmeleri |',
	'| TUI | **`@earendil-works/pi-tui`**, [kaynak](https://github.com/openclaw/openclaw) |',
].join('\n')

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 160): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate()).toBe(true)
}

async function research(cols: number): Promise<string[]> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows: 60, scrollback: 400 })
	mounted = screen
	const painted = () => screen.scrollback().join('\n')
	await waitUntil(screen, () => painted().includes('a-model'))
	screen.press('research')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted().includes('TUI'))
	return screen.scrollback()
}

it.each([160, 120, 80, 40])('names each web call and settles it under its row at %i columns', async (cols) => {
	const lines = await research(cols)
	// Nothing the renderer drew reaches the last column, where a terminal
	// would wrap it a second time.
	for (const line of lines) expect([...line].length).toBeLessThanOrEqual(cols)
	const first = lines.findIndex((line) => line.includes('✓ Web search("OpenClaw agent'))
	expect(first).toBeGreaterThan(-1)
	// The query is cut at the terminal's width with an ellipsis, never wrapped.
	if (cols < 100) expect(lines[first]).toMatch(/…$/u)
	else expect(lines[first]).toContain(`Web search("${QUERY}")`)
	expect(lines[first + 1]).toMatch(/⎿ Did 1 search in \d/u)
	// The next search follows at once: no blank line between consecutive calls.
	expect(lines[first + 2]).toContain('✓ Web search("OpenClaw embedded')
	expect(lines[first + 3]).toMatch(/⎿ Found 3 results in \d/u)
	expect(lines[first + 4]).toContain('✓ Web fetch(https://docs.openclaw.ai/')
	expect(lines[first + 5]).toMatch(/⎿ Received 2\.0KB in 1\.2s/u)
	// The fetched body waits behind Ctrl+O rather than filling the screen.
	expect(lines.join('\n')).not.toContain('xxxxxxxx')
})

/** The rows of the answer's table: from its top rule to its bottom one. */
function tableRows(lines: readonly string[]): string[] {
	const top = lines.findIndex((line) => /^ {3}┌/u.test(line))
	const bottom = lines.findIndex((line) => /^ {3}└/u.test(line))
	return top < 0 ? [] : lines.slice(top, bottom + 1)
}

it.each([160, 120, 80])('draws the answer’s table as a box at %i columns', async (cols) => {
	const lines = await research(cols)
	const box = tableRows(lines)
	expect(box.length).toBeGreaterThan(0)
	// Every row of the box is the same width, within the row the text has.
	const widths = new Set(box.map((line) => line.trimEnd().length))
	expect(widths.size).toBe(1)
	expect([...widths][0]).toBeLessThanOrEqual(cols - 1)
	// Where a cell needs the room, the box takes all of it and wraps the rest.
	if (cols < 160) expect([...widths][0]).toBe(cols - 1)
	const drawn = box.join('\n')
	expect(drawn).toContain('│ Agent core')
	expect(drawn).toContain('@openclaw/agent-core')
	expect(drawn).toContain('@earendil-works/pi-tui')
	expect(drawn).not.toMatch(/\*\*|`/)
	expect(drawn).toMatch(/├─+┼─+┤/u)
})

it('stacks the answer’s table as records at 40 columns', async () => {
	const lines = await research(40)
	const text = lines.join('\n')
	expect(tableRows(lines)).toEqual([])
	expect(text).toContain('Katman: Agent core')
	expect(text).toContain('Katman: TUI')
	expect(text).toMatch(/─{20,}/u)
	expect(text).not.toMatch(/\*\*|`/)
	// Prose rows start in the column the first one did: no space carried over
	// from the break.
	const prose = lines.filter((line) => /^ {3}\S/u.test(line) || /^ {4}\S/u.test(line))
	expect(prose.filter((line) => /^ {4}\S/u.test(line))).toEqual([])
})

it.each([160, 120, 80, 40])('counts the running turn’s output tokens on the Working row at %i columns', async (cols) => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows: 40, scrollback: 200 })
	mounted = screen
	const painted = () => screen.viewport().join('\n')
	await waitUntil(screen, () => painted().includes('a-model'))
	screen.press('count')
	await screen.waitForRender()
	screen.press('\r')
	// The provider's 1,000 plus 400 characters of reasoning since: 1.1k. The
	// count is redrawn at most five times a second, so the last one of the
	// burst lands when the interval ends.
	await waitUntil(screen, () => painted().includes('↓ 1.0k tokens'))
	await new Promise((resolve) => setTimeout(resolve, 250))
	await waitUntil(screen, () => painted().includes('↓ 1.1k tokens'))
	const row = screen.viewport().find((line) => line.includes('↓ 1.1k tokens')) ?? ''
	expect(row).toContain('Working')
	expect([...row].length).toBeLessThanOrEqual(cols)
	release?.()
})
