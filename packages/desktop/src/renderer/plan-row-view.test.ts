import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PlanRow } from './plan-row-view.js'

const tasks = Array.from({ length: 8 }, (_, index) => ({
	taskId: `t${index}`,
	subject: `Step ${index}`,
	status:
		index < 2
			? ('completed' as const)
			: index === 2
				? ('in_progress' as const)
				: ('pending' as const),
	blockedBy: [],
}))

it('draws the live plan as one shimmering line and folds the list to six rows and a link', () => {
	const html = renderToStaticMarkup(
		createElement(PlanRow, { tasks, turnLive: true, open: true, onOpenTasks: () => {} }),
	)
	expect(html).toContain('Plan · 2/8')
	expect(html).toContain('Step 2')
	expect(html).toContain('class="tool tool-group plan-row active"')
	expect((html.match(/<li /g) ?? []).length).toBe(6)
	expect(html).toContain('+2 more')
})

it('reads a finished plan muted and an unfinished one at turn end in normal text', () => {
	const done = tasks.map((task) => ({ ...task, status: 'completed' as const }))
	const finished = renderToStaticMarkup(createElement(PlanRow, { tasks: done, turnLive: false }))
	expect(finished).toContain('Plan · 8/8 done')
	expect(finished).toContain('data-tone="muted"')
	expect(finished).not.toContain(' active')
	const left = renderToStaticMarkup(createElement(PlanRow, { tasks, turnLive: false }))
	expect(left).toContain('data-tone="normal"')
})

it('draws nothing while a live turn has no task yet, and a quiet line once it has ended', () => {
	expect(renderToStaticMarkup(createElement(PlanRow, { tasks: [], turnLive: true }))).toBe('')
	expect(renderToStaticMarkup(createElement(PlanRow, { tasks: [], turnLive: false }))).toContain(
		'Updated tasks',
	)
})
