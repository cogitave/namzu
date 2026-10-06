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
	return renderToStaticMarkup(
		createElement(JobRow, { job, onRead: async () => undefined, onStop: async () => {} }),
	)
}

it('keeps an unconfirmed stop running, shows its safe reason and permits retry', () => {
	const html = render({
		...running,
		recoveryRequired: true,
		stopError: 'The process provider could not confirm the owned job stopped.',
	})
	expect(html).toContain('data-job-status="running"')
	expect(html).toContain('<output')
	expect(html).toContain('could not confirm the owned job stopped')
	expect(html).toContain('aria-label="Retry stop guest server"')
	expect(html).toContain('aria-label="Output for guest server"')
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
	expect(html).toContain('data-job-status="killed"')
	expect(html).not.toContain('<output')
	expect(html).not.toContain('Retry stop')
	expect(html).not.toContain('aria-label="Stop guest server"')
	expect(render(running)).toContain('aria-label="Stop guest server"')
})

it('distinguishes confirmed success, failure and an exit without a success code', () => {
	expect(render({ ...running, status: 'exited', exitCode: 0 })).toContain('>Done</span>')
	expect(render({ ...running, status: 'exited', exitCode: 7 })).toContain('>Failed</span>')
	expect(render({ ...running, status: 'exited' })).toContain('>Finished</span>')
	expect(render({ ...running, status: 'unrecognized' })).toContain('>Status unavailable</span>')
})

it('keeps a full accessible command when the compact visible row truncates it', () => {
	const html = render({ ...running, command: 'node long-process --input <untrusted> & arguments' })
	expect(html).toContain(
		'aria-label="Output for node long-process --input &lt;untrusted&gt; &amp; arguments"',
	)
	expect(html).toContain('class="job-command"')
	expect(html).not.toContain('<untrusted>')
})
