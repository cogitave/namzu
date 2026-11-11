import {
	InMemorySessionLog,
	type SessionLog,
	type SessionRecord,
	asProjectId,
	asSessionId,
	asTenantId,
	asTopicId,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { ensureSessionStarted } from '../store.js'

/**
 * `ensureSessionStarted` runs before every turn. It used to ask the log for its
 * head, which brings the whole chain up to date: a walk of every record, so a
 * long session paid for its whole history to learn that it had started.
 */

const scope = {
	projectId: asProjectId('11111111-1111-4111-8111-111111111111'),
	tenantId: asTenantId('22222222-2222-4222-8222-222222222222'),
	topicId: asTopicId('33333333-3333-4333-8333-333333333333'),
	cwd: '/tmp/work',
	agent: { id: 'namzu', name: 'namzu' },
}

/** A log that counts what is asked of it. */
function counted(log: InMemorySessionLog) {
	const calls = { head: 0, recordsRead: 0 }
	const proxy = new Proxy(log, {
		get(target, key) {
			if (key === 'head') {
				return () => {
					calls.head += 1
					return target.head()
				}
			}
			if (key === 'readAll') {
				return async (options?: Parameters<SessionLog['readAll']>[0]) => {
					const read = await target.readAll(options)
					calls.recordsRead += read.entries.length
					return read
				}
			}
			const value = Reflect.get(target, key, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as SessionLog
	return { log: proxy, calls }
}

async function sessionWith(records: number) {
	const sessionId = asSessionId('44444444-4444-4444-8444-444444444444')
	const memory = new InMemorySessionLog({ sessionId })
	await ensureSessionStarted(memory, scope)
	const lease = await memory.claim({ holder: 'test', ttlMs: 60_000 })
	if (lease === null) throw new Error('no lease')
	for (let i = 0; i < records; i++) {
		await memory.append(lease, {
			type: 'session_updated',
			title: `t${i}`,
		} as unknown as Omit<SessionRecord, 'v' | 'id' | 'sessionId' | 'seq' | 'gen' | 'ts' | 'prev'>)
	}
	await memory.release(lease)
	return memory
}

describe('ensureSessionStarted on a log that has started', () => {
	for (const length of [20, 80]) {
		it(`reads one record and never asks for the head, at ${length} records`, async () => {
			const memory = await sessionWith(length)
			const watched = counted(memory)
			await ensureSessionStarted(watched.log, scope)
			expect(watched.calls.head).toBe(0)
			expect(watched.calls.recordsRead).toBe(1)
		})
	}

	it('still starts an empty log, once', async () => {
		const memory = new InMemorySessionLog({
			sessionId: asSessionId('44444444-4444-4444-8444-444444444444'),
		})
		await ensureSessionStarted(memory, scope)
		await ensureSessionStarted(memory, scope)
		const all = await memory.readAll()
		expect(all.entries.map((entry) => entry.record.type)).toEqual(['session_started'])
	})
})
