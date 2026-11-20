import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { JobView } from '../shared/protocol.js'
import { sectionTasks } from './background-tasks-model.js'
import {
	BackgroundTasksPane,
	ClearFinishedButton,
	type TaskChoices,
} from './background-tasks-pane.js'

const job = (over: Partial<JobView> & { id: string }): JobView => ({
	command: `cmd ${over.id}`,
	status: 'running',
	startedAt: 1000,
	...over,
})

function choices(jobs: JobView[], open?: boolean): TaskChoices {
	const sections = sectionTasks(jobs)
	return {
		sections,
		finishedOpen: open ?? sections.running.length === 0,
		canClear: sections.finished.length > 0,
		clearFinished: () => {},
		setFinishedOpen: () => {},
	}
}
const render = (value: TaskChoices, known = true) =>
	renderToStaticMarkup(
		createElement(BackgroundTasksPane, {
			choices: value,
			known,
			now: 5000,
			onRead: async () => undefined,
			onStop: async () => {},
		}),
	)

it('says where tasks appear while there are none', () => {
	expect(render(choices([]))).toContain('Background tasks appear here')
	expect(render(choices([]), false)).toContain('Checking background tasks')
})

it('lists Running with its count, and Finished folded while something runs', () => {
	const html = render(
		choices([
			job({ id: 'a' }),
			job({ id: 'b', status: 'exited', exitCode: 0, startedAt: 10, completedAt: 20 }),
		]),
	)
	expect(html).toContain('data-section="running"')
	expect(html).toContain('data-section="finished"')
	expect(html).toContain('aria-expanded="false"')
	expect(html).toContain('cmd a')
	expect(html).not.toContain('cmd b')
	expect(html).toContain('>4s<')
})

it('opens Finished while nothing runs and draws the failure in words', () => {
	const html = render(
		choices([job({ id: 'b', status: 'exited', exitCode: 3, startedAt: 10, completedAt: 20 })]),
	)
	expect(html).not.toContain('data-section="running"')
	expect(html).toContain('aria-expanded="true"')
	expect(html).toContain('>Failed<')
})

it('keeps Clear finished tasks off until something has finished', () => {
	const off = renderToStaticMarkup(
		createElement(ClearFinishedButton, { choices: choices([job({ id: 'a' })]) }),
	)
	expect(off).toContain('aria-label="Clear finished tasks"')
	expect(off).toMatch(/<button[^>]* disabled=""/)
	const on = renderToStaticMarkup(
		createElement(ClearFinishedButton, {
			choices: choices([job({ id: 'b', status: 'killed', completedAt: 5 })]),
		}),
	)
	expect(on).not.toMatch(/<button[^>]* disabled=""/)
})
