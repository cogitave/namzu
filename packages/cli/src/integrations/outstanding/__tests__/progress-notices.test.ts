import { describe, expect, it } from 'vitest'

import { initialRunView, reduceRunView } from '../../workflows/view.js'
import type { JobFact } from '../collect.js'
import {
	CHECK_INS_PER_SILENCE,
	CHECK_IN_FIRST_MS,
	CLOCK_JUMP_MS,
	GONE_CONFIRM_MS,
	PHASE_NOTE_KEY_PREFIX,
	createProgressNotices,
	describePendingWorkflowNotices,
	dropPhaseNotes,
	noticesWakeASession,
} from '../progress-notices.js'

const T0 = 1_000_000

const job = (over: Partial<JobFact> = {}): JobFact => ({
	id: 'b1',
	command: 'npm test',
	status: 'running',
	startedAt: T0,
	alive: true,
	...over,
})

/** A run with one agent per phase index given, each running. */
function runIn(phaseIndexes: readonly number[]) {
	let view = initialRunView({
		runId: 'w12345678',
		name: 'audit',
		description: 'd',
		phases: [{ title: 'Scan' }, { title: 'Fix' }, { title: 'Verify' }],
		at: T0,
	})
	for (const phaseIndex of phaseIndexes) {
		view = reduceRunView(view, {
			type: 'workflow_agent',
			runId: 'w12345678',
			index: phaseIndex,
			label: `agent-${phaseIndex}`,
			phaseIndex,
			phaseTitle: ['', 'Scan', 'Fix', 'Verify'][phaseIndex],
			state: 'progress',
			queuedAt: T0,
			startedAt: T0 + 1_000,
			tokens: 0,
			toolCalls: 0,
			promptPreview: 'p',
		} as never)
	}
	return view
}

const facts = (now: number, over: Partial<Parameters<ReturnType<typeof look>>[0]> = {}) => ({
	now,
	jobs: [],
	agents: [],
	workflows: [],
	...over,
})
const look = () => createProgressNotices().look

const lastLook = new WeakMap<object, number>()
/**
 * Look the way the terminal does, every ten seconds, up to `f.now`: a single
 * leap of minutes would read as a suspended host. Returns everything said on the way.
 */
function steady(notices: ReturnType<typeof createProgressNotices>, f: ReturnType<typeof facts>) {
	const out: ReturnType<typeof notices.look>[number][] = []
	let at = lastLook.get(notices)
	if (at === undefined) at = f.now
	else
		while (at + 10_000 < f.now) {
			at += 10_000
			out.push(...notices.look({ ...f, now: at }))
		}
	lastLook.set(notices, f.now)
	out.push(...notices.look(f))
	return out
}

describe('a workflow phase note', () => {
	it('is written when a run moves to a later phase, and never for the phase it was first seen in', () => {
		const notices = createProgressNotices()
		expect(notices.look(facts(T0, { workflows: [runIn([1])] }))).toEqual([])
		expect(notices.look(facts(T0 + 5_000, { workflows: [runIn([1])] }))).toEqual([])
		const [note, ...rest] = notices.look(facts(T0 + 9_000, { workflows: [runIn([1, 2])] }))
		expect(rest).toEqual([])
		expect(note?.wakes).toBe(false)
		expect(note?.key).toBe(`${PHASE_NOTE_KEY_PREFIX}w12345678:2`)
		expect(note?.text).toContain('Workflow "audit" (w12345678) moved on to phase 2/3 "Fix"')
		expect(note?.text).toContain('not a result')
		// Told once.
		expect(notices.look(facts(T0 + 10_000, { workflows: [runIn([1, 2])] }))).toEqual([])
	})

	it('does not go back when a later phase finishes before an earlier one', () => {
		const notices = createProgressNotices()
		notices.look(facts(T0, { workflows: [runIn([2])] }))
		expect(notices.look(facts(T0 + 1_000, { workflows: [runIn([1])] }))).toEqual([])
	})
})

