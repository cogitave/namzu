import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { JobView } from '../shared/protocol.js'
import { JobRow } from './job-row.js'

const running: JobView = {
	id: 'owned-job',
	command: 'guest server',
	status: 'running',
	startedAt: 1,
}
function render(job: JobView): string {
	return renderToStaticMarkup(createElement(JobRow, { job, onRead: () => {}, onStop: () => {} }))
}

it('keeps an unconfirmed stop running, shows its safe reason and permits retry', () => {
	const html = render({
		...running,
		recoveryRequired: true,
		stopError: 'The process provider could not confirm the owned job stopped.',
	})
	expect(html).toContain('<strong>running</strong>')
	expect(html).toContain('<output')
	expect(html).toContain('could not confirm the owned job stopped')
	expect(html).toContain('Retry stop</button>')
	expect(html).toContain('View output</button>')
})

it('renders diagnostics as text and supplies a recovery reason when missing', () => {
	expect(render({ ...running, recoveryRequired: true })).toContain(
		'Stopping this job has not been confirmed.',
	)
	const html = render({
		...running,
		recoveryRequired: true,
		stopError: '<script>unsafe diagnostic</script>',
	})
	expect(html).toContain('&lt;script&gt;unsafe diagnostic&lt;/script&gt;')
	expect(html).not.toContain('<script>')
})

it('removes recovery and stop controls after termination is confirmed', () => {
	const html = render({ ...running, status: 'killed', exitCode: 0 })
	expect(html).toContain('<strong>killed</strong>')
	expect(html).not.toContain('<output')
	expect(html).not.toContain('Retry stop')
	expect(html).not.toContain('Stop</button>')
	expect(render(running)).toContain('Stop</button>')
})
