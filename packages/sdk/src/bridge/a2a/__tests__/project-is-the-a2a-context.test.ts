import { describe, expect, it } from 'vitest'

import type { WireRun } from '../../../contracts/api.js'
import { fixtureId } from '../../../test-support/ids.js'
import { a2aMessageToCreateRun, runToA2ATask } from '../task.js'

/**
 * A2A's `contextId` is namzu's **Project**, and this pins it.
 *
 * The docs of record said the opposite for a long time: `a2a-threading.md`
 * opened with "A2A connections attach at the Thread level, not the Project
 * level" and called that the reason the Thread layer is first-class. The code
 * never did it. `runToA2ATask` has always bound `contextId` to `project_id`,
 * `a2aParamsToRunRequest` has always read it back as `projectId`, and
 * `TopicId` appears nowhere in this bridge.
 *
 * That gap is why this test exists rather than a comment. The claim was load-
 * bearing — it was the single justification for a whole hierarchy level — and
 * it survived for months because nothing asserted the actual binding. An
 * unasserted invariant is a belief, and beliefs are what the prose was made of.
 */

function wireRun(overrides: Partial<WireRun> = {}): WireRun {
	return {
		id: 'c5404eb4-58ee-4067-9ae2-8916033f1ceb',
		agent_id: 'worker',
		status: 'completed',
		project_id: 'b27ca023-39ba-4362-b823-1fc8f4460876',
		created_at: new Date('2026-08-06').toISOString(),
		...overrides,
	} as WireRun
}

describe('a2a contextId is the project, in both directions', () => {
	it('maps a run onto a task whose context is its project', () => {
		expect(runToA2ATask(wireRun()).contextId).toBe('b27ca023-39ba-4362-b823-1fc8f4460876')
	})

	it('reads a task context back as the project to run under', () => {
		const request = a2aMessageToCreateRun('worker', {
			contextId: 'bd82be67-36f3-49a2-956b-0e1dd68ed6c9',
			message: { role: 'user', parts: [{ kind: 'text', text: 'go' }] },
		} as never)

		expect(request.projectId).toBe('bd82be67-36f3-49a2-956b-0e1dd68ed6c9')
	})

	it('round-trips, so a peer context names a project namzu can run under', () => {
		// The property an interoperating peer actually depends on: the context
		// it was handed is the context it can send back.
		const task = runToA2ATask(
			wireRun({ project_id: fixtureId.project('gamma') } as Partial<WireRun>),
		)
		const request = a2aMessageToCreateRun('worker', {
			contextId: task.contextId,
			message: { role: 'user', parts: [{ kind: 'text', text: 'again' }] },
		} as never)

		expect(request.projectId).toBe('78de783b-4b7a-441f-a4dd-e5265257e5fc')
	})

	it('leaves the context absent when a run has no project', () => {
		// Absent rather than an empty string: a peer must be able to tell "no
		// context" from "a context named nothing".
		expect(
			runToA2ATask(wireRun({ project_id: undefined } as Partial<WireRun>)).contextId,
		).toBeUndefined()
	})
})
