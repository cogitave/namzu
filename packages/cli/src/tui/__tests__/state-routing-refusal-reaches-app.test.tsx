/**
 * A broken durable-state route is a startup refusal, not "persistence off".
 *
 * If App swallows `openSessions` here, `createAgentSession` receives no scope
 * or state root and falls back to `<cwd>/.namzu`. That creates a second history
 * precisely when the central/legacy router said it could not choose safely.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const lifecycle = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	stateRoot: undefined as string | undefined,
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/sessions/store.js')>()
	return {
		...actual,
		openSessions: async (cwd: string) => {
			if (lifecycle.stateRoot) return actual.openSessions(cwd, { stateRoot: lifecycle.stateRoot })
			throw new Error('split histories require an explicit repair')
		},
	}
})
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

beforeEach(() => {
	lifecycle.stateRoot = undefined
})

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

async function waitForScreen(screen: Screen, predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 2_000
	while (performance.now() < deadline) {
		await screen.waitForRender()
		if (predicate()) return
		// A standalone Esc is delivered after the input decoder rules out an
		// escape sequence. Let its timer run without assuming a fixed duration.
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
	}
	throw new Error(`Startup refusal did not settle:\n${screen.viewport().join('\n')}`)
}

it.each([
	{
		keyName: 'Esc',
		key: '\x1b',
		persistedIdentity: false,
	},
	{
		keyName: 'Ctrl+C',
		key: '\x03',
		persistedIdentity: true,
	},
])('shows an actionable startup refusal and exits on one $keyName', async ({ key, persistedIdentity }) => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-app-startup-exit-'))
	dirs.push(cwd)
	const identityBytes = Buffer.from(
		'{"tenantId":"tnt_previous_installation","createdAt":"2026-01-01T00:00:00Z"}\n',
	)
	let identityPath: string | undefined
	if (persistedIdentity) {
		const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-app-prefixed-identity-'))
		dirs.push(stateRoot)
		lifecycle.stateRoot = stateRoot
		identityPath = join(stateRoot, 'identity.json')
		writeFileSync(identityPath, identityBytes)
	}
	const onExitSummary = vi.fn()
	const screen = await renderToScreen(
		<App ctx={{ cwd, version: '0.0.0-test' }} onExitSummary={onExitSummary} />,
		{ cols: 60, rows: 14 },
	)
	try {
		await waitForScreen(screen, () => screen.viewport().join('\n').includes('Startup stopped'))
		const viewport = screen.viewport().join('\n')
		expect(viewport).toContain('Resolve the error above, then restart Namzu.')
		expect(viewport).toContain('esc or Ctrl+C exit')
		expect(viewport).not.toContain('Type a message')
		const refusal = screen.scrollback().join('\n').replace(/\n\s*/g, ' ')
		if (identityPath) {
			expect(refusal.replace(/\s/g, '')).toContain(identityPath)
			expect(refusal).toContain('must be a UUID')
			expect(refusal).toContain('Prefixed IDs are not supported')
		} else {
			expect(refusal).toContain('split histories require an explicit repair')
		}
		expect(screen.rawMode()).toBe(true)
		expect(lifecycle.createAgentSession).not.toHaveBeenCalled()
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)

		screen.press(key)
		await waitForScreen(screen, () => !screen.rawMode())
		expect(onExitSummary).toHaveBeenCalledTimes(1)
		expect(onExitSummary).toHaveBeenCalledWith({})
		expect(screen.scrollback().join('\n')).not.toContain('Press Ctrl+C again')
		if (identityPath && lifecycle.stateRoot) {
			expect(readFileSync(identityPath)).toEqual(identityBytes)
			expect(readdirSync(lifecycle.stateRoot)).toEqual(['identity.json'])
			expect(existsSync(join(lifecycle.stateRoot, 'projects'))).toBe(false)
		}
	} finally {
		await screen.unmount()
	}
})
