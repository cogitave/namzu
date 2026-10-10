/**
 * A startup that stopped on a config file the person can fix.
 *
 * Found in a real run with a broken `namzu.config.json`: the sentence began
 * with a stray "· " (the dot every system note carries), and under it a second
 * block, "Startup stopped / Resolve the error above, then restart Namzu.",
 * repeated what the sentence had just said ("Fix it, then start Namzu again.").
 * Beneath that the footer advertised Shift+Tab with no composer on screen.
 */

import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { ConfigLoadError } from '../../config/load.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const SENTENCE =
	"namzu.config.json in this project isn't valid JSON (line 3, column 3). Fix it, then start Namzu again."

const lifecycle = vi.hoisted(() => ({
	/** Whether the sentence that stops startup already says what to do. */
	complete: true,
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
		openSessions: async () => {
			throw new ConfigLoadError('namzu.config.json', SENTENCE, {
				complete: lifecycle.complete,
			})
		},
	}
})
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: vi.fn(),
	}
})

const { App } = await import('../App.js')
const dirs: string[] = []
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true })
})

async function open(cols: number): Promise<string[]> {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-app-config-stop-'))
	dirs.push(cwd)
	const screen = await renderToScreen(<App ctx={{ cwd, version: '0.0.0-test' }} />, {
		cols,
		rows: 20,
	})
	mounted = screen
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(screen.viewport().join(' ').replace(/\s+/g, ' ')).toContain('start Namzu again.')
	})
	return screen.viewport()
}

it.each([40, 80, 116])(
	'shows the sentence alone, with no dot, no second advice and no cycle key, at %i columns',
	async (cols) => {
		lifecycle.complete = true
		const viewport = await open(cols)
		const text = viewport.join('\n')
		const flat = text.replace(/\s+/g, ' ')
		expect(flat).toContain("namzu.config.json in this project isn't valid JSON (line 3, column 3).")
		expect(flat).toContain('Fix it, then start Namzu again.')
		expect(text).not.toContain('Startup stopped')
		expect(text).not.toContain('Resolve the error above')
		expect(text).not.toContain('shift+tab')
		// The sentence is the first thing on screen, and nothing marks it with a dot.
		const first = viewport.find((line) => line.trim() !== '') ?? ''
		expect(first.trimStart().startsWith('·')).toBe(false)
		expect(first.trimStart().startsWith('namzu.config.json')).toBe(true)
	},
)

it('keeps "Startup stopped" where the error does not say what to do', async () => {
	lifecycle.complete = false
	const viewport = await open(80)
	const text = viewport.join('\n')
	expect(text).toContain('Startup stopped')
	expect(text).toContain('Resolve the error above, then restart Namzu.')
	expect(text).not.toContain('shift+tab')
})
