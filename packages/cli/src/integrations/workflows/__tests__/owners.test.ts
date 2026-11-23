import type { SessionId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { WorkflowOwners } from '../owners.js'
import type { WorkflowRunView } from '../view.js'

const run = (runId: string) => ({ runId, status: 'done', endedAt: 5 }) as unknown as WorkflowRunView

describe('workflow owners', () => {
	it('keeps an ended run listed for its owner', () => {
		const owners = new WorkflowOwners()
		owners.set('w1', 's1' as SessionId)
		expect(owners.ownedBy('s1' as SessionId, [run('w1')]).map((r) => r.runId)).toEqual(['w1'])
		expect(owners.ownedBy('s2' as SessionId, [run('w1')])).toEqual([])
	})

	it('forgets a run the registry no longer holds', () => {
		const owners = new WorkflowOwners()
		owners.set('w1', 's1' as SessionId)
		owners.ownedBy('s1' as SessionId, [])
		expect(owners.ownedBy('s1' as SessionId, [run('w1')])).toEqual([])
	})
})
