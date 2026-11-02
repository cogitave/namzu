import { describe, expect, it, vi } from 'vitest'

import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionRecordDraft } from '../../../store/session-log/index.js'
import { generateProjectId, generateSessionId } from '../../../utils/id.js'
import { checkpointLogView } from '../session-storage.js'

/**
 * Verifying a checkpoint only needs the last entry up to `throughSeq`, but
 * the check used to collect every parsed record before looking at it, so
 * resuming a long session held the whole prefix in memory at once.
 */
async function logOf(updates: number) {
	const sessionId = generateSessionId()
	const log = new InMemorySessionLog({ sessionId })
	const lease = await log.claim({ holder: 'a', ttlMs: 60_000 })
	if (lease === null) throw new Error('claim failed')
	await log.append(lease, {
		type: 'session_started',
		projectId: generateProjectId(),
		cwd: '/w',
		agent: { id: 'a', name: 'A' },
	} as SessionRecordDraft)
	const pointers = []
	for (let i = 0; i < updates; i++) {
		pointers.push(
			(await log.append(lease, { type: 'session_updated', title: `t${i}` } as SessionRecordDraft))
				.pointer,
		)
	}
	return { sessionId, log, pointers }
}

describe('verifying a checkpoint prefix', () => {
	it('accepts the matching pointer and refuses a wrong hash or a seq past the log', async () => {
		const { sessionId, log, pointers } = await logOf(5)
		const view = checkpointLogView(log)
		const scope = { sessionId } as never
		const mid = pointers[2]!
		expect(await view.verifyThrough(scope, mid.seq, mid.sha256)).toBe(true)
		expect(await view.verifyThrough(scope, mid.seq, 'f'.repeat(64))).toBe(false)
		expect(await view.verifyThrough(scope, 999, mid.sha256)).toBe(false)
	})

	it('streams the walk instead of collecting every entry', async () => {
		const { sessionId, log, pointers } = await logOf(5)
		const readAll = vi.spyOn(log, 'readAll')
		const read = vi.spyOn(log, 'read')
		const last = pointers.at(-1)!
		const ok = await checkpointLogView(log).verifyThrough(
			{ sessionId } as never,
			last.seq,
			last.sha256,
		)
		expect(ok).toBe(true)
		expect(readAll).not.toHaveBeenCalled()
		expect(read).toHaveBeenCalledOnce()
	})
})
