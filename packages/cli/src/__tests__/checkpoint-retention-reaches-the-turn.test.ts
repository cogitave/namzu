/**
 * Every run the CLI starts bounds how many checkpoints it keeps.
 *
 * The kernel keeps every checkpoint unless the host says otherwise, a run
 * takes one per iteration plus one per tool review, and nothing in the CLI
 * set `pruneKeepLast` — so a long session kept all of them. On one machine
 * that was 19,014 checkpoint files. What is asserted is the value the kernel
 * is handed, because that is the only thing that decides what it deletes.
 */

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asRunId } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../integrations/providers/index.js'
import { CliPathBuilder } from '../integrations/sessions/paths.js'
import { openSessions, startConversation } from '../integrations/sessions/store.js'
import { CLI_CHECKPOINT_RETENTION } from '../integrations/state/retention.js'

const queryCalls: Record<string, unknown>[] = []
const resumeCalls: Record<string, unknown>[] = []
let turnOutcome: unknown
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			// biome-ignore lint/correctness/useYield: a turn that settles without events.
			return (async function* () {
				return turnOutcome
			})()
		},
		resumeRun: async (params: Record<string, unknown>) => {
			resumeCalls.push(params)
			return { resumed: true, run: {}, state: {} }
		},
	}
})

let cwd: string
beforeEach(() => {
	queryCalls.length = 0
	resumeCalls.length = 0
	turnOutcome = undefined
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

async function openScopedSession() {
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-retention-state-'))
	extraRoots.push(stateRoot)
	const conversations = await openSessions(cwd, { stateRoot })
	const scope = {
		sessionId: await startConversation(conversations),
		topicId: conversations.topicId,
		projectId: conversations.projectId,
		tenantId: conversations.tenantId,
	}
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(
		{
			version: 3,
			providers: [{ id: 'anthropic' }],
			subagents: { active: [] },
		} as Preferences,
		detected,
		{ cwd, stateRoot, scope, sandbox: { enabled: false } },
	)
	return { session, scope, stateRoot }
}

const extraRoots: string[] = []
afterEach(() => {
	for (const root of extraRoots.splice(0)) removeTempDir(root)
})

it('hands the kernel the same retention when it resumes a run', async () => {
	const { session, scope, stateRoot } = await openScopedSession()
	const runId = asRunId('3b0329bb-f60a-48dc-9552-1b386c52cfe8')
	const dir = new CliPathBuilder(stateRoot).runDir(scope.projectId, scope.sessionId, runId)
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'run.json'),
		JSON.stringify({
			schemaVersion: 1,
			id: runId,
			metadata: {
				scope: { ...scope, runId },
				config: { tokenBudget: 12000, maxIterations: 7, timeoutMs: 120000 },
			},
		}),
	)
	try {
		for await (const event of session.resumePaused({
			runId,
			checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
		})) {
			if (event.kind === 'error') throw new Error(event.message)
		}
	} finally {
		await session.close()
	}
	const runConfig = resumeCalls[0]?.runConfig as { pruneKeepLast?: number } | undefined
	expect(runConfig?.pruneKeepLast).toBe(CLI_CHECKPOINT_RETENTION)
})

/**
 * The CLI continues a conversation under a new run id, so the kernel's own
 * cleanup (same run id completes) never reaches the dump an interrupted turn
 * left. A later turn in the session completing is what outlives it.
 */
it('removes the crash dumps a completed turn has outlived, and only those', async () => {
	const { session, scope, stateRoot } = await openScopedSession()
	const emergency = join(
		new CliPathBuilder(stateRoot).sessionDir(scope.projectId, scope.sessionId),
		'runs',
		'emergency',
	)
	mkdirSync(emergency, { recursive: true })
	const old = join(emergency, 'a2f1b9f0-3c55-4d4c-9d59-000000000001.json')
	writeFileSync(old, '{}')
	const past = new Date(Date.now() - 60_000)
	utimesSync(old, past, past)
	try {
		turnOutcome = { status: 'failed', messages: [] }
		for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
			// drain
		}
		expect(existsSync(old)).toBe(true)

		turnOutcome = { status: 'completed', messages: [] }
		for await (const _ of session.send([{ role: 'user', content: 'again', timestamp: 0 }])) {
			// drain
		}
		expect(existsSync(old)).toBe(false)
	} finally {
		await session.close()
	}
})
