/**
 * A teammate's ask is drawn in the lead's permission box with the member's name in the title
 * ("<name> wants to run ..."), a plan it sent is titled as one with the plan as the body, and a plan
 * is offered only Yes and No: nothing about it is remembered.
 */

import { expect, it } from 'vitest'

import {
	PermissionOverlay,
	permissionAnswers,
	permissionQuestion,
	teammateTitle,
} from '../PermissionOverlay.js'
import type { PermissionToolCall } from '../agent.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

const CWD = '/work/app'
const shell = (command: string): PermissionToolCall => ({
	id: 's',
	name: 'bash',
	input: { command },
	isDestructive: false,
})
const plan: PermissionToolCall = {
	id: 'p',
	name: 'exit_plan_mode',
	input: { plan: 'Step 1: read the parser\nStep 2: change it' },
	isDestructive: false,
	requiresApproval: true,
}

function summaryOf(calls: readonly PermissionToolCall[]) {
	const review = buildPermissionReview(calls)
	if (!review.ok) throw new Error('fixture must be representable')
	return { review: review.text, summary: buildPermissionSummary(review.text, { cwd: CWD }) }
}

it('titles a teammate’s call with its name first', () => {
	expect(teammateTitle('writer', [shell('npm test')], CWD)).toBe('writer wants to run a command')
	expect(
		teammateTitle(
			'writer',
			[{ id: 'e', name: 'edit', input: { path: '/work/app/src/a.ts' }, isDestructive: false }],
			CWD,
		),
	).toBe('writer wants to edit src/a.ts')
	expect(teammateTitle('writer', [shell('a'), { ...shell('b'), id: 't' }], CWD)).toBe(
		'writer wants to run 2 tool calls',
	)
	expect(teammateTitle('writer', [plan], CWD)).toBe('writer sent a plan for approval')
})

it('offers a plan Yes and No only, with its own question', () => {
	expect(permissionQuestion([plan])).toBe('Do you want to approve this plan?')
	const answers = permissionAnswers([plan], {
		mode: 'prompt',
		commandArguments: new Map([['exit_plan_mode', 'plan']]),
	})
	expect(answers.map((answer) => answer.kind)).toEqual(['approve', 'reject'])
	expect(answers[1]?.label).toContain('send it back')
})

it('shows the plan itself, one row per line, and not its JSON', () => {
	const { summary } = summaryOf([plan])
	expect(summary.text).toContain('Step 1: read the parser')
	expect(summary.text).toContain('Step 2: change it')
	expect(summary.text).not.toContain('"plan"')
})

for (const cols of [90, 40]) {
	it(`draws the box at ${cols} columns with the member named in the title and nothing clipped`, async () => {
		const call = shell('npm test')
		const { review, summary } = summaryOf([call])
		const screen = await renderToScreen(
			<PermissionOverlay
				toolCalls={[call]}
				review={review}
				summary={summary}
				detailsOpen={false}
				columns={cols}
				rows={24}
				cwd={CWD}
				teammate="writer"
				count={{ position: 1, total: 2 }}
			/>,
			{ cols, rows: 24 },
		)
		try {
			await screen.waitForRender()
			const lines = screen.viewport()
			const text = lines.join('\n')
			expect(text).toContain('writer wants to run a command')
			expect(text).toContain('$ npm test')
			expect(text).not.toContain('Bash command')
			// Nothing runs past the right edge of the screen.
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(cols)
		} finally {
			await screen.unmount()
		}
	})
}

it('draws a plan with the member’s name and the plan in the box', async () => {
	const { review, summary } = summaryOf([plan])
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={[plan]}
			review={review}
			summary={summary}
			detailsOpen={false}
			columns={90}
			rows={24}
			cwd={CWD}
			teammate="writer"
		/>,
		{ cols: 90, rows: 24 },
	)
	try {
		await screen.waitForRender()
		const text = screen.viewport().join('\n')
		expect(text).toContain('writer sent a plan for approval')
		expect(text).toContain('Step 1: read the parser')
		expect(text).toContain('Do you want to approve this plan?')
		expect(text).not.toContain("don't ask again")
	} finally {
		await screen.unmount()
	}
})
