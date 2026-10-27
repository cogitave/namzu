/**
 * The `/resume` picker through the production App: typing narrows the list,
 * Ctrl+R renames the selected conversation in place, and Ctrl+A switches to
 * the conversations of every folder (which are listed and found, but opened
 * from their own folder).
 */

import type { Message } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const titleState = vi.hoisted(() => ({
	writes: [] as string[],
}))
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => '91d5cf2f-12e5-4cee-a622-e9d3cc9b17f0',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	loadConversation: async () => [],
	loadResumableConversation: async () => [],
	setTitle: async (_sessions: unknown, _sessionId: string, title: string) => {
		titleState.writes.push(title)
	},
	listRecent: async () => [
		{
			id: '294e464a-4578-4ad2-b3f3-f531d33f88bb',
			title: 'Fix the build',
			firstPrompt: 'why does the build fail',
			updatedAt: new Date().toISOString(),
			count: 2,
			named: false,
		},
		{
			id: '394e464a-4578-4ad2-b3f3-f531d33f88bb',
			title: 'Draft release notes',
			firstPrompt: 'write the notes',
			updatedAt: new Date().toISOString(),
			count: 2,
			named: false,
		},
	],
	listOtherFolders: async () => [
		{
			id: '494e464a-4578-4ad2-b3f3-f531d33f88bb',
			title: 'Invoice question',
			updatedAt: new Date().toISOString(),
			count: 2,
			named: false,
			folder: 'billing',
		},
	],
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
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			providerSummary: 'OpenAI (Codex subscription)',
			modelSummary: 'gpt-test',
			toolNames: () => [],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by rename prompt')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			send: async function* (_messages: readonly Message[]): AsyncIterable<AgentEvent> {
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	titleState.writes.length = 0
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 100): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		// A lone Escape is intentionally held briefly by Ink's terminal parser so
		// it can distinguish it from the prefix of an arrow/function-key sequence.
		await new Promise((resolve) => setTimeout(resolve, 20))
		await screen.waitForRender()
	}
	expect(predicate(), screen.viewport().join('\n')).toBe(true)
}

function painted(screen: Screen): string {
	return screen.viewport().join('\n')
}

async function openPicker(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('gpt-test'))
	screen.press('/resume')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Resume a conversation'))
	return screen
}

it('narrows the list as the person types and shows the opening lines', async () => {
	const screen = await openPicker()
	expect(painted(screen)).toContain('Fix the build')
	expect(painted(screen)).toContain('Draft release notes')
	screen.press('notes')
	await waitUntil(screen, () => !painted(screen).includes('Fix the build'))
	expect(painted(screen)).toContain('Search: notes')
	expect(painted(screen)).toContain('Started with: write the notes')
})

it('renames the selected conversation without leaving the picker', async () => {
	const screen = await openPicker()
	screen.press('\x12')
	await waitUntil(screen, () => painted(screen).includes('Name: '))
	screen.press('Build trouble')
	await waitUntil(screen, () => painted(screen).includes('Name: Build trouble'))
	screen.press('\r')
	await waitUntil(screen, () => titleState.writes.length === 1)
	expect(titleState.writes).toEqual(['Build trouble'])
	expect(painted(screen)).toContain('Resume a conversation')
})

it('switches to every folder and explains that those conversations open from their own folder', async () => {
	const screen = await openPicker()
	screen.press('\x01')
	await waitUntil(screen, () => painted(screen).includes('All folders'))
	expect(painted(screen)).toContain('billing')
	screen.press('Invoice')
	await waitUntil(screen, () => !painted(screen).includes('Fix the build'))
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('belongs to billing'))
	expect(painted(screen)).toContain('Resume a conversation')
})
