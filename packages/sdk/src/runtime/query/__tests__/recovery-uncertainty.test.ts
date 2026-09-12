import { expect, it, vi } from 'vitest'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { RunStore, ToolExecutionSnapshot } from '../../../types/run/store.js'
import type { Logger } from '../../../utils/logger.js'
import { PendingAnswers } from '../question-park.js'
import { recoverCompletedCalls } from '../resume-pending.js'

const runId = fixtureId.run('recovery-uncertainty')
const calls = ['done', 'unknown', 'untouched'].map((id) => ({
	id,
	type: 'function' as const,
	function: { name: 'effect', arguments: '{}' },
}))
const log = { warn: vi.fn(), info: vi.fn() } as unknown as Logger
const snapshot = (): ToolExecutionSnapshot => ({
	complete: true,
	records: new Map([
		[
			'done',
			{
				toolUseId: 'done',
				toolName: 'effect',
				status: 'completed',
				result: 'actual receipt',
				isError: false,
			},
		],
		['unknown', { toolUseId: 'unknown', toolName: 'effect', status: 'started' }],
	]),
})
function manager(store: Partial<RunStore>) {
	return { id: runId, getRunStore: () => store } as RunPersistence
}

it('keeps real completions, marks starts unknown, and leaves proven unstarted calls eligible', async () => {
	const recovered = await recoverCompletedCalls(
		manager({ readToolExecutions: async () => snapshot() }),
		calls,
		log,
	)
	expect(recovered.get('done')).toEqual({ result: 'actual receipt', isError: false })
	expect(recovered.get('unknown')).toMatchObject({
		result: expect.stringContaining('outcome is unknown'),
		isError: true,
	})
	expect(recovered.has('untouched')).toBe(false)
})
it.each(['unavailable', 'incomplete', 'wrong-name', 'wrong-id'] as const)(
	'does not mistake %s evidence for permission to repeat',
	async (mode) => {
		const state = snapshot()
		if (mode === 'wrong-name' || mode === 'wrong-id')
			(state.records as Map<string, unknown>).set('done', {
				status: 'completed',
				toolUseId: mode === 'wrong-id' ? 'another' : 'done',
				toolName: mode === 'wrong-name' ? 'other_tool' : 'effect',
				result: 'unrelated receipt',
				isError: false,
			})
		const recovered = await recoverCompletedCalls(
			manager({
				readToolExecutions: async () => {
					if (mode === 'unavailable') throw new Error('read failed')
					return mode === 'incomplete' ? { ...state, complete: false } : state
				},
			}),
			calls,
			log,
		)
		expect(recovered.get('done')?.result).toContain('outcome is unknown')
		expect(recovered.get('done')?.result).not.toContain('unrelated receipt')
		if (mode === 'unavailable' || mode === 'incomplete') expect(recovered.size).toBe(3)
	},
)
it('uses strict ordered events for a store without the optional bounded scan', async () => {
	const readEvents = vi.fn(
		async () =>
			[
				{ type: 'run_started', runId, seq: 1 },
				{ type: 'tool_executing', runId, seq: 2, toolUseId: 'unknown', toolName: 'effect' },
			] as never,
	)
	const recovered = await recoverCompletedCalls(manager({ readEvents }), calls, log)
	expect(readEvents).toHaveBeenCalledWith({ integrity: 'strict' })
	expect([...recovered.keys()]).toEqual(['unknown'])
})
it('lets an explicit durable answer re-enter only its asking tool when the log is unavailable', async () => {
	const answers = PendingAnswers.from({
		action: 'answer_question',
		questionId: 'unknown:target',
		selectedOptionIds: ['yes'],
	})
	const recovered = await recoverCompletedCalls(
		manager({
			readToolExecutions: async () => {
				throw new Error('unavailable')
			},
		}),
		calls,
		log,
		{ answers },
	)
	expect(recovered.has('unknown')).toBe(false)
	expect(recovered.has('done')).toBe(true)
	expect(recovered.has('untouched')).toBe(true)
})
it('preserves cancellation instead of synthesizing recovery permission', async () => {
	const signal = AbortSignal.abort(new Error('cancelled'))
	await expect(
		recoverCompletedCalls(
			manager({
				readToolExecutions: async (_ids, signal) => {
					signal!.throwIfAborted()
					return snapshot()
				},
			}),
			calls,
			log,
			{ signal },
		),
	).rejects.toThrow('cancelled')
})
