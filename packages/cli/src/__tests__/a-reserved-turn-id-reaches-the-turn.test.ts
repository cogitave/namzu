/**
 * A turn id reserved before the turn begins reaches `query()`, and so does why
 * the turn exists. Everything that authorizes the turn — its review channel,
 * its delegation gateway, a goal round's authority — is keyed by that id, so a
 * turn the kernel began under a different one would hold none of them.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateTurnId } from '@namzu/sdk'
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
	cwd = mkdtempSync(join(tmpdir(), 'namzu-reserved-turn-id-'))
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

it('passes the caller-reserved identity and origin to the production query invocation', async () => {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detected, { cwd })
	const turnId = generateTurnId()

	for await (const _event of session.send([{ role: 'user', content: 'hi', timestamp: 0 }], {
		turnId,
		origin: { protocol: 'cli', kind: 'goal-round' },
	})) {
		// drain
	}

	expect(queryCalls).toHaveLength(1)
	expect(queryCalls[0]?.turnId).toBe(turnId)
	expect(queryCalls[0]?.origin).toEqual({ protocol: 'cli', kind: 'goal-round' })
	await session.close()
})

it('reserves a turn id for a send that names none', async () => {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detected, { cwd })

	for await (const _event of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}

	expect(typeof queryCalls[0]?.turnId).toBe('string')
	await session.close()
})
