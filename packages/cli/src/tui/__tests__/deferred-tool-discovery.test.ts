/**
 * The CLI's ordinary tools are active. Let query() add search_tools only when
 * runtime registration supplies a deferred roster. Plugin discovery is also
 * exercised through the real query loop in plugin-runtime-reaches-session.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import type { ToolRegistryContract } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: () => (async function* () {})(),
	}
})

// The sub-agent's registry is built by a callback the session hands to this
// factory, so capturing the callback is the only way to see what a sub-agent
// would actually get — and it is the real wiring, not a re-derivation of it.
let capturedBuildTools: (() => ToolRegistryContract) | null = null
vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async (opts: { buildTools: () => ToolRegistryContract }) => {
		capturedBuildTools = opts.buildTools
		return {
			gatewayForRun: async () => ({}) as never,
			completionInboxForRun: async () => new (await import('@namzu/sdk')).CompletionInbox(),
			releaseRun: async () => {},
			agentTool: {
				name: 'Agent',
				description: 'stub',
				inputSchema: { type: 'object', properties: {} },
				execute: async () => ({ success: true, output: '' }),
			},
			waitForTaskTool: {
				name: 'wait_for_task',
				description: 'stub',
				inputSchema: { type: 'object', properties: {} },
				execute: async () => ({ success: true, output: '' }),
			},
			allowedAgentIds: [],
		}
	},
}))

let workDir: string

beforeEach(() => {
	capturedBuildTools = null
	workDir = mkdtempSync(join(tmpdir(), 'namzu-deferred-'))
})

afterEach(() => {
	removeTempDir(workDir)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
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
}

describe('search_tools is mounted only where a deferred roster exists', () => {
	it('withholds an empty search from both the session and sub-agents', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { cwd: workDir })
		expect(session.hasProvider).toBe(true)

		expect(session.toolNames()).not.toContain('search_tools')

		expect(
			capturedBuildTools,
			'the session must hand the sub-agent factory a tool builder',
		).not.toBeNull()
		const subagentTools = (capturedBuildTools as unknown as () => ToolRegistryContract)()
		const subagentNames = subagentTools.listNames()

		// The whole point: same builder, and this side must NOT have it.
		expect(subagentNames).not.toContain('search_tools')

		// And the sub-agent is not stripped of everything else in the process —
		// an assertion that would still hold if `buildTools` returned an empty
		// registry, which would "pass" the line above for the wrong reason.
		expect(subagentNames).toContain('bash')
		expect(subagentNames).toContain('read')
	})

	it('leaves the sub-agent nothing deferred, which is why the tool is withheld', async () => {
		const { createAgentSession } = await import('../agent.js')
		await createAgentSession(prefs, detectedAnthropic(), { cwd: workDir })
		const subagentTools = (capturedBuildTools as unknown as () => ToolRegistryContract)()

		const deferred = subagentTools
			.listNames()
			.filter((n) => subagentTools.getAvailability(n) === 'deferred')
		expect(deferred).toEqual([])
	})
})
