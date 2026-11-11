import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	closeSessions,
	openSessions,
	readConversationFacts,
} from '../../integrations/sessions/store.js'
import { readProviderRetryStatus } from '../acp-provider-retry.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { interruptedAtStart } from './support/interrupted-at-start.js'

let root: string
let state: Awaited<ReturnType<typeof openSessions>>
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-interrupted-start-'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	state = await openSessions(root, { stateRoot: join(root, 'state') })
})
afterEach(() => {
	closeSessions(state)
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function runtime(createSession?: unknown) {
	return createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{
			probe: async () => ({
				preferences: {
					version: 3,
					providers: [{ id: 'zen', model: 'original-model' }],
					subagents: { active: [] },
				},
				detected: [],
				needsRepickReason: null,
			}),
			...(createSession ? { createSession } : {}),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async (sessionId: string) => ({ sessionId: asSessionId(sessionId) }),
			openSessions: (cwd: string) => openSessions(cwd, { stateRoot: join(root, 'state') }),
		} as unknown as AcpRuntimeDependencies,
	)
}

describe('a reply whose host went away in its first instant', () => {
	it('is a turn no live host owns, which the durable status alone cannot tell from one that is running', async () => {
		const f = await interruptedAtStart(state)
		expect((await f.log.activeTurn())?.state).toBe('interrupted')
		// The status is a read: it names the wait and changes nothing.
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			notice: 'Wait for this conversation’s active turn to settle.',
		})
		expect((await f.log.activeTurn())?.state).toBe('interrupted')
	})

	it('is settled as stopped when the next host asks whether the conversation can go on', async () => {
		const f = await interruptedAtStart(state)
		const host = runtime()
		try {
			// The Desktop asks this before every message, and a refusal here is what the person reads.
			expect(await host.providerRetryStatus?.(f.sessionId, root)).toEqual({})
			expect(await f.log.activeTurn()).toBeNull()
			const facts = await readConversationFacts(state, f.sessionId)
			expect(facts?.activeTurn).toBeUndefined()
			const records = (await f.log.readAll()).entries.map((entry) => entry.record)
			const closing = records.find((record) => record.type === 'turn_failed')
			expect(closing).toMatchObject({ turnId: f.turnId })
			// The person's message stays in the conversation: it was sent, and it is not taken back.
			expect(records.some((record) => record.type === 'message' && record.role === 'user')).toBe(
				true,
			)
		} finally {
			await host.close()
		}
	})

	it('is closed by a message sent to a host that never asked, instead of refusing it', async () => {
		const f = await interruptedAtStart(state)
		const send = vi.fn((_messages: unknown, _options: unknown) =>
			(async function* () {
				yield { kind: 'done', stopReason: 'end_turn' } as const
			})(),
		)
		const host = runtime(
			vi.fn(async () => ({
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				close: async () => {},
				send,
				reasoningEffortLevels: [],
				reasoningEffortDefault: undefined,
				presenter: {
					presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
					presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
				},
			})),
		)
		try {
			await host.gateway.prompt({
				sessionId: f.sessionId,
				cwd: root,
				signal: new AbortController().signal,
				onEvent: () => {},
				ask: async () => ({ kind: 'reject' as const }),
				history: [],
				filesystem: undefined,
				prompt: 'Carry on',
			})
			// The kernel closes it when it begins the turn; the host's part is to ask for that.
			expect(send.mock.calls[0]?.[1]).toMatchObject({ abandonInterrupted: true })
		} finally {
			await host.close()
		}
	})

	it('keeps the refusal while another host still holds the conversation', async () => {
		const f = await interruptedAtStart(state, { stillHeld: true })
		const host = runtime()
		try {
			const status = await host.providerRetryStatus?.(f.sessionId, root)
			expect(status?.notice).toContain('active turn to settle')
			expect((await f.log.activeTurn())?.state).toBe('running')
		} finally {
			await f.log.release(f.lease)
			await host.close()
		}
	})
})
