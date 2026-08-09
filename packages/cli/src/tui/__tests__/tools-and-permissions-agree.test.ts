/**
 * `/tools` and `/permissions` answer from the same roster, at the same moment.
 *
 * The kernel registers some tools DEFERRED, inside the first `query()` — the
 * task tools are the ones that exist today — so a session's roster is not final
 * when the session is built. `promptExemptTools` was made a function for exactly
 * that reason, and its docstring in `agent.ts` says so in as many words.
 *
 * `toolNames` sat one field above it and stayed a captured array. So the command
 * whose entire job is to answer "what can this agent call" answered from a list
 * taken before some of them existed, while the command two along read the
 * registry live. On the same screen, with nothing to indicate a difference:
 * `/permissions` naming a tool as never-prompted, and `/tools` not listing that
 * tool at all.
 *
 * This asserts the CONTRAST rather than either half, per
 * `docs/conventions/one-site-is-not-every-site.md`: a test that only checked
 * `/tools` against a session built in a test would pass, because in a test
 * nothing registers late unless the test makes it. So the test makes it — the
 * mocked `query` registers into the same registry object the real one is handed,
 * which is the actual mechanism and not a re-enactment of it.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolRegistry } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

/** A tool that appears only once a turn has started, as the task tools do. */
const DEFERRED_TOOL = {
	name: 'late_arrival',
	description: 'registered during the turn, not before it',
	inputSchema: { type: 'object' as const, properties: {} },
	// Declared read-only, so `/permissions` will name it too. That is what makes
	// the two commands comparable: one roster, two readings of it.
	isReadOnly: () => true,
	execute: async () => ({ success: true, output: '' }),
}

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		// The real `query` registers the task tools into the registry it is
		// handed. This does the same thing with one tool of its own, so the
		// session under test experiences a late registration through the real
		// wiring rather than through a poke at its internals.
		query: (args: { tools: ToolRegistry }) => {
			args.tools.register([DEFERRED_TOOL as never])
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
	it('grows when a turn registers a tool, rather than staying as it was built', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { cwd: workDir })
		expect(session.hasProvider).toBe(true)

		expect(session.toolNames(), 'a tool existed before its turn ran').not.toContain('late_arrival')

		// Run a turn. The mocked query registers into the session's registry, as
		// the real one does for the task tools.
		for await (const _ of session.send([{ role: 'user', content: 'go' } as never])) {
			// drain
		}

		expect(session.toolNames(), 'the roster was captured when the session was built').toContain(
			'late_arrival',
		)
	})

	it('is the same roster the exempt list is read from', async () => {
		// The contrast. `promptExemptTools` has always read the registry live;
		// the defect was that `toolNames` did not, so the two commands could
		// describe different sets of tools with nothing to say which was current.
		//
		// A tool named as never-prompted but absent from the tool list is not a
		// small inconsistency: `/permissions` exists to tell an operator what
		// runs without asking, and a name they cannot find in `/tools` reads as
		// a tool namzu invented.
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { cwd: workDir })

		for await (const _ of session.send([{ role: 'user', content: 'go' } as never])) {
			// drain
		}

		const listed = session.toolNames()
		for (const exempt of session.promptExemptTools()) {
			expect(listed, `/permissions names "${exempt}" and /tools does not list it`).toContain(exempt)
		}
		// And the deferred one is in both, so the loop above is not vacuous.
		expect(session.promptExemptTools()).toContain('late_arrival')
	})
})
