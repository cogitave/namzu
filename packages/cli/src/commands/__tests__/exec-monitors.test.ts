import { describe, expect, it } from 'vitest'

import { createMonitorInbox } from '../../integrations/monitors/inbox.js'
import type { SessionMonitors } from '../../tui/agent.js'
import { watchMonitors } from '../exec-monitors.js'

function monitors(running: { count: number }): {
	session: SessionMonitors
	inbox: ReturnType<typeof createMonitorInbox>
} {
	const inbox = createMonitorInbox()
	const session: SessionMonitors = {
		addEvent: (e) => inbox.addEvent(e),
		addEnd: (j, s) => inbox.addEnd(j, s),
		acknowledge: (ids) => inbox.acknowledge(ids),
		peek: () => inbox.peek(),
		take: () => inbox.take(),
		wakes: () => inbox.wakes(),
		get size() {
			return inbox.size
		},
		onChange: (l) => inbox.onChange(l),
		running: () => running.count,
		stats: () => ({ stdoutChars: 0 }),
	}
	return { session, inbox }
}

const stoppedEnd = {
	id: 'b1',
	owner: 's',
	command: 'tail -f log',
	status: 'killed' as const,
	stopReason: 'stopped' as const,
	startedAt: 0,
	kind: 'monitor' as const,
	description: 'errors',
}

const event = {
	id: 'b1:1',
	jobId: 'b1',
	owner: 's',
	description: 'errors',
	kind: 'output' as const,
	text: 'FAILED',
	at: 1,
	command: 'tail -f log',
}

describe('the single-shot run and its monitors', () => {
	it('has nothing to wait for when no monitor is running and nothing is pending', async () => {
		const { session } = monitors({ count: 0 })
		const report = await watchMonitors(session)?.report({
			signal: new AbortController().signal,
		})
		expect(report).toBeUndefined()
	})

	it('waits for a running monitor to speak, reports it, then ends when none is left', async () => {
		const running = { count: 1 }
		const { session, inbox } = monitors(running)
		const watch = watchMonitors(session)
		const signal = new AbortController().signal
		const first = watch?.report({ signal })
		// Nothing has arrived; the report is still waiting on the registry, not a timer.
		inbox.addEvent(event)
		expect(await first).toContain('Monitor event: "errors"')
		// Delivered once: the monitor then ends with nothing more to say.
		const second = watch?.report({ signal })
		running.count = 0
		inbox.addEnd(
			{
				id: 'b1',
				owner: 's',
				command: 'tail -f log',
				status: 'exited',
				startedAt: 0,
				exitCode: 0,
				kind: 'monitor',
				description: 'errors',
			},
			{ stdoutChars: 6 },
		)
		expect(await second).toContain('stream ended')
		expect(await watch?.report({ signal })).toBeUndefined()
	})

	it('does not report an event the kernel already put in front of the model', async () => {
		const { session, inbox } = monitors({ count: 0 })
		inbox.addEvent(event)
		session.acknowledge([event.id])
		expect(
			await watchMonitors(session)?.report({
				signal: new AbortController().signal,
			}),
		).toBeUndefined()
	})

	it('stops waiting when the process is told to stop', async () => {
		const { session } = monitors({ count: 1 })
		const abort = new AbortController()
		const pending = watchMonitors(session)?.report({ signal: abort.signal })
		abort.abort()
		expect(await pending).toBeUndefined()
	})

	it('does not spend a reporting turn on a stop the operator asked for', async () => {
		const { session, inbox } = monitors({ count: 0 })
		inbox.addEnd(stoppedEnd, { stdoutChars: 0 })
		expect(inbox.size).toBe(1)
		expect(inbox.wakes()).toBe(false)
		expect(
			await watchMonitors(session)?.report({ signal: new AbortController().signal }),
		).toBeUndefined()
		// Not taken: it is told with the next turn, never lost.
		expect(inbox.size).toBe(1)
	})

	it('keeps waiting past a stop, and hands it over with the next real report', async () => {
		const running = { count: 1 }
		const { session, inbox } = monitors(running)
		inbox.addEnd(stoppedEnd, { stdoutChars: 0 })
		const pending = watchMonitors(session)?.report({ signal: new AbortController().signal })
		inbox.addEvent({ ...event, jobId: 'b2', id: 'b2:1', text: 'BOOM' })
		const report = await pending
		expect(report).toContain('BOOM')
		expect(report).toContain('stopped')
		expect(inbox.size).toBe(0)
	})
})
