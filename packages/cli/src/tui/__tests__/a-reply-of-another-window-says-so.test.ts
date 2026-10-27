/**
 * A message sent while another window's reply holds the conversation is
 * refused with that window's name for it, not with advice that only fits a
 * reply of this window.
 *
 * Only `query()` is replaced, and only to refuse the turn the way the kernel
 * does once a lease it cannot take is live; the lease itself is claimed on the
 * real session log the session passes in, and the refusal travels through the
 * production event bridge to the words the person reads.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, SessionId, TurnId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { describePlainInterruption } from '../plain-interruption.js'

const holder = { name: 'namzu:999999:turn-a' }

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: {
			readonly messages: readonly Message[]
			readonly sessionId: SessionId
			readonly paths: ConstructorParameters<typeof actual.DiskSessionLog>[0]
			readonly sessionLog?: InstanceType<typeof actual.DiskSessionLog>
		}) =>
			(async function* () {
				yield* [] // a generator that refuses before its first event
				const log =
					params.sessionLog ??
					actual.DiskSessionLog.at(params.paths as never, { sessionId: params.sessionId })
				await log.claim({ holder: holder.name, ttlMs: 270_000 })
				throw new actual.TurnInProgressError({
					sessionId: params.sessionId,
					activeTurnId: 'dcc4e6b8-5dbe-453f-a4e4-61e076a09185' as TurnId,
					state: 'running',
				})
			})(),
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
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function refusal() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-in-use-'))
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-in-use-state-'))
	roots.push(cwd, stateRoot)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, { cwd, stateRoot })
	const events = []
	try {
		for await (const event of session.send([{ role: 'user', content: 'go', timestamp: 1 }])) {
			events.push(event)
		}
	} finally {
		await session.close()
	}
	return events
}

describe('a conversation held by a reply that is not this window’s', () => {
	it('says the conversation is in use elsewhere and when it is free, with no advice to press Esc', async () => {
		holder.name = 'namzu:999999:turn-a'
		const [event] = await refusal()

		expect(event).toMatchObject({
			kind: 'error',
			turnInProgress: { state: 'running', freeInMinutes: 5 },
		})
		const text = describePlainInterruption(event as never)
		expect(text).toBe(
			'This conversation is in use by another window. It is available again in about 5 minutes.',
		)
		expect(text).not.toMatch(/Esc/)
	})

	it('keeps the advice to stop it for a reply of this process', async () => {
		holder.name = `namzu:${process.pid}:turn-a`
		const [event] = await refusal()

		expect(event).toMatchObject({ kind: 'error', turnInProgress: { state: 'running' } })
		expect((event as { turnInProgress: object }).turnInProgress).not.toHaveProperty('freeInMinutes')
		expect(describePlainInterruption(event as never)).toMatch(/press Esc to stop it/)
	})
})
