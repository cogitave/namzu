import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ToolContext, generateTurnId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PermissionMode } from '../../permissions/mode.js'
import type { PlanApprovalAnswer, PlanApprovalFn } from '../approval.js'
import { buildExitPlanModeTool } from '../exit-plan-mode-tool.js'

const context = (signal?: AbortSignal): ToolContext =>
	({
		sessionId: '019a0000-0000-7000-8000-0000000000f3',
		turnId: generateTurnId(),
		abortSignal: signal,
	}) as unknown as ToolContext

let dir: string
let planPath: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-exit-plan-'))
	mkdirSync(join(dir, 'plans'))
	planPath = join(dir, 'plans', 'plan.md')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function tool(opts: {
	mode?: PermissionMode
	ask?: PlanApprovalFn
	bypass?: boolean
}) {
	return buildExitPlanModeTool({
		mode: () => opts.mode ?? 'plan',
		planPath: () => planPath,
		bypassAvailable: () => opts.bypass ?? false,
		approval: () => opts.ask,
	})
}

describe('exit_plan_mode', () => {
	it('is the model asking a person, so it needs no review of its own', () => {
		const t = tool({})
		expect(t.name).toBe('exit_plan_mode')
		expect(t.isReadOnly?.({})).toBe(true)
		expect(t.isConcurrencySafe?.({})).toBe(false)
	})

	it('refuses outside plan mode, and says so without asking anyone', async () => {
		const ask = vi.fn<PlanApprovalFn>()
		writeFileSync(planPath, '# Plan')
		const result = await tool({ mode: 'prompt', ask }).execute({}, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('not in plan mode')
		expect(ask).not.toHaveBeenCalled()
	})

	it('has nothing to approve while the plan file is missing or blank', async () => {
		const ask = vi.fn<PlanApprovalFn>()
		const missing = await tool({ ask }).execute({}, context())
		expect(missing.error).toContain(planPath)
		expect(missing.error).toContain('missing or empty')
		writeFileSync(planPath, '  \n')
		expect((await tool({ ask }).execute({}, context())).success).toBe(false)
		expect(ask).not.toHaveBeenCalled()
	})

	it('tells the model when nobody can approve, instead of waiting forever', async () => {
		writeFileSync(planPath, '# Plan')
		const result = await tool({}).execute({}, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('Nobody can approve')
	})

	it('shows the plan as the file holds it, and which first row the session offers', async () => {
		writeFileSync(planPath, '# Plan\n\nStep one\n')
		const ask = vi.fn<PlanApprovalFn>(async () => ({ kind: 'keep-planning' }))
		await tool({ ask, bypass: true }).execute({}, context())
		expect(ask).toHaveBeenCalledWith(
			{ plan: '# Plan\n\nStep one\n', planPath, bypassAvailable: true },
			undefined,
		)
	})

	it('gives the model the approved plan and where it is kept', async () => {
		writeFileSync(planPath, '# Plan\n\nStep one\n')
		const answer: PlanApprovalAnswer = {
			kind: 'approve',
			mode: 'accept-edits',
			feedback: 'go fast',
		}
		const result = await tool({ ask: async () => answer }).execute({}, context())
		expect(result.success).toBe(true)
		expect(result.output).toContain('approved your plan')
		expect(result.output).toContain('Auto-approve edits')
		expect(result.output).toContain(`saved at ${planPath}`)
		expect(result.output).toContain('The user added: go fast')
		expect(result.output).toContain('## Approved plan\n# Plan\n\nStep one')
		expect(result.data).toMatchObject({
			outcome: 'approved',
			mode: 'accept-edits',
		})
	})

	it('sends the words back when the person keeps planning, and says when there are none', async () => {
		writeFileSync(planPath, '# Plan')
		const withWords = await tool({
			ask: async () => ({
				kind: 'keep-planning',
				feedback: 'cover the migration',
			}),
		}).execute({}, context())
		expect(withWords.success).toBe(false)
		expect(withWords.error).toContain('keep planning')
		expect(withWords.error).toContain('cover the migration')
		const without = await tool({
			ask: async () => ({ kind: 'keep-planning' }),
		}).execute({}, context())
		expect(without.error).toContain('has not said what to change')
		expect(without.data).toMatchObject({ outcome: 'keep-planning' })
	})

	it('treats a dialog that fails as "keep planning", never as approval', async () => {
		writeFileSync(planPath, '# Plan')
		const result = await tool({
			ask: async () => {
				throw new Error('screen gone')
			},
		}).execute({}, context())
		expect(result.success).toBe(false)
		expect(result.data).toMatchObject({ outcome: 'keep-planning' })
	})

	it('does not show the approved plan a second time in its own result row', () => {
		const t = tool({})
		expect(
			t.presentResult?.(
				{},
				{
					success: true,
					output: 'long plan text',
					data: { outcome: 'approved' },
				},
			),
		).toMatchObject({ visibility: 'hidden' })
	})
})
