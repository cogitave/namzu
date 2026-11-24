import { describe, expect, it } from 'vitest'

import type { TeamMemberView, TeamTaskView } from '../integrations/teams/view.js'
import {
	TEAM_IDLE_FADE_MS,
	TEAM_STOPPED_LINGER_MS,
	TEAM_STOP_CONFIRM_MS,
	foldedIdleText,
	idleRowText,
	lastFinishedTask,
	mailBody,
	memberTask,
	parseTeamCommand,
	sameTeamSnapshot,
	sentLabel,
	teamChecklistItems,
	teamNextFade,
	teamRailHint,
	teamRailPlan,
	teamStatusText,
	teamStopStep,
	teamSummaryLines,
	teamTaskLine,
	teamTaskLines,
} from './team-view.js'

const NOW = 1_000_000

function member(name: string, state: TeamMemberView['state'], since = 0): TeamMemberView {
	return { name, viewId: `v-${name}`, state, since }
}

function task(id: string, patch: Partial<TeamTaskView> = {}): TeamTaskView {
	return { id, subject: `task ${id}`, status: 'pending', blockedBy: [], ...patch }
}

describe('which teammates the rail draws', () => {
	it('keeps a working teammate and one waiting for the person, whatever else is idle', () => {
		const plan = teamRailPlan(
			[
				member('a', 'working'),
				member('b', 'waiting'),
				member('c', 'idle', NOW - 10 * TEAM_IDLE_FADE_MS),
			],
			NOW,
		)
		expect([...plan.shown].sort()).toEqual(['v-a', 'v-b', 'v-c'])
		expect(plan.folded).toBe(0)
	})

	it('shows up to three idle teammates one by one and counts more than three in one row', () => {
		const three = ['a', 'b', 'c'].map((n) => member(n, 'idle', NOW - 1000))
		expect(teamRailPlan(three, NOW).shown.size).toBe(3)
		expect(teamRailPlan(three, NOW).folded).toBe(0)
		const four = ['a', 'b', 'c', 'd'].map((n) => member(n, 'idle', NOW - 1000))
		const plan = teamRailPlan(four, NOW)
		expect(plan.shown.size).toBe(0)
		expect(plan.folded).toBe(4)
		expect(foldedIdleText(4)).toBe('4 idle teammates')
	})

	it('drops idle rows only after the whole rail has been idle for 30 seconds', () => {
		const idle = [
			member('a', 'idle', NOW - TEAM_IDLE_FADE_MS + 1),
			member('b', 'idle', NOW - 90_000),
		]
		expect(teamRailPlan(idle, NOW).shown.size).toBe(2)
		const faded = teamRailPlan(idle, NOW + 1)
		expect(faded.shown.size).toBe(0)
		expect(faded.folded).toBe(0)
	})

	it('does not fade idle rows while another agent runs or a teammate works', () => {
		const idle = [member('a', 'idle', NOW - 10 * TEAM_IDLE_FADE_MS)]
		expect(teamRailPlan(idle, NOW, true).shown.size).toBe(1)
		expect(teamRailPlan([...idle, member('b', 'working')], NOW).shown.size).toBe(2)
	})

	it('keeps a stopped teammate for 30 seconds', () => {
		const stopped = [member('a', 'stopped', NOW - TEAM_STOPPED_LINGER_MS + 1)]
		expect(teamRailPlan(stopped, NOW).shown.size).toBe(1)
		expect(teamRailPlan(stopped, NOW + 1).shown.size).toBe(0)
	})

	it('says how long until the next row leaves', () => {
		expect(teamNextFade([member('a', 'working')], NOW)).toBeUndefined()
		expect(teamNextFade([member('a', 'idle', NOW - 5_000)], NOW)).toBe(TEAM_IDLE_FADE_MS - 5_000)
		expect(teamNextFade([member('a', 'idle', NOW - 5_000)], NOW, true)).toBeUndefined()
		expect(teamNextFade([member('a', 'stopped', NOW - 1_000)], NOW)).toBe(
			TEAM_STOPPED_LINGER_MS - 1_000,
		)
	})
})

describe('what a row says', () => {
	it('names the state in plain words, with how long ago for idle and stopped', () => {
		expect(teamStatusText(member('a', 'working'), NOW)).toBe('working')
		expect(teamStatusText(member('a', 'waiting'), NOW)).toBe('waiting for you')
		expect(teamStatusText(member('a', 'idle', NOW - 45_000), NOW)).toBe('idle · 45s')
		expect(teamStatusText(member('a', 'stopped', NOW - 125_000), NOW)).toBe('stopped · 2m')
	})

	it('finds the task a member holds, lowest id first', () => {
		const tasks = [
			task('10', { status: 'in_progress', owner: 'a' }),
			task('2', { status: 'in_progress', owner: 'a', subject: 'second' }),
			task('3', { status: 'in_progress', owner: 'b' }),
			task('4', { status: 'completed', owner: 'a' }),
		]
		expect(memberTask('a', tasks)?.subject).toBe('second')
		expect(memberTask('c', tasks)).toBeUndefined()
	})

	it('finds what a member finished last', () => {
		const tasks = [
			task('1', { status: 'completed', owner: 'a', completedAt: 10 }),
			task('2', { status: 'completed', owner: 'a', completedAt: 30, subject: 'newest' }),
			task('3', { status: 'completed', owner: 'b', completedAt: 99 }),
		]
		expect(lastFinishedTask('a', tasks)?.subject).toBe('newest')
	})
})

