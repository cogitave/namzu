import { ToolManager, toolset } from '@namzu/sdk'
import type { HITLDecisionRequest, SessionId, ToolCallSummary, TurnId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { PLAN_MODE_REFUSAL } from '../../permissions/mode.js'
import { makeResumeHandler, reviewExemptionFor } from '../../tui/agent.js'
import { buildEnterPlanModeTool } from '../enter-plan-mode-tool.js'
import { buildExitPlanModeTool } from '../exit-plan-mode-tool.js'
import { isPlanFileWrite } from '../plan-file.js'

/**
 * Plan mode keeps refusing every change except the plan file, and presenting
 * the plan is not itself something to ask about.
 */

const PLAN = '/home/u/.namzu/projects/p/s/plans/plan.md'
const sessionId = '02b19846-c793-4e21-9c6e-21962a7d2de5' as SessionId
const turnId = 'f4e0af37-43f7-48fd-82b0-f1b1c68881d3' as TurnId

const call = (
	name: string,
	input: unknown,
	extra: Partial<ToolCallSummary> = {},
): ToolCallSummary => ({
	id: `call_${name}`,
	name,
	input,
	isDestructive: false,
	...extra,
})
const review = (...toolCalls: ToolCallSummary[]): HITLDecisionRequest => ({
	sessionId,
	type: 'tool_review',
	turnId,
	checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as never,
	toolCalls,
})

describe('plan mode in the terminal', () => {
	const handler = (planModeWrite?: (c: ToolCallSummary) => boolean) =>
		makeResumeHandler({ all: false }, vi.fn(), 'plan', () => false, {}, undefined, planModeWrite)

	it('lets the model write its plan file even though it is outside the roots and overwrites', async () => {
		const write = call(
			'write',
			{ path: PLAN, content: '# Plan' },
			{ isDestructive: true, escalation: { outsidePaths: [PLAN] } as never },
		)
		const decision = await handler(isPlanFileWrite(PLAN, '/work'))(review(write))
		expect(decision).toEqual({ action: 'approve_tools' })
	})

	it('still refuses everything else, and the plan file as well when the session has none', async () => {
		const isPlan = isPlanFileWrite(PLAN, '/work')
		const refused = { action: 'reject_tools', feedback: PLAN_MODE_REFUSAL }
		expect(await handler(isPlan)(review(call('write', { path: '/work/src/a.ts' })))).toEqual(
			refused,
		)
		expect(await handler(isPlan)(review(call('bash', { command: 'rm -rf /' })))).toEqual(refused)
		expect(await handler()(review(call('write', { path: PLAN })))).toEqual(refused)
	})

	it('does not ask about presenting the plan, in any mode it could be called', () => {
		const manager = new ToolManager({
			toolsets: [
				toolset('plan-mode', [
					buildExitPlanModeTool({
						mode: () => 'plan',
						planPath: () => PLAN,
						bypassAvailable: () => false,
						approval: () => undefined,
					}),
				]),
			],
			messages: () => [],
		})
		for (const mode of ['prompt', 'accept-edits', 'plan', 'auto'] as const) {
			expect(reviewExemptionFor(mode, manager, () => false)('exit_plan_mode', {}), mode).toBe(true)
		}
		// Without the tool mounted the name is just a name.
		const bare = new ToolManager({ toolsets: [], messages: () => [] })
		expect(reviewExemptionFor('plan', bare, () => false)('exit_plan_mode', {})).toBe(false)
	})

	it('does not put a second question in front of the proposal to plan first', () => {
		const manager = new ToolManager({
			toolsets: [
				toolset('plan-mode-entry', [
					buildEnterPlanModeTool({
						mode: () => 'prompt',
						planPath: () => PLAN,
						ask: () => undefined,
						enter: () => {},
					}),
				]),
			],
			messages: () => [],
		})
		for (const mode of ['prompt', 'accept-edits', 'plan', 'bypass', 'classify'] as const) {
			expect(reviewExemptionFor(mode, manager, () => false)('enter_plan_mode', {}), mode).toBe(true)
		}
		expect(reviewExemptionFor('strict', manager, () => false)('enter_plan_mode', {})).toBe(true)
	})
})