describe('a quiet-job check-in', () => {
	it('first speaks after the silence threshold and backs off after that', () => {
		const notices = createProgressNotices()
		const gaps: number[] = []
		const j = job({ lastOutputAt: T0, lastOutputLine: 'compiling' })
		expect(notices.look(facts(T0 + 1_000, { jobs: [j] }))).toEqual([])
		let now = T0
		for (let tick = 0; tick < 400 && gaps.length < CHECK_INS_PER_SILENCE; tick++) {
			now += 10_000
			const out = notices.look(facts(now, { jobs: [j] }))
			if (out.length > 0) gaps.push(now - T0)
		}
		// Silence of two, four, eight and sixteen minutes.
		expect(gaps).toEqual([
			CHECK_IN_FIRST_MS,
			CHECK_IN_FIRST_MS * 2,
			CHECK_IN_FIRST_MS * 4,
			CHECK_IN_FIRST_MS * 8,
		])
	})

	it('names the job, asks for a read and a process check, and says it is not a completion', () => {
		const notices = createProgressNotices()
		const j = job({ lastOutputAt: T0, lastOutputLine: 'compiling <b>' })
		steady(notices, facts(T0 + 1_000, { jobs: [j] }))
		const [note] = steady(notices, facts(T0 + CHECK_IN_FIRST_MS, { jobs: [j] }))
		expect(note?.wakes).toBe(true)
		expect(note?.text).toContain('Check-in, not a completion')
		expect(note?.text).toContain('printed nothing for 2m 00s')
		expect(note?.text).toContain('job {"action":"read","id":"b1"}')
		expect(note?.text).toContain('If it is stuck, stop it')
		expect(note?.text).toContain('meant to keep running')
		// Free text from the command stays inert.
		expect(note?.text).not.toContain('<b>')
		expect(note?.text).toContain('at: compiling')
	})

	it('starts counting again when the job prints something', () => {
		const notices = createProgressNotices()
		steady(notices, facts(T0, { jobs: [job({ lastOutputAt: T0 })] }))
		expect(
			steady(notices, facts(T0 + CHECK_IN_FIRST_MS, { jobs: [job({ lastOutputAt: T0 })] })),
		).toHaveLength(1)
		// New output at +130 s: the next check-in is a full first interval after it.
		const printed = job({ lastOutputAt: T0 + 130_000 })
		expect(
			steady(notices, facts(T0 + 130_000 + CHECK_IN_FIRST_MS - 1_000, { jobs: [printed] })).filter(
				(n) => !n.retired,
			),
		).toEqual([])
		expect(
			steady(notices, facts(T0 + 130_000 + CHECK_IN_FIRST_MS, { jobs: [printed] })),
		).toHaveLength(1)
	})

	it('stops asking after a few check-ins in one stretch of silence, and asks again after output', () => {
		const notices = createProgressNotices()
		const j = job({ lastOutputAt: T0 })
		steady(notices, facts(T0, { jobs: [j] }))
		let sent = 0
		for (let now = T0; now < T0 + 6 * 3_600_000; now += 30_000) {
			sent += steady(notices, facts(now, { jobs: [j] })).filter((n) => !n.retired).length
		}
		expect(sent).toBe(CHECK_INS_PER_SILENCE)
		const printed = job({ lastOutputAt: T0 + 6 * 3_600_000 })
		const at = T0 + 6 * 3_600_000 + CHECK_IN_FIRST_MS
		expect(
			steady(notices, facts(at - 1_000, { jobs: [printed] })).filter((n) => !n.retired),
		).toEqual([])
		expect(steady(notices, facts(at, { jobs: [printed] })).filter((n) => !n.retired)).toHaveLength(
			1,
		)
	})

	it('withdraws an unread check-in when the job prints or ends', () => {
		const notices = createProgressNotices()
		steady(notices, facts(T0, { jobs: [job({ lastOutputAt: T0 })] }))
		const [sent] = steady(
			notices,
			facts(T0 + CHECK_IN_FIRST_MS, { jobs: [job({ lastOutputAt: T0 })] }),
		)
		const afterOutput = steady(
			notices,
			facts(T0 + CHECK_IN_FIRST_MS + 1_000, {
				jobs: [job({ lastOutputAt: T0 + CHECK_IN_FIRST_MS })],
			}),
		)
		expect(afterOutput).toEqual([{ key: sent?.key, text: '', wakes: false, retired: true }])
		const [second] = steady(
			notices,
			facts(T0 + 2 * CHECK_IN_FIRST_MS + 2_000, {
				jobs: [job({ lastOutputAt: T0 + CHECK_IN_FIRST_MS })],
			}),
		)
		const afterEnd = steady(notices, facts(T0 + 3 * CHECK_IN_FIRST_MS, { jobs: [] }))
		expect(afterEnd).toEqual([{ key: second?.key, text: '', wakes: false, retired: true }])
	})

	it('starts the silence over when the host was suspended, instead of reading hours of quiet', () => {
		const notices = createProgressNotices()
		const j = job({ lastOutputAt: T0 })
		notices.look(facts(T0 + 10_000, { jobs: [j] }))
		const woke = T0 + 10_000 + CLOCK_JUMP_MS + 5 * 3_600_000
		expect(notices.look(facts(woke, { jobs: [j] }))).toEqual([])
		lastLook.set(notices, woke)
		expect(steady(notices, facts(woke + CHECK_IN_FIRST_MS - 1_000, { jobs: [j] }))).toEqual([])
		expect(steady(notices, facts(woke + CHECK_IN_FIRST_MS, { jobs: [j] }))).toHaveLength(1)
	})

	it('calls a job gone only after the probe failed on two looks, and does not tell the model to rerun it', () => {
		const notices = createProgressNotices()
		const gone = job({ alive: false })
		notices.look(facts(T0, { jobs: [job()] }))
		expect(notices.look(facts(T0 + 5_000, { jobs: [gone] }))).toEqual([])
		const [note] = notices.look(facts(T0 + 5_000 + GONE_CONFIRM_MS, { jobs: [gone] }))
		expect(note?.text).toContain('its process is gone')
		expect(note?.text).toContain('has not been told how it ended')
		expect(note?.text).toContain('do not run it again and do not say it failed')
		expect(note?.text).not.toContain('offer to run it again')
		expect(notices.look(facts(T0 + 9_000, { jobs: [gone] }))).toEqual([])
	})

	it('withdraws the gone message when the probe answers again', () => {
		const notices = createProgressNotices()
		const gone = job({ alive: false })
		notices.look(facts(T0, { jobs: [gone] }))
		const [note] = notices.look(facts(T0 + 1_000, { jobs: [gone] }))
		expect(notices.look(facts(T0 + 2_000, { jobs: [job()] }))).toEqual([
			{ key: note?.key, text: '', wakes: false, retired: true },
		])
	})

	it('leaves monitors, ended jobs and a job that prints often alone', () => {
		const notices = createProgressNotices()
		notices.look(facts(T0, { jobs: [] }))
		const quiet = facts(T0 + 10 * CHECK_IN_FIRST_MS, {
			jobs: [
				job({ id: 'm1', kind: 'monitor', command: 'tail -f x' }),
				job({ id: 'b2', status: 'exited' }),
				job({ id: 'b3', lastOutputAt: T0 + 10 * CHECK_IN_FIRST_MS - 1_000 }),
			],
		})
		expect(notices.look(quiet)).toEqual([])
	})
})

