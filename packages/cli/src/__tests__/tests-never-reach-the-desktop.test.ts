/**
 * No test in the CLI suite can act on the real desktop.
 *
 * Under WSL the CLI reaches the Windows desktop by starting programs:
 * computer use starts cua-driver or PowerShell, the browser opener and the
 * Windows toast start PowerShell. Before `tools/vitest-desktop-guard.mjs`
 * became a setup file here, a test that opened a session started
 * `powershell.exe` to read the display, and another opened a sign-in page in
 * the real browser. The guard turns every such start into the start of a
 * path that does not exist, and the suite runs with `NAMZU_CUA_DRIVER=off`.
 * This drives the real session front door, with the real
 * `@namzu/computer-use`, and shows no click or key can get through.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToolManager, type Toolset } from '@namzu/sdk'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { openInBrowser, wslPowershell } from '../tui/open-browser.js'

interface Refused {
	readonly api: string
	readonly program: string
	readonly command: string
}

const refused = (): readonly Refused[] =>
	(globalThis as { __namzuRefusedDesktopLaunches?: Refused[] }).__namzuRefusedDesktopLaunches ?? []

let queryTools: ToolManager | undefined
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { toolsets: readonly Toolset[] }) => {
			queryTools = new ToolManager({ toolsets: params.toolsets, messages: () => [] })
			return (async function* () {})()
		},
	}
})

vi.mock('../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gatewayForTurn: async () => ({}) as never,
		completionInboxForTurn: async () => new (await import('@namzu/sdk')).CompletionInbox(),
		releaseTurn: async () => {},
		agentTool: {
			name: 'Agent',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
			execute: async () => ({ success: true, output: '' }),
		},
		waitForTaskTool: {
			name: 'wait_for_task',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
	}),
}))

let workDir = ''
const open: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-no-desktop-'))
	queryTools = undefined
})

afterEach(async () => {
	for (const session of open.splice(0)) await session.close()
	removeTempDir(workDir)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'claude-sonnet-4-5',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as unknown as DetectedProvider[]

describe('the CLI suite never reaches the desktop', () => {
	it('runs with cua-driver off and the launch guard installed', () => {
		expect(process.env.NAMZU_CUA_DRIVER).toBe('off')
		expect(
			Array.isArray(
				(globalThis as { __namzuRefusedDesktopLaunches?: unknown }).__namzuRefusedDesktopLaunches,
			),
		).toBe(true)
	})

	it('opens a session whose computer_use cannot click or type, with the real host', async () => {
		const before = refused().length
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detected, {
			cwd: workDir,
			enableComputerUse: true,
		})
		open.push(session)
		// On WSL the host reached for PowerShell and was refused; elsewhere it
		// found no desktop at all. Either way nothing was started, and the tool
		// is mounted only to say so.
		expect(
			refused()
				.slice(before)
				.every((entry) => entry.program === 'powershell'),
		).toBe(true)
		expect(session.toolNames()).toContain('computer_use')
		expect(session.configNotices.join('\n')).toMatch(/Computer use is unavailable on this device/)

		for await (const _ of session.send([{ role: 'user', content: 'click' } as never])) {
			// drain into the mocked kernel boundary, which keeps the registry
		}
		const tool = queryTools?.get('computer_use')
		expect(tool).toBeDefined()
		const attempts = refused().length
		for (const input of [
			{ type: 'screenshot' },
			{ type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' },
			{ type: 'type_text', text: 'rm -rf /' },
			{ type: 'key', keys: 'ENTER' },
		]) {
			const result = await tool?.execute(tool.inputSchema.parse(input), {
				sessionId: 's' as never,
				turnId: 't' as never,
				workingDirectory: workDir,
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			})
			expect(result?.success, JSON.stringify(input)).toBe(false)
		}
		// Refused by the tool itself: not even a guarded start was attempted.
		expect(refused().length).toBe(attempts)
	})

	it('cannot open a page in the real browser, even as a WSL with PowerShell', () => {
		const before = refused().length
		const powershell = wslPowershell()
		const opened = openInBrowser('https://example.com/', {
			platform: 'linux',
			env: { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop', PATH: '/usr/bin' },
			exists: (path) => path === powershell,
			readFile: () => undefined,
		})
		// The launcher "started" — its failure arrives later as an error event,
		// as for a missing xdg-open — and the start was of nothing.
		expect(opened).toBe(true)
		expect(refused().slice(before)).toEqual([
			expect.objectContaining({ api: 'spawn', program: 'powershell', command: powershell }),
		])
	})
})
