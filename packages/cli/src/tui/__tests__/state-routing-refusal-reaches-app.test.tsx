/**
 * A broken durable-state route is a startup refusal, not "persistence off".
 *
 * If App swallows `openSessions` here, `createAgentSession` receives no scope
 * or state root and falls back to `<cwd>/.namzu`. That creates a second history
 * precisely when the central/legacy router said it could not choose safely.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const lifecycle = vi.hoisted(() => ({ createAgentSession: vi.fn() }))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => {
		throw new Error('split histories require an explicit repair')
	},
	startConversation: async () => 'ses_unreachable',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
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
		createAgentSession: lifecycle.createAgentSession,
	}
})

const { App } = await import('../App.js')
const mounted: { unmount: () => void }[] = []
const dirs: string[] = []

afterEach(async () => {
	for (const harness of mounted.splice(0)) harness.unmount()
	for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true })
	lifecycle.createAgentSession.mockReset()
})

it('surfaces the routing refusal and never constructs an unscoped agent session', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-app-state-refusal-'))
	dirs.push(cwd)
	const ctx: TuiContext = { cwd, version: '0.0.0-test' }
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)

	const started = performance.now()
	while (
		!(harness.lastFrame() ?? '').includes('split histories') &&
		performance.now() - started < 3_000
	) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 20))
	}

	expect(harness.lastFrame()).toContain('Failed to probe agents')
	expect(harness.lastFrame()).toContain('split histories')
	expect(lifecycle.createAgentSession).not.toHaveBeenCalled()
	expect(existsSync(join(cwd, '.namzu'))).toBe(false)
})
