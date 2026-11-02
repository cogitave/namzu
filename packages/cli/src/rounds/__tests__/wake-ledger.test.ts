import { describe, expect, it } from 'vitest'

import { ORPHAN_NOTICE_PREFIX, WakeLedger } from '../wake-ledger.js'

const owner = { name: 'session' }

function ledger() {
	const wake = new WakeLedger<typeof owner>()
	const jobs = wake.startJobs(owner)
	return { wake, jobs }
}

describe('WakeLedger background commands', () => {
	it('wakes an idle session for a command that ended on its own, not for one the person stopped', () => {
		const { wake, jobs } = ledger()
		expect(wake.wakes(owner, false)).toBe(false)
		wake.noteJobExit(jobs, 'a', 'a stopped', false)
		expect(wake.wakes(owner, false)).toBe(false)
		wake.noteJobExit(jobs, 'b', 'b exited', true)
		expect(wake.wakes(owner, false)).toBe(true)
	})

	it('wakes for a monitor the session reports on', () => {
		const { wake } = ledger()
		expect(wake.wakes(owner, true)).toBe(true)
	})

	it('drops a late event for an exit the kernel already delivered inside a turn', () => {
		const { wake, jobs } = ledger()
		wake.jobNoticesDelivered(owner, ['a'])
		expect(wake.noteJobExit(jobs, 'a', 'a exited', true)).toBe(false)
		expect(wake.snapshot(owner).idleJobs.ids).toEqual([])
	})

	it('keeps news for the session that owns it', () => {
		const { wake, jobs } = ledger()
		wake.noteJobExit(jobs, 'a', 'a exited', true)
		const other = { name: 'other' }
		expect(wake.snapshot(other).idleJobs.ids).toEqual([])
		expect(wake.wakes(other, false)).toBe(false)
		wake.jobNoticesDelivered(other, ['a'])
		expect(wake.snapshot(owner).idleJobs.ids).toEqual(['a'])
	})

	it('paints a row once per command', () => {
		const { wake } = ledger()
		expect(wake.markJobShown('a')).toBe(true)
		expect(wake.markJobShown('a')).toBe(false)
	})

	it('starts empty for a new session', () => {
		const { wake, jobs } = ledger()
		wake.noteJobExit(jobs, 'a', 'a exited', true)
		wake.startJobs({ name: 'next' })
		expect(wake.wakes(owner, false)).toBe(false)
	})
})

describe('WakeLedger exactly-once delivery', () => {
	it('keeps what a turn took pending until the turn completes', () => {
		const { wake, jobs } = ledger()
		wake.noteJobExit(jobs, 'a', 'a exited', true)
		wake.noteWorkflowEnd('run1', 'run 1 ended')
		wake.noteChildMessage('agent said hi')
		wake.noteDirectChild({ context: 'you stopped it', label: 'stopped', kind: 'advisory' })
		const snapshot = wake.snapshot(owner)
		expect(snapshot.idleJobs.text).toBe(
			'Background jobs that ended since your last turn:\n- a exited',
		)
		// The turn threw before the model got it: everything is still waiting.
		expect(wake.snapshot(owner).idleJobs.ids).toEqual(['a'])
		expect(wake.wakes(owner, false)).toBe(true)
		wake.commit(snapshot, owner, true)
		expect(wake.snapshot(owner).idleJobs.ids).toEqual([])
		expect(wake.takeInTurn(wake.snapshot(owner))).toEqual({
			childNotices: [],
			workflowEnds: [],
			childMessages: [],
		})
		expect(wake.wakes(owner, false)).toBe(false)
	})

	it('leaves agent, workflow and message news alone when the conversation changed under the turn', () => {
		const { wake } = ledger()
		wake.noteWorkflowEnd('run1', 'run 1 ended')
		const snapshot = wake.snapshot(owner)
		wake.commit(snapshot, owner, false)
		expect(wake.snapshot(owner).workflows.size).toBe(1)
	})

	it('gives a running turn only news that arrived after its snapshot, once', () => {
		const { wake } = ledger()
		wake.noteWorkflowEnd('early', 'early ended')
		const snapshot = wake.snapshot(owner)
		wake.noteWorkflowEnd('late', 'late ended')
		wake.noteChildMessage('late message')
		const first = wake.takeInTurn(snapshot)
		expect(first.workflowEnds).toEqual([['late', 'late ended']])
		expect(first.childMessages).toEqual([[1, 'late message']])
		expect(wake.takeInTurn(snapshot).workflowEnds).toEqual([])
		// The early one rode the snapshot, so it is committed with the turn.
		wake.commit(snapshot, owner, true)
		expect(wake.wakes(owner, false)).toBe(false)
	})

	it('hands notes about agents to the turn and drops them only when shown', () => {
		const { wake } = ledger()
		const snapshot = wake.snapshot(owner)
		wake.noteDirectChild({ context: 'a', label: 'l', kind: 'advisory' })
		expect(wake.hasUnsnapshottedDirectChild(snapshot)).toBe(true)
		const { childNotices } = wake.takeInTurn(snapshot)
		expect(childNotices).toHaveLength(1)
		expect(wake.hasUnsnapshottedDirectChild(snapshot)).toBe(true)
		wake.dropDirectChild(childNotices.map(([id]) => id))
		expect(wake.hasUnsnapshottedDirectChild(snapshot)).toBe(false)
	})

	it('lets an idle wake take everything at admission, so nothing is said twice', () => {
		const { wake, jobs } = ledger()
		wake.noteJobExit(jobs, 'a', 'a exited', true)
		wake.noteJobExit(jobs, 'b', 'b stopped', false)
		wake.noteWorkflowEnd('run1', 'run 1 ended')
		wake.noteChildMessage('hi')
		const taken = wake.takeForWake(owner)
		expect(taken.ended).toEqual(['run 1 ended', 'hi'])
		expect(taken.jobLines).toEqual([['a', 'a exited']])
		expect(wake.takeForWake(owner)).toEqual({ workflowIds: [], ended: [], jobLines: [] })
		// A late event for the delivered exit is dropped; the stopped one still rides the next turn.
		expect(wake.noteJobExit(jobs, 'a', 'a exited', true)).toBe(false)
		expect(wake.snapshot(owner).idleJobs.ids).toEqual(['b'])
	})
})

describe('WakeLedger unfinished-run notices', () => {
	it('is told with the next turn but never wakes an idle session', () => {
		const wake = new WakeLedger<object>()
		wake.noteWorkflowEnd(`${ORPHAN_NOTICE_PREFIX}run_1`, 'run_1 was left unfinished')
		expect(wake.wakes(null, false)).toBe(false)
		wake.noteWorkflowEnd('resume:run_1', 'resume it')
		expect(wake.wakes(null, false)).toBe(true)
		const taken = wake.takeForWake(null)
		expect(taken.workflowIds).toEqual([`${ORPHAN_NOTICE_PREFIX}run_1`, 'resume:run_1'])
		expect(taken.ended).toEqual(['run_1 was left unfinished', 'resume it'])
	})
})
