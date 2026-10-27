import { type ToolContext, generateTurnId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { PermissionMode } from '../../permissions/mode.js'
import type { QuestionAnswer, QuestionFn } from '../../tui/agent.js'
import { buildEnterPlanModeTool } from '../enter-plan-mode-tool.js'

const context = (signal?: AbortSignal): ToolContext =>
	({
		sessionId: '019a0000-0000-7000-8000-0000000000f3',
		turnId: generateTurnId(),
		abortSignal: signal,
	}) as unknown as ToolContext

function tool(opts: { mode?: PermissionMode; ask?: QuestionFn; enter?: () => void }) {
	const enter = opts.enter ?? vi.fn()
	return {
		enter,
		tool: buildEnterPlanModeTool({
			mode: () => opts.mode ?? 'prompt',
			planPath: () => '/s/plans/plan.md',
			ask: () => opts.ask,
			enter,
		}),
	}
}

const answering =
	(answer: QuestionAnswer): QuestionFn =>
	async () =>
		answer

describe('enter_plan_mode', () => {
	it('asks the person first and switches only after a yes', async () => {
		const seen: string[] = []
		const ask: QuestionFn = async (question) => {
			seen.push(question.question)
			return { kind: 'answer', selectedOptionIds: ['plan-first'] }
		}
		const { tool: t, enter } = tool({ ask })
		const result = await t.execute({}, context())
		expect(seen).toEqual(['Enter plan mode?'])
		expect(enter).toHaveBeenCalledTimes(1)
		expect(result.success).toBe(true)
		expect(result.output).toContain('/s/plans/plan.md')
		expect(result.output).toContain('exit_plan_mode')
		expect(result.data).toEqual({ outcome: 'entered' })
	})

	it.each([
		['no', { kind: 'answer', selectedOptionIds: ['go-ahead'] }],
		['skipped', { kind: 'skip' }],
		['aborted', { kind: 'abort' }],
	] as const)('leaves the mode alone when the answer is %s', async (_name, answer) => {
		const { tool: t, enter } = tool({ ask: answering(answer) })
		const result = await t.execute({}, context())
		expect(enter).not.toHaveBeenCalled()
		expect(result.success).toBe(true)
		expect(result.output).toContain('Carry on')
		expect(result.data).toEqual({ outcome: 'declined' })
	})

	it('does not switch when nobody can be asked', async () => {
		const { tool: t, enter } = tool({})
		const result = await t.execute({}, context())
		expect(enter).not.toHaveBeenCalled()
		expect(result.success).toBe(true)
		expect(result.output).toContain('Nobody can be asked')
	})

	it('does not ask in plan mode, where it is already on', async () => {
		const ask = vi.fn<QuestionFn>()
		const { tool: t, enter } = tool({ mode: 'plan', ask })
		const result = await t.execute({}, context())
		expect(ask).not.toHaveBeenCalled()
		expect(enter).not.toHaveBeenCalled()
		expect(result.success).toBe(true)
		expect(result.data).toEqual({ outcome: 'already' })
	})

	it('goes straight in under Auto, where the person chose not to be asked per step', async () => {
		const ask = vi.fn<QuestionFn>()
		const { tool: t, enter } = tool({ mode: 'classify', ask })
		const result = await t.execute({}, context())
		expect(ask).not.toHaveBeenCalled()
		expect(enter).toHaveBeenCalledTimes(1)
		expect(result.data).toEqual({ outcome: 'entered' })
	})

	it('asks under bypass and under accept-edits as well', async () => {
		for (const mode of ['bypass', 'accept-edits', 'strict'] as const) {
			const ask = vi.fn<QuestionFn>(async () => ({ kind: 'skip' }))
			await tool({ mode, ask }).tool.execute({}, context())
			expect(ask).toHaveBeenCalledTimes(1)
		}
	})

	it('is read-only and takes no arguments, with a one-line hint for the deferred list', () => {
		const { tool: t } = tool({})
		expect(t.isReadOnly?.({})).toBe(true)
		// The deferred list shows the first sentence, cut at 100 characters.
		const hint = t.description.match(/^.*?[.!?](?=\s|$)/)?.[0]
		expect(hint).toBe('Ask the user to switch to plan mode before a change that is not small.')
		expect(t.description).not.toMatch(/[A-Z]{4,}/)
	})
})
