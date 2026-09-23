/**
 * A scheduled run has no session-wide approval, so its permission screen
 * offers only Yes and No: no "allow all" line, and no `a` in the key hint.
 * A live prompt keeps its three answers.
 */

import { describe, expect, it } from 'vitest'

import { PermissionOverlay, permissionAnswers, permissionChoices } from '../PermissionOverlay.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

const bash = [{ id: 'call_1', name: 'bash', input: { command: 'date >> stamp.txt' }, isDestructive: true }]
const agent = [
	{
		id: 'agent-one',
		name: 'Agent',
		input: { description: 'Read package files', prompt: 'Only inspect src/index.ts.' },
		isDestructive: false,
	},
]

describe('the answers a prompt offers', () => {
	it('are Yes and No for a batch-only prompt, and each does what it says', () => {
		expect(permissionAnswers(bash, { batchOnly: true })).toEqual([
			{ label: 'Yes', kind: 'approve' },
			{ label: 'No, and tell namzu what to do differently (esc)', kind: 'reject' },
		])
		expect(permissionAnswers(agent, { batchOnly: true }).map((a) => a.kind)).toEqual([
			'approve',
			'reject',
		])
	})

	it('keep "allow all" on a live prompt', () => {
		expect(permissionAnswers(bash).map((a) => a.kind)).toEqual(['approve', 'approve-all', 'reject'])
		expect(permissionChoices(bash)[1]).toBe('Yes, allow all tools for this session')
	})
})

describe('the scheduled-run screen', () => {
	it.each([
		[bash, 'Yes', 'No, and tell namzu'],
		[agent, 'Start this agent', 'Do not start'],
	])('shows two answers and no "allow all"', async (toolCalls, yes, no) => {
		const review = buildPermissionReview(toolCalls)
		if (!review.ok) throw new Error('fixture must fit the exact approval envelope')
		const screen = await renderToScreen(
			<PermissionOverlay
				toolCalls={toolCalls}
				review={review.text}
				summary={buildPermissionSummary(review.text)}
				detailsOpen={false}
				columns={100}
				rows={24}
				batchOnly
			/>,
			{ cols: 100, rows: 24 },
		)
		try {
			await screen.waitForRender()
			const visible = screen.viewport().join('\n')
			expect(visible).toContain(`❯ 1. ${yes}`)
			expect(visible).toContain(`2. ${no}`)
			expect(visible).not.toContain('3.')
			expect(visible).not.toMatch(/allow all|allow other tools/)
			expect(visible).toContain('y / n answer')
			expect(visible).not.toContain('y / a / n')
		} finally {
			await screen.unmount()
		}
	})
})
