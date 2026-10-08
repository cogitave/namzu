import { expect, it } from 'vitest'
import { fixtureId } from '../../../test-support/ids.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { toAcpTaskUpdate } from '../tasks.js'

const sessionId = fixtureId.session('active-form-session')
const event = (extra: Record<string, unknown> = {}): SessionEvent =>
	({
		type: 'task_updated',
		sessionId,
		taskId: fixtureId.task('active-form-task'),
		subject: 'Run the tests',
		status: 'in_progress',
		...extra,
	}) as SessionEvent

it('carries the active form a task was given, and nothing when it was given none', () => {
	expect(
		toAcpTaskUpdate(event({ activeForm: 'Running the tests' }), sessionId)?.task,
	).toMatchObject({
		activeForm: 'Running the tests',
	})
	expect(toAcpTaskUpdate(event(), sessionId)?.task).not.toHaveProperty('activeForm')
	expect(toAcpTaskUpdate(event({ activeForm: '' }), sessionId)?.task).not.toHaveProperty(
		'activeForm',
	)
})
