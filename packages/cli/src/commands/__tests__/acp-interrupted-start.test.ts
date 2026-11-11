import { spawn } from 'node:child_process'
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
import { holderIsGone, readProviderRetryStatus } from '../acp-provider-retry.js'
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

/** A process id that belonged to a process that has exited: awaited, not slept for. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
	const pid = child.pid
	if (pid === undefined) throw new Error('could not start a child')
	await new Promise<void>((resolve) => child.once('exit', () => resolve()))
	return pid
}

describe('a reply whose host went away in its first instant', () => {
	it('is read, not changed, by the durable status alone', async () => {
		const f = await interruptedAtStart(state)
		expect((await f.log.activeTurn())?.state).toBe('interrupted')
		// The status is a read: whatever it says, it closes nothing. Closing is the host's act.
		await readProviderRetryStatus(state, f.sessionId)
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
			// The host closes it before the message goes to the kernel, so the turn is over by then.
			expect(send).toHaveBeenCalledTimes(1)
			expect(await f.log.activeTurn()).toBeNull()
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

	it('is settled when the host was killed and its lease is still unexpired', async () => {
		const pid = await deadPid()
		const f = await interruptedAtStart(state, {
			stillHeld: true,
			holder: (turnId) => `namzu:${pid}:${turnId}`,
		})
		// The killed host gave nothing back: its lease reads as live, and so as running.
		expect((await f.log.activeTurn())?.state).toBe('running')
		const host = runtime()
		try {
			expect(await host.providerRetryStatus?.(f.sessionId, root)).toEqual({})
			expect(await f.log.activeTurn()).toBeNull()
			const records = (await f.log.readAll()).entries.map((entry) => entry.record)
			expect(records.some((record) => record.type === 'turn_failed')).toBe(true)
			expect(records.some((record) => record.type === 'message' && record.role === 'user')).toBe(
				true,
			)
			// The conversation takes a new turn at once.
			const lease = await f.log.claim({ holder: 'next-host', ttlMs: 60_000 })
			expect(lease).not.toBeNull()
		} finally {
			await host.close()
		}
	})

	it('keeps the refusal when the host named in the lease is still alive', async () => {
		// This test process stands for a live host on this machine that is not the asker: its parent.
		const f = await interruptedAtStart(state, {
			stillHeld: true,
			holder: (turnId) => `namzu:${process.ppid}:${turnId}`,
		})
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

	it('reads a holder as gone only for a turn-shaped name with no process behind it', () => {
		const dead = () => false
		expect(holderIsGone('namzu:4242:turn_1', 'turn_1', dead)).toBe(true)
		expect(holderIsGone('namzu:4242:turn_1', 'turn_2', dead)).toBe(false)
		expect(holderIsGone('host-that-is-gone', 'turn_1', dead)).toBe(false)
		expect(holderIsGone(`namzu:${process.pid}:turn_1`, 'turn_1', dead)).toBe(false)
		expect(holderIsGone('namzu:4242:turn_1', 'turn_1', () => true)).toBe(false)
	})
})
