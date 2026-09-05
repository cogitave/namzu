/**
 * `session.resumePaused` hands the kernel's resume this session's own run.
 *
 * The pause itself is proven elsewhere (`paused-run-reaches-session`). What
 * this pins is the half a headless caller cannot see: the run is addressed
 * under THIS session's ids, the checkpoint the pause named is the one asked
 * for, the store is the disk store the turn wrote to, and the events the
 * kernel hands a listener come back out as the same stream `send` gives —
 * ending with an error, not silence, when there was nothing to resume.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { openSessions, startConversation } from '../../integrations/sessions/store.js'

const resumeCalls: Record<string, unknown>[] = []
let resumeOutcome: unknown = { resumed: true, run: {}, state: {} }

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		resumeRun: async (params: Record<string, unknown>) => {
			resumeCalls.push(params)
			const listener = params.listener as ((event: RunEvent) => void) | undefined
			listener?.({
				type: 'text_delta',
				runId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				text: 'picked up ',
			} as unknown as RunEvent)
			listener?.({
				type: 'text_delta',
				runId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				text: 'where it left off',
			} as unknown as RunEvent)
			return resumeOutcome
		},
	}
})

const preferences = {
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

const roots: string[] = []

afterEach(() => {
	resumeCalls.length = 0
	resumeOutcome = { resumed: true, run: {}, state: {} }
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function openSession() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-resume-paused-cwd-'))
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-resume-paused-state-'))
	roots.push(cwd, stateRoot)
	const conversations = await openSessions(cwd, { stateRoot })
	const scope = {
		sessionId: await startConversation(conversations),
		topicId: conversations.topicId,
		projectId: conversations.projectId,
		tenantId: conversations.tenantId,
	}
	const { createAgentSession } = await import('../agent.js')
	return {
		session: await createAgentSession(preferences, detected, { cwd, stateRoot, scope }),
		scope,
		stateRoot,
	}
}

describe('resuming this session’s own paused run', () => {
	it('addresses the run under the session’s ids, at the checkpoint named, in the turn’s store', async () => {
		const { session, stateRoot, scope } = await openSession()
		const texts: string[] = []
		try {
			for await (const event of session.resumePaused({
				runId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
			})) {
				if (event.kind === 'delta') texts.push(event.text)
				if (event.kind === 'error') throw new Error(`unexpected error: ${event.message}`)
			}
		} finally {
			await session.close()
		}

		expect(texts.join('')).toBe('picked up where it left off')
		expect(resumeCalls).toHaveLength(1)
		const call = resumeCalls[0] as {
			scope: Record<string, string>
			checkpointId: string
			checkpointStore: { constructor: { name: string } }
			tenantId: string
			projectId: string
			sessionId: string
			topicId: string
		}
		expect(call.scope).toEqual({ ...scope, runId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8' })
		expect(call.checkpointId).toBe('f0d1dd26-fd58-4593-b904-7817c789af26')
		expect(call.tenantId).toBe(scope.tenantId)
		expect(call.projectId).toBe(scope.projectId)
		expect(call.sessionId).toBe(scope.sessionId)
		expect(call.topicId).toBe(scope.topicId)
		// The disk store, rooted where the turn's run manager roots its own:
		// the session directory's `runs/`, under the state root this session
		// was given.
		expect(call.checkpointStore.constructor.name).toBe('DiskCheckpointStore')
		expect(JSON.stringify(call.checkpointStore)).toContain(join(stateRoot, ''))
		expect(JSON.stringify(call.checkpointStore)).toMatch(/[\\/]runs"/)
	})

	it('ends with an error, not silence, when the checkpoint is not there', async () => {
		resumeOutcome = { resumed: false, reason: 'no-checkpoint' }
		const { session } = await openSession()
		const kinds: string[] = []
		let message = ''
		try {
			for await (const event of session.resumePaused({
				runId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: '7c81157d-b597-49f9-b951-772a567ecdf2',
			})) {
				kinds.push(event.kind)
				if (event.kind === 'error') message = event.message
			}
		} finally {
			await session.close()
		}

		expect(kinds.at(-1)).toBe('error')
		expect(message).toContain('7c81157d-b597-49f9-b951-772a567ecdf2')
		expect(message).toContain('3b0329bb-f60a-48dc-9552-1b386c52cfe8')
	})

	it('does not resume past a run parked on a human decision', async () => {
		resumeOutcome = { resumed: false, reason: 'awaiting-decision', pending: {}, state: {} }
		const { session } = await openSession()
		let message = ''
		try {
			for await (const event of session.resumePaused({
				runId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
			})) {
				if (event.kind === 'error') message = event.message
			}
		} finally {
			await session.close()
		}

		expect(message).toMatch(/parked on a decision/)
	})
})
