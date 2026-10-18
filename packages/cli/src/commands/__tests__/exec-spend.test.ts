import { describe, expect, it } from 'vitest'

import { initialRunView } from '../../integrations/workflows/view.js'
import type { SessionWorkflows } from '../../tui/agent.js'
import { commandSpend } from '../exec-workflows.js'

/**
 * `namzu exec` prints one `Tokens:` line for the command. A command that
 * started a workflow takes a reporting turn after its first, and the line used
 * to be the reporting turn's alone: on a measured run it said 97 434 for a
 * command that spent 190 354 on the parent and 147 307 more on the run's agents.
 */

const turn = (own: number, tree = own) => ({ ownTokens: own, treeTokens: tree, limit: 0 })

function workflowsWith(...tokens: number[]): SessionWorkflows {
	return {
		runs: () => [
			{
				...initialRunView({ runId: 'wrun00001', name: 'n', description: 'd', phases: [], at: 0 }),
				agents: tokens.map((t, i) => ({
					index: i + 1,
					label: `a${i}`,
					status: 'done' as const,
					queuedAt: 0,
					tokens: t,
					toolCalls: 0,
				})),
			},
		],
	} as unknown as SessionWorkflows
}

describe('commandSpend', () => {
	it('is the last turn alone when there was only one', () => {
		expect(commandSpend([], turn(5), undefined)).toEqual(turn(5))
	})

	it('adds the turns before the last one', () => {
		expect(commandSpend([turn(90), turn(10)], turn(7), undefined)).toMatchObject({
			ownTokens: 107,
			treeTokens: 107,
		})
	})

	it("adds a workflow's agents to the descendants and not to the command's own", () => {
		expect(commandSpend([turn(90)], turn(7), workflowsWith(20, 30))).toMatchObject({
			ownTokens: 97,
			treeTokens: 147,
		})
	})

	it('keeps the earlier total when the last turn reported nothing', () => {
		expect(commandSpend([turn(90)], undefined, workflowsWith(10))).toMatchObject({
			ownTokens: 90,
			treeTokens: 100,
		})
	})

	it('has nothing to say when no turn reported a budget', () => {
		expect(commandSpend([], undefined, workflowsWith(10))).toBeUndefined()
	})
})
