import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentSessionOptions } from '../agent.js'
import type { TuiContext } from '../types.js'

const state = vi.hoisted(() => ({
	reload: vi.fn(),
	options: undefined as AgentSessionOptions | undefined,
}))
vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../agent.js', async (original) => ({
	...(await original<typeof import('../agent.js')>()),
	probeAgentSession: async () => ({
		preferences: { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } },
		needsRepickReason: null,
		detected: [],
	}),
	createAgentSession: async (_prefs: unknown, _detected: unknown, options: AgentSessionOptions) => {
		state.options = options
		return fakeAgentSession({ reloadPermissionRules: options.reloadPermissionRules })
	},
}))
const { App } = await import('../App.js')
let cwd: string
let unmount: (() => void) | undefined
afterEach(() => {
	unmount?.()
	vi.useRealTimers()
	state.reload.mockReset()
	state.options = undefined
	if (cwd) removeTempDir(cwd)
})
async function settle() {
	// Advance the UI's known debounce/render timers, never race a wall-clock deadline.
	for (let i = 0; i < 6; i++) {
		await vi.advanceTimersByTimeAsync(100)
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
}
it('saves add/remove from the rendered composer and refreshes the already mounted session only after successful edits', async () => {
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	})
	cwd = mkdtempSync(join(tmpdir(), 'namzu-permission-screen-'))
	const app = render(
		<App ctx={{ cwd, version: 'test', reloadPermissionRules: state.reload } as TuiContext} />,
	)
	unmount = app.unmount
	await settle()
	expect(state.options?.reloadPermissionRules).toBe(state.reload)
	const command = async (text: string) => {
		app.stdin.write(text)
		await settle()
		app.stdin.write('\r')
		await settle()
	}
	await command('/permissions add deny Write')
	expect(state.reload).toHaveBeenCalledTimes(1)
	expect(app.lastFrame()).toContain('Applied to later calls')
	expect(
		JSON.parse(readFileSync(join(cwd, 'namzu.config.local.json'), 'utf8')).permissions.write,
	).toBe('deny')
	await command('/permissions remove Write')
	expect(state.reload).toHaveBeenCalledTimes(2)
	expect(
		JSON.parse(readFileSync(join(cwd, 'namzu.config.local.json'), 'utf8')).permissions,
	).toBeUndefined()
	writeFileSync(join(cwd, 'namzu.config.local.json'), '{broken')
	await command('/permissions add allow Write')
	expect(state.reload).toHaveBeenCalledTimes(2)
	expect(app.lastFrame()).toContain('not valid JSON')
	writeFileSync(join(cwd, 'namzu.config.local.json'), '{}')
	state.reload.mockImplementationOnce(() => {
		throw new Error('fixture reload refused')
	})
	await command('/permissions add deny Write')
	expect(state.reload).toHaveBeenCalledTimes(3)
	expect(app.lastFrame()).toContain('Not applied to this session')
	expect(app.lastFrame()).toContain('previous policy remains active')
})
