/**
 * Every turn the CLI starts bounds how many checkpoints it keeps.
 *
 * The kernel keeps every checkpoint unless the host says otherwise, a turn
 * takes one per iteration plus one per tool review, and nothing in the CLI
 * set `pruneKeepLast` — so a long session kept all of them. On one machine
 * that was 19,014 checkpoint files. What is asserted is the value the kernel
 * is handed, because that is the only thing that decides what it deletes.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asTurnId, generateMessageId } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../integrations/providers/index.js'
import {
	openConversationLog,
	openSessions,
	startConversation,
} from '../integrations/sessions/store.js'
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
		resumeSession: async (params: Record<string, unknown>) => {
			resumeCalls.push(params)
			return { resumed: true, turn: {}, state: {} }
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
	const turnConfig = queryCalls[0]?.turnConfig as { pruneKeepLast?: number } | undefined
	expect(turnConfig?.pruneKeepLast).toBe(CLI_CHECKPOINT_RETENTION)
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
	return { session, scope, stateRoot, conversations }
}

const extraRoots: string[] = []
afterEach(() => {
	for (const root of extraRoots.splice(0)) removeTempDir(root)
})

it('hands the kernel the same retention, and the turn’s own limits, when it resumes a turn', async () => {
	const { session, scope, conversations } = await openScopedSession()
	const turnId = asTurnId('3b0329bb-f60a-48dc-9552-1b386c52cfe8')
	// The turn as its `turn_started` recorded it, limits included.
	const log = openConversationLog(conversations, scope.sessionId)
	const lease = await log.claim({ holder: 'test-retention', ttlMs: 10_000 })
	if (!lease) throw new Error('fixture could not lease the log')
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'test-model', tokenBudget: 12000, maxIterations: 7, timeoutMs: 120000 },
	})
	await log.release(lease)
	try {
		for await (const event of session.resumePaused({
			turnId,
			checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
		})) {
			if (event.kind === 'error') throw new Error(event.message)
		}
	} finally {
		await session.close()
	}
	const turnConfig = resumeCalls[0]?.turnConfig as
		| { pruneKeepLast?: number; maxIterations?: number; tokenBudget?: number }
		| undefined
	expect(turnConfig?.pruneKeepLast).toBe(CLI_CHECKPOINT_RETENTION)
	expect(turnConfig).toMatchObject({ maxIterations: 7, tokenBudget: 12000 })
	expect(resumeCalls[0]?.scope).toMatchObject({ sessionId: scope.sessionId, turnId })
})
