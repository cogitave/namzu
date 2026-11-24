import { describe, expect, it } from 'vitest'

import type { TeamMemberView, TeamTaskView } from '../integrations/teams/view.js'
import {
	TEAM_BADGE_WIDTH,
	TEAM_FOLDED_HINT,
	TEAM_IDLE_FADE_MS,
	TEAM_STOPPED_LINGER_MS,
	TEAM_STOP_CONFIRM_MS,
	TEAM_VIEW_ESC_HINT,
	foldedIdleText,
	lastFinishedTask,
	mailBody,
	memberTask,
	parseTeamCommand,
	sameTeamSnapshot,
	teamChecklistItems,
	teamNextFade,
	teamPromptBadge,
	teamRailHint,
	teamRailPlan,
	teamStatusText,
	teamStopStep,
	teamSummaryLines,
	teamTaskLine,
	teamTaskLines,
	teamTaskRowCap,
	teamTaskWindow,
	teamTasksHeading,
	teamTasksOverflow,
} from './team-view.js'

const NOW = 1_000_000

function member(name: string, state: TeamMemberView['state'], since = 0): TeamMemberView {
	return { name, viewId: `v-${name}`, state, color: 'blue', since }
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
		expect(foldedIdleText(4)).toBe('4 idle agents')
	})

	it('leaves the teammate on screen out of the folded count, since it has its own row', () => {
		const four = ['a', 'b', 'c', 'd'].map((n) => member(n, 'idle', NOW - 1000))
		const plan = teamRailPlan(four, NOW, false, false, 'v-d')
		expect([...plan.shown]).toEqual(['v-d'])
		expect(plan.folded).toBe(3)
		expect(teamRailPlan(four, NOW, false, false, 'v-zzz').folded).toBe(4)
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
	it('leaves out the frame that says whose mail it is', () => {
		expect(
			mailBody('A message from the lead. It comes from another session.\n\nlook at tests'),
		).toBe('look at tests')
		expect(mailBody('A shutdown request from the lead, another.\n\nwrap up')).toBe('wrap up')
		expect(mailBody('Task 3 ("x") was assigned to you')).toBe('Task 3 ("x") was assigned to you')
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
			'0/2 tasks done',
			'#1 □ first',
			'#2 □ second › blocked by #1',
		])
	})

	it('writes plain lines for /team tasks', () => {
		expect(teamTaskLines(tasks)).toEqual([
			'1/3 tasks done · 1 in progress',
			'#1 ■ write it (@one)',
			'#2 □ test it › blocked by #1',
			'#3 ✓ ship it (@two)',
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
		expect(lines.at(-1)).toBe('1/3 tasks done · 1 in progress (/team tasks lists them)')
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
		expect(teamRailHint('working', 'one', false, false)).toBe(
			'↑/↓ to select · enter to view · x to stop · esc to collapse',
		)
		expect(teamRailHint('working', 'one', true, false)).toBe(
			'↑/↓ to select · enter to view · x again to stop one · esc to collapse',
		)
		expect(teamRailHint('idle', 'one', false, true)).toBe(
			'↑/↓ to select · x to stop · esc to collapse',
		)
		expect(teamRailHint('stopped', 'one', false, false)).toBe(
			'↑/↓ to select · enter to view · x to clear · esc to collapse',
		)
		expect(TEAM_FOLDED_HINT).toBe('↑/↓ to select · enter to expand · esc to collapse')
	})

	it('says what Esc does in a teammate transcript, and cuts the name on the prompt', () => {
		expect(TEAM_VIEW_ESC_HINT).toBe('esc to return to team lead')
		expect(teamPromptBadge('one')).toBe('@one')
		const long = teamPromptBadge('a'.repeat(40))
		expect([...long]).toHaveLength(TEAM_BADGE_WIDTH)
		expect(long.endsWith('…')).toBe(true)
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

describe('the task block of a team', () => {
	const many = [
		task('1', { status: 'completed' }),
		task('2', { status: 'completed' }),
		task('3', { status: 'in_progress', owner: 'one' }),
		task('4'),
		task('5'),
		task('6', { status: 'completed' }),
		task('7'),
	]

	it('heads the block with the count and what is in progress', () => {
		expect(teamTasksHeading(many)).toBe('3/7 tasks done · 1 in progress')
		expect(teamTasksHeading([task('1')])).toBe('0/1 tasks done')
		expect(teamTasksHeading([task('1', { status: 'failed' })])).toBe('0/1 tasks done · 1 failed')
	})

	it('takes as many rows as the terminal leaves, between three and five, none on a short one', () => {
		expect(teamTaskRowCap(10)).toBe(0)
		expect(teamTaskRowCap(16)).toBe(3)
		expect(teamTaskRowCap(18)).toBe(4)
		expect(teamTaskRowCap(60)).toBe(5)
	})

	it('shows the working and open tasks first and counts the rest in one line', () => {
		expect(teamTasksOverflow(many)).toBe('7 tasks (1 in progress, 3 open, 3 done)')
		const window = teamTaskWindow(many, 4)
		expect(window.shown.map((item) => item.id)).toEqual(['3', '4', '5'])
		expect(window.overflow).toBe('7 tasks (1 in progress, 3 open, 3 done)')
		expect(teamTaskWindow(many.slice(0, 3), 4)).toEqual({ shown: many.slice(0, 3) })
		expect(teamTaskWindow(many, 0)).toEqual({
			shown: [],
			overflow: '7 tasks (1 in progress, 3 open, 3 done)',
		})
	})

	it('hands the owner its teammate colour', () => {
		const items = teamChecklistItems(many, (name) => (name === 'one' ? 'green' : undefined))
		expect(items.find((item) => item.id === '3')).toMatchObject({
			owner: 'one',
			ownerColor: 'green',
		})
		expect(items.find((item) => item.id === '4')).not.toHaveProperty('ownerColor')
	})
})
