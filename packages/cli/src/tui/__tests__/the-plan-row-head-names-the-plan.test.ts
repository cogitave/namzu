import { describe, expect, it } from 'vitest'

import { type SessionEvent, ToolManager, createToolPresenter } from '@namzu/sdk'

import { toAgentEvent } from '../agent.js'

/**
 * The call row heads a file by its name. A long path arrives already shortened
 * by the presenter, so the plan file, whose path is deep inside the session
 * folder, used to print as a raw path in the row's head although everything
 * under it said "the plan".
 */
const presenter = createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] }))

const executing = (toolName: string, input: unknown) =>
	toAgentEvent(
		{ type: 'tool_executing', toolName, toolUseId: 'tu_1', input } as unknown as SessionEvent,
		presenter,
		undefined,
		'/work/app',
	)

describe('the head of a call row on the plan file', () => {
	const plan = `/home/me/.namzu/projects/${'-work-app-'.repeat(12)}/01a17d20-db3f-74be-8c86-9a9a0f7660a9/plans/plan.md`

	it('names the plan, however long the session folder path is', () => {
		const mapped = executing('write', { path: plan, content: '1. Do it\n' })
		expect(mapped).toMatchObject({ summary: 'the plan' })
	})

	it('leaves a plan.md of the person’s own project as a path', () => {
		const own = '/work/app/projects/app/src/plans/plan.md'
		expect(executing('write', { path: own, content: 'x' })).toMatchObject({
			summary: 'projects/app/src/plans/plan.md',
		})
	})
})
