/**
 * `search_tools` is mounted where there is something to find, and not where
 * there is not.
 *
 * The two registries come from the same builder, so "does the CLI register
 * search_tools" has one answer from one call site and a different correct
 * answer from the other — the shape that hides behind a green suite. The
 * session passes a `taskStore`, so `query()` registers the task tools deferred
 * and the search has a roster of three. A sub-agent is built with no task
 * store, so nothing in its registry is deferred and the tool could only ever
 * answer "no deferred tools matching X" — a capability advertised every turn
 * that costs a turn to discover it is unusable.
 *
 * Removing the peer-daemon catalog is what created the asymmetry: that catalog
 * used to supply BOTH registries, so both were justified in mounting the tool.
 * Only one lost its supplier, and from the side that still works the loss is
 * invisible.
 *
 * So this asserts the CONTRAST, not either half: a test that only checked the
 * session would pass with the tool wrongly mounted on the sub-agent, which is
 * exactly the state this file was written against.
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
			gateway: {} as unknown,
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
	it('the session offers it and a sub-agent does not', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { cwd: workDir })
		expect(session.hasProvider).toBe(true)

		// The session mounts the search itself: a tool server or plugin can
		// register a deferred roster, and the search is how the model reaches
		// it. (The task tools were once the standing example; the interactive
		// session now registers those `active` — see the query call in
		// agent.ts — so they are no longer what this search is for.)
		expect(session.toolNames()).toContain('search_tools')

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
