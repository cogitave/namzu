/**
 * A run id reserved before the TUI writes its turn binding reaches `query()`.
 * Removing this one spread leaves a perfectly valid ledger pointing at a run
 * directory the SDK never creates, so unit tests on either side are not enough.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateRunId } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
	cwd = mkdtempSync(join(tmpdir(), 'namzu-reserved-run-id-'))
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

it('passes the caller-reserved identity to the production query invocation', async () => {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detected, { cwd })
	const runId = generateRunId()

	for await (const _event of session.send([{ role: 'user', content: 'hi', timestamp: 0 }], {
		runId,
	})) {
		// drain
	}

	expect(queryCalls).toHaveLength(1)
	expect(queryCalls[0]?.runId).toBe(runId)
})
