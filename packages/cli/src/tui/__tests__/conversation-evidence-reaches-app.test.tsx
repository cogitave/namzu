import { type SessionEvent, ToolManager, createToolPresenter, generateTurnId } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import { type Screen, renderToScreen } from './support/screen.js'

let calls: { name: string; result: string; isError?: boolean }[] = []
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
			preferences: { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } },
			needsRepickReason: null, detected: [],
		}),
		createAgentSession: async () => fakeAgentSession({
			send: async function* () {
				const presenter = createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] }))
				const turnId = generateTurnId()
				for (const [index, call] of calls.entries()) {
					for (const event of [
						{ type: 'tool_executing', turnId, toolUseId: `call-${index}`, toolName: call.name, input: {} },
						{ type: 'tool_completed', turnId, toolUseId: `call-${index}`, toolName: call.name, result: call.result, isError: call.isError ?? false },
					]) {
						const mapped = actual.toAgentEvent(event as unknown as SessionEvent, presenter)
						if (mapped) yield mapped
					}
				}
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')
let screen: Screen | undefined
afterEach(async () => { await screen?.unmount(); screen = undefined })

async function until(predicate: () => boolean) {
	for (let i = 0; i < 120 && !predicate(); i++) await screen!.waitForRender()
	expect(predicate(), screen!.viewport().join('\n')).toBe(true)
}

async function start(cols: number) {
	screen = await renderToScreen(<App ctx={{ cwd: '/work', version: 'test' }} />, { cols, rows: 40, scrollback: 400 })
	await until(() => screen!.scrollback().join('\n').includes('mock-model'))
	screen.press('recover earlier receipt')
	await screen.waitForRender()
	screen.press('\r')
	return screen
}

it.each([40, 100])('shows preview and original error status, then opens the full JSON at %i columns', async (cols) => {
	calls = [{ name: 'read_conversation', result: JSON.stringify({
		turnId: 'bcd3d4e0-ea88-4cfa-afb1-ed135da49ea8', seq: 2, part: 0,
		recordKind: 'tool_result', source: 'tool_completed', toolName: 'read', isError: true,
		text: `${'retained '.repeat(60)}FINAL_RECEIPT`, offset: 0, complete: true, retainedPreview: true,
	}) }]
	const s = await start(cols)
	const painted = () => s.scrollback().join('\n')
	await until(() => /ctrl\+o\s+details/.test(painted()))
	expect(painted()).toContain('Conversation read')
	expect(painted()).toContain('Preview flagged')
	expect(painted()).toContain('Original tool reported an error')
	expect(painted()).not.toContain('failed:')
	expect(painted()).not.toContain('FINAL_RECEIPT')
	s.press('\x0f')
	await until(() => s.viewport().join('\n').includes('Tool output'))
	expect(s.viewport().join('\n')).not.toContain('Preview flagged')
	s.press('G')
	await until(() => s.viewport().join('\n').includes('retainedPreview'))
	expect(s.viewport().join('\n')).toContain('FINAL_RECEIPT')
	expect(s.viewport().join('\n')).toContain('true')
	s.press('q')
	await until(() => !s.viewport().join('\n').includes('Tool output'))
	expect(painted().match(/Conversation read/g)).toHaveLength(1)
})

it('renders incomplete search and empty lookup honestly, and leaves retrieval failures visible', async () => {
	calls = [
		{ name: 'search_conversation', result: JSON.stringify({ matches: [], incomplete: true, unavailable: 1 }) },
		{ name: 'read_conversation', result: JSON.stringify({ text: '', offset: 0, complete: false, retainedPreview: false, nextCursor: 'opaque' }) },
		{ name: 'read_conversation', isError: true, result: 'Cannot read this evidence address.' },
	]
	const s = await start(100)
	const painted = () => s.scrollback().join('\n')
	await until(() => painted().includes('failed: Cannot read this evidence address.'))
	expect(painted()).toContain('0 matches on this page')
	expect(painted()).toContain('Search incomplete · absence is inconclusive')
	expect(painted()).toContain('1 record(s) unavailable')
	expect(painted()).toContain('Locating retained text · continue scan')
	expect(painted()).not.toContain('Selected retained part returned')
})
