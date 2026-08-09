/**
 * The `--gate` reviewer is in the request that is actually sent.
 *
 * The flag test one directory over stops at `createAgentSession`, which it
 * mocks — so it proves the command builds a gate and hands it over, and
 * nothing about whether the session passes it on. That last hop is a
 * one-line spread inside a 1700-line file, and deleting it is silent: the
 * flag parses, the gate is constructed, the run settles on a red build, and
 * there is nothing anywhere to read that says why.
 *
 * Measured: with only the flag test, removing that spread left the suite
 * green. So this ends at the `reviewAnswer` `query()` was called with.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-gate-turn-'))
	mkdirSync(cwd, { recursive: true })
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(cwd)
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

async function drive(
	options: { reviewAnswer?: unknown; maxAnswerReviews?: number } = {},
): Promise<Record<string, unknown>> {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd,
		...(options as Record<string, never>),
	})
	for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	return queryCalls[0] as Record<string, unknown>
}

describe('a gate supplied to the session', () => {
	it('is the reviewer the turn is run with', async () => {
		const reviewAnswer = vi.fn(async () => ({ accept: true as const }))

		const params = await drive({ reviewAnswer, maxAnswerReviews: 2 })

		// The kernel consults exactly this function when the model stops
		// calling tools. Deleting the spread in `createAgentSession` leaves
		// every gate constructed, configured and never asked.
		expect(params.reviewAnswer).toBe(reviewAnswer)
		expect(params.maxAnswerReviews).toBe(2)
	})

	it('leaves a turn without one exactly as it was', async () => {
		const params = await drive()

		// Absent, not present-and-undefined. The kernel branches on presence,
		// and a run with no gate must be byte-identical to one from before
		// gates existed.
		expect('reviewAnswer' in params).toBe(false)
		expect('maxAnswerReviews' in params).toBe(false)
	})
})
