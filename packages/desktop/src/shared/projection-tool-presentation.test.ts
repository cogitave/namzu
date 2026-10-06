import type { AcpSessionUpdate } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread, restoreMessages } from './projection.js'

type ToolUpdate = Extract<AcpSessionUpdate, { kind: 'tool_call' }>
function update(thread: ThreadState, tool: ToolUpdate, revision?: number): ThreadState {
	return applyEvent(thread, {
		kind: 'update',
		projectId: 'project',
		sessionId: 'session',
		update: tool,
		...(revision === undefined ? {} : { revision }),
	})
}
const call: ToolUpdate = {
	kind: 'tool_call',
	toolCallId: 'task',
	title: 'task_create',
	status: 'pending',
	view: { kind: 'generic', presentation: 'activity', label: 'Add task · Verify output' },
}

it('retains the admitted caption through progress and a hidden receipt without changing the result view or order', () => {
	let thread = update(emptyThread(), call)
	const timeline = thread.timeline
	thread = update(thread, {
		...call,
		view: { kind: 'generic', label: 'task_create' },
		progress: { message: 'Saving' },
	})
	expect(thread.tools['0:task']?.view).toBe(call.view)
	const completion: ToolUpdate = {
		...call,
		status: 'completed',
		view: { kind: 'generic', label: '', visibility: 'hidden' },
	}
	thread = update(thread, completion)
	expect(thread.tools['0:task']?.callView).toBe(call.view)
	expect(thread.tools['0:task']?.view).toBe(completion.view)
	expect(thread.tools['0:task']?.progress).toBeUndefined()
	expect(thread.timeline).toBe(timeline)
	expect(call).not.toHaveProperty('callView')
	expect(completion).not.toHaveProperty('callView')
})

it('does not treat a progress placeholder or a completion-only legacy record as an admitted call caption', () => {
	let thread = update(emptyThread(), {
		...call,
		view: { kind: 'generic', label: 'task_create' },
		progress: { message: 'Starting' },
	})
	expect(thread.tools['0:task']?.callView).toBeUndefined()
	thread = update(thread, call)
	expect(thread.tools['0:task']?.callView).toBe(call.view)
	const legacy = update(emptyThread(), { ...call, status: 'completed' })
	expect(legacy.tools['0:task']?.callView).toBeUndefined()
})

it('retains failure evidence verbatim and does not accept an incoming private caption field', () => {
	const failure = {
		...call,
		status: 'failed' as const,
		view: { kind: 'generic' as const, label: 'The task was not added' },
		callView: { kind: 'generic' as const, label: 'Forged previous action' },
	}
	const completedOnly = update(emptyThread(), failure)
	expect(completedOnly.tools['0:task']?.callView).toBeUndefined()
	const thread = update(update(emptyThread(), call), failure)
	expect(thread.tools['0:task']?.callView).toBe(call.view)
	expect(thread.tools['0:task']?.view).toBe(failure.view)
})

it('isolates reused tool ids across turns, ignores stale revisions, and clears captions with cold text history', () => {
	let thread = update(emptyThread(), call, 2)
	thread = update(thread, { ...call, view: { kind: 'generic', label: 'Stale caption' } }, 1)
	expect(thread.tools['0:task']?.callView).toBe(call.view)
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 'session', prompt: 'Next turn' })
	const next = { ...call, view: { kind: 'generic' as const, label: 'Add task · Next output' } }
	thread = update(thread, next)
	expect(thread.tools['1:task']?.callView).toBe(next.view)
	expect(thread.tools['0:task']?.callView).toBe(call.view)
	expect(restoreMessages(thread, [{ role: 'user', text: 'Saved text' }]).tools).toEqual({})
})
