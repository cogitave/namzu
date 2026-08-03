import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunDiskStore } from '../../../store/run/disk.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { Logger } from '../../../utils/logger.js'
import { planCrashResume, recoverCompletedCalls } from '../resume-pending.js'

/**
 * A fan-out that crashes part-way through must not re-run the workers that
 * already finished — for a worker with a side effect, a write or an
 * outbound message, "run it again" is "do it twice".
 *
 * The claim under test is that this is ALREADY covered, and by a general
 * mechanism rather than a delegation-specific one. Delegation here is
 * blocking: the tool awaits its worker and returns that worker's output as
 * its own `tool_result`. So a delegation is an ordinary tool call, its
 * completion is recorded as an ordinary `tool_completed`, and the
 * crash-resume path that answers already-executed tool calls from the
 * transcript answers delegations too.
 *
 * These tests exist because that is a load-bearing consequence of an
 * unrelated design choice, and nothing pinned it. If delegation ever stops
 * blocking, they fail — which is exactly when somebody needs to know.
 */

const RID = 'run_1' as RunId

function makeLogger(): Logger {
	const self = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

const delegation = (id: string, agent: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'create_task', arguments: JSON.stringify({ agent_id: agent }) },
})

/** A five-worker fan-out: one assistant turn, five delegation blocks. */
const fanOut = (): Message[] => [
	createUserMessage('fan out to five specialists'),
	{
		...createAssistantMessage(''),
		toolCalls: [
			delegation('w1', 'writer'),
			delegation('w2', 'auditor'),
			delegation('w3', 'billing'),
			delegation('w4', 'mailer'),
			delegation('w5', 'reporter'),
		],
	} as Message,
]

describe('a fan-out interrupted part-way through', () => {
	let dir: string
	let store: RunDiskStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-fanout-'))
		store = new RunDiskStore({ baseDir: dir })
		await store.initRun(RID)
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const recordCompletions = async (ids: readonly string[]) => {
		const lines = ids.map((id) =>
			JSON.stringify({
				type: 'tool_completed',
				toolUseId: id,
				toolName: 'create_task',
				result: `${id} finished its work`,
				isError: false,
			}),
		)
		await writeFile(join(dir, RID, 'transcript.jsonl'), `${lines.join('\n')}\n`, 'utf-8')
	}

	it('recovers the workers that already finished', async () => {
		await recordCompletions(['w1', 'w2', 'w3'])

		const runMgr = { getRunStore: () => store } as never
		const recovered = await recoverCompletedCalls(
			runMgr,
			(fanOut()[1] as { toolCalls: { id: string }[] }).toolCalls as never,
			makeLogger(),
		)

		// Three workers are answered from the record. The billing worker in
		// particular does not charge a second time.
		expect([...recovered.keys()].sort()).toEqual(['w1', 'w2', 'w3'])
		expect(recovered.get('w3')?.result).toContain('finished its work')
	})

	it('takes over the turn rather than letting the model re-decide', async () => {
		// The ordinary repair strips the assistant turn and lets the model
		// re-issue every delegation — which is precisely the second run.
		const plan = planCrashResume(
			{ id: 'cp_1' as CheckpointId, messages: fanOut() } as IterationCheckpoint,
			new Map([['w1', {}]]),
			makeLogger(),
		)

		expect(plan).not.toBeNull()
		expect(plan?.response.message.toolCalls).toHaveLength(5)
	})

	it('names the workers that will actually run', async () => {
		const log = makeLogger()
		planCrashResume(
			{ id: 'cp_1' as CheckpointId, messages: fanOut() } as IterationCheckpoint,
			new Map([
				['w1', {}],
				['w2', {}],
				['w3', {}],
			]),
			log,
		)

		const warned = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
		expect(warned?.[1]).toMatchObject({ completed: 3, total: 5 })
	})

	it('leaves an untouched fan-out to the ordinary repair', async () => {
		// Nothing dispatched yet means nothing to protect, and re-deciding
		// costs only a round trip.
		expect(
			planCrashResume(
				{ id: 'cp_1' as CheckpointId, messages: fanOut() } as IterationCheckpoint,
				new Map(),
				makeLogger(),
			),
		).toBeNull()
	})

	it('does not confuse a worker id with one from an earlier turn', async () => {
		await recordCompletions(['from-an-older-turn'])

		const runMgr = { getRunStore: () => store } as never
		const recovered = await recoverCompletedCalls(
			runMgr,
			(fanOut()[1] as { toolCalls: { id: string }[] }).toolCalls as never,
			makeLogger(),
		)

		// Scoped to the calls being resumed, so a stale id cannot answer a
		// delegation that never ran.
		expect(recovered.size).toBe(0)
	})
})
