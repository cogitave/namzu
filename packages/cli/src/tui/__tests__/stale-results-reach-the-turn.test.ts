/**
 * The stale-result request reaches the kernel's compaction config.
 *
 * The idle compactor's request and the kernel's clear are each tested alone.
 * This drives the real session's `send` and reads what the turn was started
 * with, so dropping the hop in `agent.ts` fails here.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import type { SendOptions } from '../agent.js'

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

const preferences = {
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

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-stale-results-'))
})

afterEach(() => {
	removeTempDir(cwd)
})

async function sendWith(options: SendOptions | undefined): Promise<void> {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
	try {
		for await (const _event of session.send(
			[{ role: 'user', content: 'carry on', timestamp: 0 }],
			options,
		)) {
			// drain the real AgentSession boundary
		}
	} finally {
		await session.close()
	}
}

describe('the stale-result request hop', () => {
	it('puts the host request into the turn compaction config', async () => {
		await sendWith({ clearStaleToolResults: { minSavedTokens: 20_000, keepRecentToolResults: 6 } })
		const config = queryCalls[0]?.compactionConfig as Record<string, unknown> | undefined
		expect(config?.clearStaleToolResultsAtStart).toEqual({
			minSavedTokens: 20_000,
			keepRecentToolResults: 6,
		})
		// The rest of the host's compaction settings are still there.
		expect(config?.strategy).toBeDefined()
	})

	it('adds nothing when the host did not ask', async () => {
		await sendWith(undefined)
		const config = queryCalls[0]?.compactionConfig as Record<string, unknown> | undefined
		expect(config).toBeDefined()
		expect(config).not.toHaveProperty('clearStaleToolResultsAtStart')
	})
})
