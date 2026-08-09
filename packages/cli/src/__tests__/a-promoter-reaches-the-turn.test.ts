/**
 * What the run learned reaches the store the next run reads from.
 *
 * `promoteMemory` is invoked once at settle with the compaction pass's
 * structured output, and **no shipped app supplied the hook** — so every
 * decision, discovery and stated requirement a run extracted was serialized
 * into one system message and dropped when the run ended. The promoter's own
 * unit tests prove what it writes; they prove nothing about whether anybody
 * asks it, and the hop from `createAgentSession` to `query()` is one line.
 *
 * So this ends at the `promoteMemory` `query()` was called with, and then
 * drives that function against the session's real memory store — because a
 * promoter wired to a DIFFERENT store than `search_memory` reads would pass
 * every reachability check and still lose the memory.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DiskMemoryStore } from '@namzu/sdk'
import type { RunMemoryCandidate } from '@namzu/sdk'
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
	cwd = mkdtempSync(join(tmpdir(), 'namzu-promote-turn-'))
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

function candidate(over: Partial<RunMemoryCandidate> = {}): RunMemoryCandidate {
	return {
		runId: 'run_cli' as RunMemoryCandidate['runId'],
		task: 'wire the invoice job',
		decisions: [],
		discoveries: [],
		userRequirements: [],
		failures: [],
		environment: [],
		files: [],
		evicted: {},
		...over,
	}
}

async function drive(): Promise<(c: RunMemoryCandidate) => void | Promise<void>> {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), { cwd })
	for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	const promoteMemory = queryCalls[0]?.promoteMemory
	// Deleting the line that hands it over leaves every run's extracted
	// knowledge on the floor at settle — silently, because a run that
	// remembers nothing looks exactly like a run that learned nothing.
	expect(typeof promoteMemory).toBe('function')
	return promoteMemory as (c: RunMemoryCandidate) => void | Promise<void>
}

describe('the run memory promoter', () => {
	it('is handed to every turn', async () => {
		await drive()
	})

	it('writes into the SAME store `search_memory` reads', async () => {
		const promote = await drive()

		await promote(candidate({ userRequirements: ['never email an invoice twice'] }))

		// Built the way the session builds it, at the path the memory tools
		// use. A promoter wired to a different directory would satisfy the
		// test above and lose the memory anyway — the model would search one
		// store while the runtime wrote to another.
		const store = new DiskMemoryStore({ baseDir: join(cwd, '.namzu') })
		const page = await store.list()
		expect(page.totalCount).toBe(1)
		expect(page.entries[0]?.title).toContain('invoice')
	})

	it('leaves the store empty for a run that learned nothing', async () => {
		const promote = await drive()

		await promote(candidate({ files: ['src/a.ts'] }))

		const store = new DiskMemoryStore({ baseDir: join(cwd, '.namzu') })
		// Emptiness, not "the write succeeded". The model reads this store on
		// later runs, so a record per run is context spent on runs that found
		// nothing.
		expect((await store.list()).totalCount).toBe(0)
	})
})
