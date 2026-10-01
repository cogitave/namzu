/** The terminal keeps Pal execution and profile authority across navigation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Pal } from '../../pals/store.js'
import type { AgentSessionOptions } from '../agent.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import { renderToScreen, type Screen } from './support/screen.js'

const fixture = vi.hoisted(() => ({
	pal: { id: 'pal_fixture', name: 'Researcher', purpose: 'Original purpose', revision: 1, workspace: '/pal-control', model: { provider: 'openai', model: 'pal-model-one' } } as Pal,
	bindings: new Map<string, Pal>(),
	constructed: [] as { prefs: Preferences; options: AgentSessionOptions }[],
	nextHydration: undefined as (() => void) | undefined,
	computerError: undefined as Error | undefined,
	probe: vi.fn(),
	claim: vi.fn(),
}))
const first = '83d74bb0-f9a6-4edb-958c-3c254e7a7196'

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../pals/tui-session.js', () => ({
	tuiPalOwner: () => fixture.pal,
	tuiPalDefinition: async (_cwd: string, id: string) => {
		const definition = fixture.bindings.get(id)
		if (!definition) throw new Error('This conversation is not claimed by this Pal.')
		return definition
	},
	tuiPalPreferences: (definition: Pal, prefs: Preferences) => ({ ...prefs, providers: [{ id: definition.model!.provider, model: definition.model!.model }] }),
	tuiPalEnvironment: async (definition: Pal, sessionId: string) => {
		if (fixture.computerError) throw fixture.computerError
		return { definition, lease: { palId: definition.id }, sessionId, admit: async () => ({}) }
	},
}))
vi.mock('../../pals/conversations.js', () => ({
	claimPalConversation: async (_cwd: string, _palId: string, id: string) => {
		fixture.claim(id)
		fixture.bindings.set(id, { ...fixture.pal })
	},
	listPalConversations: async () => [...fixture.bindings].map(([id]) => ({ id, title: id, named: true, count: 0, updatedAt: new Date(0).toISOString() })),
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 'tenant', projectId: 'project', topicId: 'topic' }),
	loadResumableConversation: async () => [],
	loadConversation: async () => [],
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => {
			fixture.probe()
			return { preferences: { version: 3, providers: [{ id: 'ollama', model: 'ordinary-model' }], subagents: { active: [] } }, needsRepickReason: null, detected: [] }
		},
		createAgentSession: async (prefs: Preferences, _detected: unknown, options: AgentSessionOptions) => {
			fixture.constructed.push({ prefs, options })
			fixture.nextHydration?.()
			fixture.nextHydration = undefined
			return fakeAgentSession({ providerSummary: 'Pal provider', modelSummary: prefs.providers[0]!.model, configNotices: ['Pal computer ready'] })
		},
	}
})

const { App } = await import('../App.js')
const screens: Screen[] = []
beforeEach(() => {
	fixture.pal = { ...fixture.pal, revision: 1, purpose: 'Original purpose', model: { provider: 'openai', model: 'pal-model-one' } }
	fixture.bindings.clear()
	fixture.bindings.set(first, { ...fixture.pal })
	fixture.constructed.length = 0
	fixture.probe.mockClear()
	fixture.computerError = undefined
	fixture.claim.mockClear()
})
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})
function nextHydration(): Promise<void> {
	return new Promise((resolve) => { fixture.nextHydration = resolve })
}
async function terminal(id = first): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={{
		cwd: '/pal-control', version: 'test', palId: fixture.pal.id, initialConversationId: id,
		mcpServers: { leaked: { type: 'stdio', command: 'host-command' } } as never,
		plugins: { enabled: true } as never,
		browser: { enabled: true } as never,
	}} />, { cols: 100, rows: 28 })
	screens.push(screen)
	return screen
}

it('pins the Pal model and forwards only its owned execution environment', async () => {
	const hydrated = nextHydration()
	const screen = await terminal()
	await hydrated
	await screen.waitForRender()
	const call = fixture.constructed[0]!
	expect(call.prefs.providers).toEqual([{ id: 'openai', model: 'pal-model-one' }])
	expect(call.options.palEnvironment?.definition).toMatchObject({ id: fixture.pal.id, revision: 1 })
	expect(call.options).not.toHaveProperty('mcpServers')
	expect(call.options).not.toHaveProperty('plugins')
	expect(call.options).not.toHaveProperty('browser')
	expect(call.options).not.toHaveProperty('extraTools')
	const next = nextHydration()
	fixture.pal = { ...fixture.pal, revision: 2, purpose: 'Edited purpose', model: { provider: 'anthropic', model: 'pal-model-two' } }
	screen.press('/new')
	await screen.waitForRender()
	screen.press('\r')
	await next
	await screen.waitForRender()
	expect(fixture.claim).toHaveBeenCalledOnce()
	expect(fixture.constructed[1]!.prefs.providers).toEqual([{ id: 'anthropic', model: 'pal-model-two' }])
	expect(fixture.constructed[1]!.options.palEnvironment?.definition).toMatchObject({ revision: 2, purpose: 'Edited purpose' })
})

it('refuses unclaimed resume history before discovering or constructing a provider', async () => {
	const screen = await terminal('632ffda3-266b-4fc0-a8a4-e15a2ae4ea61')
	// Flush React and Ink's scheduled frame, without racing wall-clock time.
	for (let turn = 0; turn < 8; turn++) { await screen.waitForRender(); await new Promise<void>((resolve) => setImmediate(resolve)) }
	expect(screen.scrollback().join('\n').replace(/\s+/gu, ' ')).toContain('not claimed by this Pal')
	expect(fixture.probe).not.toHaveBeenCalled()
	expect(fixture.constructed).toHaveLength(0)
	expect(fixture.claim).not.toHaveBeenCalled()
})

it('stops startup when the Pal computer is unavailable without constructing an ordinary host session', async () => {
	fixture.computerError = new Error('Local computer engine unavailable')
	const screen = await terminal()
	for (let turn = 0; turn < 8; turn++) { await screen.waitForRender(); await new Promise<void>((resolve) => setImmediate(resolve)) }
	expect(screen.scrollback().join('\n')).toContain('Local computer engine unavailable')
	expect(fixture.constructed).toHaveLength(0)
})
