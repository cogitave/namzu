import { describe, expect, it, vi } from 'vitest'

import { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { SessionLogCore } from '../../../store/session-log/core.js'
import { InMemorySessionLeaseStore } from '../../../store/session-log/lease.js'
import { InMemoryLogMedium } from '../../../store/session-log/memory.js'
import { InMemorySpillStore } from '../../../store/session-log/spill.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import { EventTranslator } from '../events.js'

const TURN = 'b20a3380-db4f-47a7-b446-d48bcbbbdfef' as TurnId
const SESSION = '661ca27b-88d4-4c9c-9c61-a2f296ac9aae' as SessionId

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

/** An in-memory log whose volume can fill up. */
class FullableMedium extends InMemoryLogMedium {
	full = false
	override async append(bytes: Uint8Array, expectedOffset: number): Promise<void> {
		if (this.full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
		await super.append(bytes, expectedOffset)
	}
}

describe('a full disk reaches a host as two events', () => {
	it('says the transcript stopped being written once, and that it works again once', async () => {
		const medium = new FullableMedium()
		const log = new SessionLogCore({
			sessionId: SESSION,
			medium,
			leases: new InMemorySessionLeaseStore(),
			spills: new InMemorySpillStore(),
			sync: 'none',
		})
		const recorder = new TurnRecorder({
			turnId: TURN,
			agentId: 'a',
			agentName: 'A',
			turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
			providerId: 'mock',
			log: LOG,
			sessionId: SESSION,
			topicId: 'bcc64cd7-b81a-4dff-a633-203f1a03a837',
			projectId: 'b0f376f8-52af-4302-bf4f-d7bcf3cf34c3',
			tenantId: 'a8bb2035-b5d5-4866-815b-a67fc7085cc6',
			sessionLog: log,
			// biome-ignore lint/suspicious/noExplicitAny: branded id types are not what this test is about.
		} as any)
		await recorder.open({ session: { cwd: '/tmp' } })
		await recorder.begin()
		const emitter = new EventTranslator(recorder)

		medium.full = true
		await emitter.emitEvent({
			type: 'task_created',
			taskId: 't1',
			subject: 's',
			status: 'pending',
		} as never)
		await emitter.emitEvent({
			type: 'task_created',
			taskId: 't2',
			subject: 's',
			status: 'pending',
		} as never)
		medium.full = false
		await emitter.emitEvent({
			type: 'task_created',
			taskId: 't3',
			subject: 's',
			status: 'pending',
		} as never)
		await emitter.emitEvent({
			type: 'task_created',
			taskId: 't4',
			subject: 's',
			status: 'pending',
		} as never)

		const types = [...emitter.drainPending()]
			.map((e) => e.type)
			.filter((t) => t.startsWith('session_log'))
		expect(types).toEqual(['session_log_degraded', 'session_log_recovered'])
	})
})
