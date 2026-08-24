/** `/export` is a finite host choice backed by one verified durable projection. */

import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const MARKDOWN = '# Verified transcript\n\nExact **durable** source.\n'

const exportState = vi.hoisted(() => ({
	projectionCalls: [] as string[],
	fileWrites: [] as Array<{ markdown: string; path: string; cwd: string }>,
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'ses_export_fixture',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	loadConversation: async () => [],
	loadResumableConversation: async () => [],
	setTitle: () => {},
	titleOf: () => undefined,
	listRecent: async () => [],
}))
vi.mock('../../integrations/sessions/transcript-export.js', () => ({
	conversationMarkdown: async (_sessions: unknown, sessionId: string) => {
		exportState.projectionCalls.push(sessionId)
		return { markdown: MARKDOWN, turns: 2 }
	},
	writeConversationExport: async (markdown: string, path: string, cwd: string) => {
		exportState.fileWrites.push({ markdown, path, cwd })
		return { path: `${cwd}/${path}`, bytes: Buffer.byteLength(markdown, 'utf8') }
	},
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
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
			providerSummary: 'OpenAI (Codex subscription)',
			modelSummary: 'gpt-test',
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
			resetApprovalLatch: () => {},
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by export chooser')
			},
			close: async () => {},
			send: async function* (_messages: readonly Message[]): AsyncIterable<AgentEvent> {
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/workspace', version: '0.0.0-test' }
let mounted: Screen | null = null

beforeEach(() => {
	exportState.projectionCalls.length = 0
	exportState.fileWrites.length = 0
})

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

function painted(screen: Screen): string {
	return screen.scrollback().join('\n')
}

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 100): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20))
		await screen.waitForRender()
	}
	expect(predicate(), screen.viewport().join('\n')).toBe(true)
}

async function openExportChooser(screen: Screen): Promise<void> {
	screen.press('/export')
	await screen.waitForRender()
	screen.press('\r')
	// The command's Return cannot also choose the first destination before the
	// picker has been committed to the terminal.
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Export conversation'))
	expect(exportState.projectionCalls).toEqual([])
}

it('chooses a file, prefills its session filename, and writes the verified projection', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 24 })
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))
	await openExportChooser(screen)

	let output = painted(screen)
	expect(output).toContain('Copy to clipboard')
	expect(output).toContain('Save to file')
	expect(output).toContain('existing files are never overwritten')

	screen.press('2')
	await waitUntil(screen, () => painted(screen).includes('Save conversation'))
	output = painted(screen)
	expect(output).toContain('namzu-conversation-ses_export_fixture.md')
	expect(exportState.projectionCalls).toEqual([])

	screen.press('\x15')
	screen.press('reports/final.md')
	screen.press('\r')
	await waitUntil(screen, () => exportState.fileWrites.length === 1)
	await waitUntil(screen, () => painted(screen).includes('Exported 2 turns'))

	expect(exportState.projectionCalls).toEqual(['ses_export_fixture'])
	expect(exportState.fileWrites).toEqual([
		{ markdown: MARKDOWN, path: 'reports/final.md', cwd: '/workspace' },
	])
})

it('sends the same verified projection as one truthful OSC 52 clipboard request', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 24 })
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))
	await openExportChooser(screen)

	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Export copy request sent'))

	const osc = `\x1b]52;c;${Buffer.from(MARKDOWN, 'utf8').toString('base64')}\x07`
	const writes = screen.writes().join('')
	expect(writes.split(osc)).toHaveLength(2)
	expect(painted(screen)).toContain('Terminal, multiplexer or remote-session policy may ignore')
	expect(painted(screen)).toContain('OSC 52; if the clipboard did not change')
	expect(painted(screen)).not.toContain('Copied conversation')
	expect(exportState.projectionCalls).toEqual(['ses_export_fixture'])
	expect(exportState.fileWrites).toEqual([])
})
