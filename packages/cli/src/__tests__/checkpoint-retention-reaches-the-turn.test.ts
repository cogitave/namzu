/**
 * Every run the CLI starts bounds how many checkpoints it keeps.
 *
 * The kernel keeps every checkpoint unless the host says otherwise, a run
 * takes one per iteration plus one per tool review, and nothing in the CLI
 * set `pruneKeepLast` — so a long session kept all of them. On one machine
 * that was 19,014 checkpoint files. What is asserted is the value the kernel
 * is handed, because that is the only thing that decides what it deletes.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../integrations/providers/index.js'
import { CLI_CHECKPOINT_RETENTION } from '../integrations/state/retention.js'

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
	cwd = mkdtempSync(join(tmpdir(), 'namzu-retention-'))
})
afterEach(() => {
	removeTempDir(cwd)
})

const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['anthropic'],
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

it('hands the kernel a checkpoint retention on every turn', async () => {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(
		{ version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } } as Preferences,
		detected,
		{ cwd, sandbox: { enabled: false } },
	)
	try {
		for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
			// drain
		}
	} finally {
		await session.close()
	}
	const runConfig = queryCalls[0]?.runConfig as { pruneKeepLast?: number } | undefined
	expect(runConfig?.pruneKeepLast).toBe(CLI_CHECKPOINT_RETENTION)
	expect(CLI_CHECKPOINT_RETENTION).toBeGreaterThanOrEqual(1)
})
