/**
 * An installed desktop host is a tool, not a line in `namzu doctor`.
 *
 * The CLI used to probe @namzu/computer-use and report it at boot, while the
 * production session registry never constructed the host or registered
 * `createComputerUseTool`. This drives the real `createAgentSession` front
 * door and observes the same registry a real query receives.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolRegistry } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

const desktop = vi.hoisted(() => ({
	failInitialize: false,
	initialize: vi.fn<() => Promise<void>>(),
	dispose: vi.fn<() => Promise<void>>(),
	execute: vi.fn(),
	getDisplayGeometry: vi.fn(),
}))

vi.mock('@namzu/computer-use', () => ({
	SubprocessComputerUseHost: class {
		readonly id = 'test-desktop'
		readonly capabilities = {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: true,
		}

		async initialize() {
			await desktop.initialize()
			if (desktop.failInitialize) throw new Error('desktop bridge unavailable')
		}

		dispose = desktop.dispose
		execute = desktop.execute
		getDisplayGeometry = desktop.getDisplayGeometry
	},
}))

let queryToolNames: readonly string[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { tools: ToolRegistry }) => {
			queryToolNames = params.tools.getCallableTools().map((tool) => tool.name)
			return (async function* () {})()
		},
	}
})

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gateway: {} as unknown,
		agentTool: {
			name: 'Agent',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
	}),
}))

let workDir = ''
const open: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-computer-use-'))
	queryToolNames = []
	desktop.failInitialize = false
	desktop.initialize.mockReset().mockResolvedValue(undefined)
	desktop.dispose.mockReset().mockResolvedValue(undefined)
	desktop.execute.mockReset()
	desktop.getDisplayGeometry.mockReset()
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

async function createSession(enableComputerUse = false) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detected, { cwd: workDir, enableComputerUse })
	open.push(session)
	return session
}

describe('computer use session reachability', () => {
	it('mounts the initialized host into the registry used by a real send and owns its cleanup', async () => {
		const session = await createSession(true)

		expect(desktop.initialize).toHaveBeenCalledTimes(1)
		expect(session.toolNames()).toContain('computer_use')
		expect(session.promptExemptTools()).not.toContain('computer_use')

		for await (const _ of session.send([{ role: 'user', content: 'see the desktop' } as never])) {
			// drain the real session adapter into the mocked kernel boundary
		}

		expect(queryToolNames).toContain('computer_use')
		await session.close()
		expect(desktop.dispose).toHaveBeenCalledTimes(1)
	})

	it('withholds an adapter that cannot initialize and tells the operator why', async () => {
		desktop.failInitialize = true
		const session = await createSession(true)

		expect(session.toolNames()).not.toContain('computer_use')
		expect(session.configNotices).toContain(
			'Computer use is unavailable on this device: desktop bridge unavailable',
		)
		expect(desktop.dispose).toHaveBeenCalledTimes(1)
	})

	it('does not expose host input to a surface that did not claim an interactive permission owner', async () => {
		const session = await createSession()

		expect(desktop.initialize).not.toHaveBeenCalled()
		expect(session.toolNames()).not.toContain('computer_use')
	})
})
