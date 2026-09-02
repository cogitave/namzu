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

import type { LLMToolSchema, ToolRegistry } from '@namzu/sdk'

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
let queryTools: readonly LLMToolSchema[] = []
let enforcedToolNames: readonly string[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { tools: ToolRegistry }) => {
			queryTools = params.tools.toLLMTools()
			queryToolNames = queryTools.map((tool) => tool.function.name)
			enforcedToolNames = params.tools
				.getCallableTools()
				.filter((tool) => tool.enforceModelInput === true)
				.map((tool) => tool.name)
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
			modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
	queryTools = []
	enforcedToolNames = []
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

		expect(queryToolNames).toEqual([
			'bash',
			'edit',
			'glob',
			'grep',
			'read',
			'write',
			'search_memory',
			'read_memory',
			'save_memory',
			'computer_use',
			'search_tools',
			'Agent',
		])
		const computerUse = queryTools[9]?.function.parameters
		expect(computerUse).toMatchObject({
			type: 'object',
			required: ['type'],
			additionalProperties: false,
		})
		expect(computerUse).not.toHaveProperty('anyOf')
		expect(computerUse).not.toHaveProperty('oneOf')
		expect(computerUse).not.toHaveProperty('allOf')
		expect(enforcedToolNames).not.toContain('computer_use')
		await session.close()
		expect(desktop.dispose).toHaveBeenCalledTimes(1)
	})

	it('keeps an adapter that cannot initialize on the roster, unavailable, and says why to both', async () => {
		// The tool stays: a tool that is absent is one the model reasons about
		// from the wrong premise, while one that says "this desktop did not
		// answer, and why" is a result it reads once. The operator is told the
		// same thing in the notices.
		desktop.failInitialize = true
		const session = await createSession(true)

		// What the tool says about itself is the kernel's and pinned there
		// (`tools/builtins/__tests__/computer-use.test.ts`); this proves it is
		// on the roster at all.
		expect(session.toolNames()).toContain('computer_use')
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
