/**
 * `/tools` and `/permissions` answer from the same roster, at the same moment.
 *
 * Before toolsets (plan.md v3 §2), `query()` mutated the caller's own
 * `ToolRegistry` in place to add the task tools, so a session's roster could
 * grow mid-turn — and `toolNames` once stayed a captured array while
 * `promptExemptTools` read the registry live, so the two commands could
 * describe different sets of tools with nothing to say which was current.
 *
 * Under toolsets, `query()` never mutates what it is handed: its own
 * generated tools (task tools, `search_tools`, advisory tools) live in a
 * `runtime` toolset internal to that one turn's `ToolManager`, never folded
 * back into the session's own `manager` — so a session's roster is now fixed
 * at boot and CANNOT grow mid-turn the way it once did. What still matters,
 * and still needs a name so it cannot regress silently, is that `toolNames`
 * and `promptExemptTools` are two readings of the exact same manager: a tool
 * named as never-prompted must always appear in `/tools` too.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

/** A read-only extra tool, mounted the way a host adds one — at session boot. */
const EXTRA_TOOL = {
	name: 'extra_reader',
	description: 'a host-supplied read-only tool',
	inputSchema: {
		safeParse: (value: unknown) => ({ success: true, data: value }),
	} as never,
	// Declared read-only, so `/permissions` will name it too. That is what makes
	// the two commands comparable: one roster, two readings of it.
	isReadOnly: () => true,
	execute: async () => ({ success: true, output: '' }),
}

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gatewayForTurn: async () => ({}) as never,
		completionInboxForTurn: async () => new (await import('@namzu/sdk')).CompletionInbox(),
		releaseTurn: async () => {},
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
	}),
}))

let workDir: string

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-roster-'))
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

describe('the roster a session reports', () => {
	it('is complete the moment the session is built, with no turn needed', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: workDir,
			extraTools: [EXTRA_TOOL],
		})
		expect(session.hasProvider).toBe(true)

		// No turn ran, and the tool is already there: the session's own
		// `toolsets` are fixed at boot, not filled in by a first send.
		expect(session.toolNames()).toContain('extra_reader')
	})

	it('is the same roster the exempt list is read from', async () => {
		// `/permissions` naming a tool as never-prompted, and `/tools` not
		// listing that tool at all, is not a small inconsistency: `/permissions`
		// exists to tell an operator what runs without asking, and a name they
		// cannot find in `/tools` reads as a tool namzu invented.
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: workDir,
			extraTools: [EXTRA_TOOL],
		})

		const listed = session.toolNames()
		for (const exempt of session.promptExemptTools()) {
			expect(listed, `/permissions names "${exempt}" and /tools does not list it`).toContain(exempt)
		}
		// And the extra tool is in both, so the loop above is not vacuous.
		expect(session.promptExemptTools()).toContain('extra_reader')
	})
})