describe('lines about mail to a teammate', () => {
	it('words each kind for what it is, not as a correction', () => {
		expect(sentLabel({ kind: 'message', from: 'lead' }, 'one')).toBe('sent to one')
		expect(sentLabel({ kind: 'message', from: 'two' }, 'one')).toBe('two sent to one')
		expect(sentLabel({ kind: 'task', from: 'lead' }, 'one')).toBe('task given to one')
		expect(sentLabel({ kind: 'stop', from: 'lead' }, 'one')).toBe('asked one to stop')
		expect(sentLabel(undefined, 'one')).toBe('correction sent')
	})

	it('leaves out the frame that says whose mail it is', () => {
		expect(
			mailBody('A message from the lead. It comes from another session.\n\nlook at tests'),
		).toBe('look at tests')
		expect(mailBody('A shutdown request from the lead, another.\n\nwrap up')).toBe('wrap up')
		expect(mailBody('Task 3 ("x") was assigned to you')).toBe('Task 3 ("x") was assigned to you')
	})

	it('writes one plain row for an idle teammate', () => {
		expect(idleRowText('one', 'write the parser')).toBe('one is idle · finished write the parser')
		expect(idleRowText('one', undefined)).toBe('one is idle')
		expect(idleRowText('one', '  a\n b ')).toBe('one is idle · finished a b')
	})
})

describe('the team task list', () => {
	const tasks = [
		task('2', { subject: 'test it', blockedBy: ['1'], owner: undefined }),
		task('1', { subject: 'write it', status: 'in_progress', owner: 'one' }),
		task('3', { subject: 'ship it', status: 'completed', owner: 'two', blockedBy: ['1'] }),
	]

	it('lists every task, lowest id first, with owner and blockers', () => {
		const items = teamChecklistItems(tasks)
		expect(items.map((item) => item.id)).toEqual(['1', '2', '3'])
		expect(items[0]).toMatchObject({ owner: 'one', status: 'in_progress' })
		expect(items[1]).toMatchObject({ blockedBy: ['1'] })
	})

	it('shows a task by its place in the list, not by a long id', () => {
		const long = [
			task('01a20eb8-2ffd', { subject: 'second', blockedBy: ['01a20eb8-2fb9'] }),
			task('01a20eb8-2fb9', { subject: 'first' }),
		]
		expect(teamChecklistItems(long)[1]).toMatchObject({ id: '01a20eb8-2ffd', blockedBy: ['1'] })
		expect(teamTaskLines(long)).toEqual([
			'Tasks · 0/2 done',
			'#1 □ first',
			'#2 □ second · waits on #1',
		])
	})

	it('writes plain lines for /team tasks', () => {
		expect(teamTaskLines(tasks)).toEqual([
			'Tasks · 1/3 done',
			'#1 ■ write it · one',
			'#2 □ test it · waits on #1',
			'#3 ✓ ship it · two',
		])
		expect(teamTaskLines([])).toEqual(['The team has no tasks yet.'])
		expect(teamTaskLine(task('7', { subject: 'a\n b' }))).toBe('#7 □ a b')
	})

	it('lists members with state and task for /team', () => {
		const lines = teamSummaryLines(
			[member('one', 'working'), member('alice', 'idle', NOW - 3_000)],
			tasks,
			NOW,
		)
		expect(lines[0]).toBe('one    working · write it')
		expect(lines[1]).toBe('alice  idle · 3s')
		expect(lines.at(-1)).toBe('Tasks · 1/3 done (/team tasks lists them)')
		expect(teamSummaryLines([], [], NOW)[0]).toContain('No teammates yet')
	})
})

describe('/team and the stop key', () => {
	it('reads the keyword grammar', () => {
		expect(parseTeamCommand('')).toEqual({ kind: 'list' })
		expect(parseTeamCommand(' tasks ')).toEqual({ kind: 'tasks' })
		expect(parseTeamCommand('stop one')).toEqual({ kind: 'stop', name: 'one' })
		expect(parseTeamCommand('stop').kind).toBe('usage')
		expect(parseTeamCommand('--tasks').kind).toBe('usage')
	})

	it('asks once, then stops on a second press of the same row inside the window', () => {
		expect(teamStopStep(null, 'a', NOW)).toBe('ask')
		expect(teamStopStep({ viewId: 'a', at: NOW }, 'a', NOW + TEAM_STOP_CONFIRM_MS)).toBe('stop')
		expect(teamStopStep({ viewId: 'a', at: NOW }, 'a', NOW + TEAM_STOP_CONFIRM_MS + 1)).toBe('ask')
		expect(teamStopStep({ viewId: 'a', at: NOW }, 'b', NOW + 1)).toBe('ask')
	})

	it('words the key line for a teammate row', () => {
		expect(teamRailHint('working', 'one', false, false)).toBe('↑↓ select · enter open · x stop')
		expect(teamRailHint('working', 'one', true, false)).toBe(
			'↑↓ select · enter open · x again to stop one',
		)
		expect(teamRailHint('idle', 'one', false, true)).toBe('↑↓ select · x stop')
		expect(teamRailHint('stopped', 'one', false, false)).toBe('↑↓ select · enter open · x clear')
	})
})

it('treats two equal snapshots as one, so the screen redraws only for a change', () => {
	const a = { members: [member('a', 'idle', 1)], tasks: [task('1')] }
	expect(sameTeamSnapshot(a, { members: [member('a', 'idle', 1)], tasks: [task('1')] })).toBe(true)
	expect(sameTeamSnapshot(a, { members: [member('a', 'working', 0)], tasks: [task('1')] })).toBe(
		false,
	)
	expect(sameTeamSnapshot(a, { members: a.members, tasks: [task('1', { owner: 'x' })] })).toBe(
		false,
	)
})
