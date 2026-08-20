/**
 * The operator's sandbox teardown bound reaches both live turns and durable
 * resumes. Config parsing and kernel tests sit on either side of this seam;
 * neither notices when the CLI quietly drops the value between them.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
const resumeCalls: Record<string, unknown>[] = []
const subagentOptions: Record<string, unknown>[] = []

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {
				yield* [] as never[]
				return { messages: [] }
			})()
		},
		resumeRun: async (params: Record<string, unknown>) => {
			resumeCalls.push(params)
			return { status: 'completed', messages: [] }
		},
	}
})

vi.mock('../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async (options: Record<string, unknown>) => {
		subagentOptions.push(options)
		return {
			gateway: {} as never,
			agentTool: {
				name: 'Agent',
				description: 'stub',
				inputSchema: { type: 'object', properties: {} },
				execute: async () => ({ success: true, output: '' }),
			},
			allowedAgentIds: [],
		}
	},
}))

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	resumeCalls.length = 0
	subagentOptions.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-sandbox-teardown-reach-'))
})

afterEach(() => {
	removeTempDir(cwd)
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
		source: 'env',
		apiKey: 'sk-ant-not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

it('passes sandbox.teardownTimeoutMs to live and resumed kernel runs', async () => {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detected, {
		cwd,
		sandbox: { teardownTimeoutMs: 37 },
	})

	for await (const _event of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	await session.resumeDurable({
		entry: { tenantId: 't', projectId: 'p', sessionId: 's' } as never,
		checkpointStore: {} as never,
	})

	expect(queryCalls).toHaveLength(1)
	expect(queryCalls[0]?.sandboxTeardownTimeoutMs).toBe(37)
	expect(queryCalls[0]?.sandboxProvider).toBeDefined()
	expect(resumeCalls).toHaveLength(1)
	expect(resumeCalls[0]?.sandboxTeardownTimeoutMs).toBe(37)
	expect(resumeCalls[0]?.sandboxProvider).toBe(queryCalls[0]?.sandboxProvider)
	expect(subagentOptions).toHaveLength(1)
	expect(subagentOptions[0]?.sandboxTeardownTimeoutMs).toBe(37)
	expect(subagentOptions[0]?.sandboxProvider).toBe(queryCalls[0]?.sandboxProvider)
})