describe('the pending messages of a terminal', () => {
	it('wake an idle session for anything but a phase note', () => {
		const pending = new Map<string, string>([[`${PHASE_NOTE_KEY_PREFIX}w1:2`, 'phase']])
		expect(noticesWakeASession(pending)).toBe(false)
		pending.set('w1', 'ended')
		expect(noticesWakeASession(pending)).toBe(true)
	})

	it('drop a run’s phase notes when it ends', () => {
		const pending = new Map<string, string>([
			[`${PHASE_NOTE_KEY_PREFIX}w1:2`, 'a'],
			[`${PHASE_NOTE_KEY_PREFIX}w1:3`, 'b'],
			[`${PHASE_NOTE_KEY_PREFIX}w2:2`, 'c'],
		])
		dropPhaseNotes(pending, 'w1')
		expect([...pending.values()]).toEqual(['c'])
	})

	it('describe ended runs and progress notes under their own headings', () => {
		const text = describePendingWorkflowNotices(
			new Map([
				['w1', 'Workflow "a" (w1) completed.'],
				[`${PHASE_NOTE_KEY_PREFIX}w2:2`, 'moved on'],
			]),
		)
		expect(text).toContain(
			'Workflows that ended since your last turn:\n\nWorkflow "a" (w1) completed.',
		)
		expect(text).toContain('Progress notes on running work since your last turn:\n\nmoved on')
		expect(describePendingWorkflowNotices(new Map())).toBeUndefined()
	})
})
