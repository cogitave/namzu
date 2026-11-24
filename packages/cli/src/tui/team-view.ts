/**
 * The team on the terminal, as plain data and plain words.
 *
 * With teams on, each teammate is a row of the agents rail under the prompt: its name, what it is
 * doing (working, idle, waiting for you, stopped) and the task it holds. Idle rows go away once the
 * whole rail has been idle for a while, and more than three idle teammates are one row that counts
 * them. The lead's screen also says, in a line each, what was sent to a teammate and when one goes
 * idle. Nothing here draws or reads the screen; `AgentExplorer.tsx` and `App.tsx` do.
 */

import type { SubagentMailLabel } from '../integrations/subagents/activity.js'
import type { TeamMemberState, TeamMemberView, TeamTaskView } from '../integrations/teams/view.js'
import type { ChecklistItem } from './Checklist.js'

/** How long the whole rail must have been idle before idle teammates leave it. */
export const TEAM_IDLE_FADE_MS = 30_000
/** More idle teammates than this collapse into one row that counts them. */
export const TEAM_IDLE_FOLD_OVER = 3
/** How long a stopped teammate stays listed, so the person sees how it ended. */
export const TEAM_STOPPED_LINGER_MS = 30_000
/** The second press of `x` must follow the first within this long. */
export const TEAM_STOP_CONFIRM_MS = 3_000

/** The word for a state, as the rail and `/team` say it. */
export function teamStateWord(state: TeamMemberState): string {
	switch (state) {
		case 'working':
			return 'working'
		case 'idle':
			return 'idle'
		case 'waiting':
			return 'waiting for you'
		case 'stopped':
			return 'stopped'
	}
}

/** Which members get a row of their own, and how many idle ones are counted in a single row instead. */
export interface TeamRailPlan {
	/** View ids of the members drawn as rows. */
	readonly shown: ReadonlySet<string>
	/** Idle members folded into one `N idle teammates` row; 0 when none is. */
	readonly folded: number
}

/**
 * What the rail draws of the team now.
 *
 * - A working teammate, and one waiting for the person, always has its row.
 * - A stopped one keeps its row for {@link TEAM_STOPPED_LINGER_MS}.
 * - Idle ones: once the whole rail is idle (nobody on the team works, and no other agent runs) for
 *   {@link TEAM_IDLE_FADE_MS}, they leave; before that, up to {@link TEAM_IDLE_FOLD_OVER} keep a row
 *   each and more than that are one counted row.
 */
export function teamRailPlan(
	members: readonly TeamMemberView[],
	now: number,
	/** Another agent or a workflow is running: the rail is not idle however quiet the team is. */
	othersBusy = false,
): TeamRailPlan {
	const shown = new Set<string>()
	const idle: TeamMemberView[] = []
	let anyActive = false
	for (const member of members) {
		if (member.state === 'working' || member.state === 'waiting') {
			anyActive = true
			shown.add(member.viewId)
		} else if (member.state === 'stopped') {
			if (now - member.since < TEAM_STOPPED_LINGER_MS) shown.add(member.viewId)
		} else idle.push(member)
	}
	if (idle.length === 0) return { shown, folded: 0 }
	const restIdleSince = Math.max(...idle.map((member) => member.since))
	if (!anyActive && !othersBusy && now - restIdleSince >= TEAM_IDLE_FADE_MS)
		return { shown, folded: 0 }
	if (idle.length > TEAM_IDLE_FOLD_OVER) return { shown, folded: idle.length }
	for (const member of idle) shown.add(member.viewId)
	return { shown, folded: 0 }
}

/** Milliseconds until a row leaves the rail by itself (idle fade, stopped linger), or undefined when none will. */
export function teamNextFade(
	members: readonly TeamMemberView[],
	now: number,
	othersBusy = false,
): number | undefined {
	let soonest: number | undefined
	const take = (wait: number) => {
		if (wait > 0 && (soonest === undefined || wait < soonest)) soonest = wait
	}
	const idle = members.filter((member) => member.state === 'idle')
	const anyActive = members.some(
		(member) => member.state === 'working' || member.state === 'waiting',
	)
	if (idle.length > 0 && !anyActive && !othersBusy)
		take(Math.max(...idle.map((member) => member.since)) + TEAM_IDLE_FADE_MS - now)
	for (const member of members)
		if (member.state === 'stopped') take(member.since + TEAM_STOPPED_LINGER_MS - now)
	return soonest
}

/** The members by view id, for the rail to look a row up. */
export function teamByView(
	members: readonly TeamMemberView[],
): ReadonlyMap<string, TeamMemberView> {
	return new Map(members.map((member) => [member.viewId, member]))
}

/** The task a member is on now: the one in progress under its name, lowest id first. */
export function memberTask(name: string, tasks: readonly TeamTaskView[]): TeamTaskView | undefined {
	const mine = tasks.filter((task) => task.status === 'in_progress' && task.owner === name)
	return [...mine].sort(byId)[0]
}

function byId(a: TeamTaskView, b: TeamTaskView): number {
	const left = Number(a.id)
	const right = Number(b.id)
	if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function seconds(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	if (total < 60) return `${total}s`
	const minutes = Math.floor(total / 60)
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

/** The right-hand block of a teammate's row: its state, and for an idle or stopped one how long ago. */
export function teamStatusText(member: TeamMemberView, now: number): string {
	const word = teamStateWord(member.state)
	if ((member.state === 'idle' || member.state === 'stopped') && member.since > 0)
		return `${word} · ${seconds(now - member.since)}`
	return word
}

/** The words after the name on a row: the task it holds, or nothing while it has none. */
export function teamTaskText(member: TeamMemberView, tasks: readonly TeamTaskView[]): string {
	return memberTask(member.name, tasks)?.subject ?? ''
}

/** The dim row that stands for the idle teammates folded away. */
export function foldedIdleText(count: number): string {
	return `${count} idle teammates`
}

/**
 * What a message the lead's screen mirrors is called: `sent to one`, `task given to one`,
 * `asked one to stop`, and for one teammate writing to another `one sent to two`.
 */
export function sentLabel(mail: SubagentMailLabel | undefined, to: string): string {
	if (mail === undefined) return 'correction sent'
	if (mail.kind === 'task') return `task given to ${to}`
	if (mail.kind === 'stop') return `asked ${to} to stop`
	return mail.from === 'lead' ? `sent to ${to}` : `${mail.from} sent to ${to}`
}

/** The one plain row for a teammate that went idle: `one is idle · finished <task>`. */
export function idleRowText(name: string, finished: string | undefined): string {
	const task = finished?.replace(/\s+/gu, ' ').trim()
	return task ? `${name} is idle · finished ${task}` : `${name} is idle`
}

/**
 * The number a task is shown under: its place in the list, lowest id first, from 1. Task ids can be
 * long, and a screen says `#2`, not a UUID.
 */
export function taskNumbers(tasks: readonly TeamTaskView[]): ReadonlyMap<string, number> {
	return new Map([...tasks].sort(byId).map((task, index) => [task.id, index + 1]))
}

/** The task list as the checklist draws it: all tasks, lowest id first, with owner and blockers by number. */
export function teamChecklistItems(tasks: readonly TeamTaskView[]): readonly ChecklistItem[] {
	const numbers = taskNumbers(tasks)
	return [...tasks].sort(byId).map((task) => ({
		id: task.id,
		subject: task.subject,
		status: task.status,
		...(task.blockedBy.length > 0
			? { blockedBy: task.blockedBy.map((id) => String(numbers.get(id) ?? id)) }
			: {}),
		...(task.owner !== undefined ? { owner: task.owner } : {}),
	}))
}

const MARK: Record<TeamTaskView['status'], string> = {
	pending: '□',
	in_progress: '■',
	completed: '✓',
	failed: '✗',
}

/** One task as a line of plain text: `#2 ■ subject · one · waits on #1`. */
export function teamTaskLine(
	task: TeamTaskView,
	numbers: ReadonlyMap<string, number> = new Map(),
): string {
	const number = (id: string): string => `#${numbers.get(id) ?? id}`
	const parts = [
		`${number(task.id)} ${MARK[task.status]} ${task.subject.replace(/\s+/gu, ' ').trim()}`,
	]
	if (task.owner !== undefined) parts.push(task.owner)
	if (task.blockedBy.length > 0 && task.status !== 'completed')
		parts.push(`waits on ${task.blockedBy.map(number).join(', ')}`)
	return parts.join(' · ')
}

/** The lines `/team tasks` writes. */
export function teamTaskLines(tasks: readonly TeamTaskView[]): readonly string[] {
	if (tasks.length === 0) return ['The team has no tasks yet.']
	const done = tasks.filter((task) => task.status === 'completed').length
	const numbers = taskNumbers(tasks)
	return [
		`Tasks · ${done}/${tasks.length} done`,
		...[...tasks].sort(byId).map((task) => teamTaskLine(task, numbers)),
	]
}

/** The lines `/team` writes: every member with its state and task, then the task counts. */
export function teamSummaryLines(
	members: readonly TeamMemberView[],
	tasks: readonly TeamTaskView[],
	now: number,
): readonly string[] {
	if (members.length === 0) return ['No teammates yet. Ask for one by name and it joins the team.']
	const width = Math.max(...members.map((member) => member.name.length))
	const lines = members.map((member) => {
		const task = teamTaskText(member, tasks)
		return `${member.name.padEnd(width)}  ${teamStatusText(member, now)}${task ? ` · ${task}` : ''}`
	})
	const done = tasks.filter((task) => task.status === 'completed').length
	if (tasks.length > 0)
		lines.push('', `Tasks · ${done}/${tasks.length} done (/team tasks lists them)`)
	return lines
}

export type TeamCommand =
	| { readonly kind: 'list' }
	| { readonly kind: 'tasks' }
	| { readonly kind: 'stop'; readonly name: string }
	| { readonly kind: 'usage'; readonly text: string }

export const TEAM_USAGE = 'Use /team, /team tasks, or /team stop <name>.'

/** What `/team <args>` asks for; keyword grammar, no flags. */
export function parseTeamCommand(args: string): TeamCommand {
	const words = args.trim().split(/\s+/u).filter(Boolean)
	if (words.length === 0) return { kind: 'list' }
	const [first, ...rest] = words
	if (first === 'tasks' && rest.length === 0) return { kind: 'tasks' }
	if (first === 'list' && rest.length === 0) return { kind: 'list' }
	if (first === 'stop' && rest.length === 1 && rest[0]) return { kind: 'stop', name: rest[0] }
	return { kind: 'usage', text: TEAM_USAGE }
}

/** What `x` on a teammate's row does: the first press asks, a second on the same row within the window stops. */
export function teamStopStep(
	armed: { readonly viewId: string; readonly at: number } | null,
	viewId: string,
	now: number,
): 'ask' | 'stop' {
	return armed !== null && armed.viewId === viewId && now - armed.at <= TEAM_STOP_CONFIRM_MS
		? 'stop'
		: 'ask'
}

/** The question the first `x` puts on the key line. */
export function teamStopAsk(name: string): string {
	return `x again to stop ${name}`
}

/** The key line for a selected teammate row. */
export function teamRailHint(
	state: TeamMemberState,
	name: string,
	armed: boolean,
	viewed: boolean,
): string {
	const items = ['↑↓ select']
	if (!viewed) items.push('enter open')
	if (state === 'stopped') items.push('x clear')
	else items.push(armed ? teamStopAsk(name) : 'x stop')
	return items.join(' · ')
}

/** The team as the screen holds it: members now and the shared task list. */
export interface TeamSnapshot {
	readonly members: readonly TeamMemberView[]
	readonly tasks: readonly TeamTaskView[]
}

export const EMPTY_TEAM: TeamSnapshot = { members: [], tasks: [] }

/** Whether two snapshots say the same, so a screen redraws only for a real change. */
export function sameTeamSnapshot(a: TeamSnapshot, b: TeamSnapshot): boolean {
	if (a.members.length !== b.members.length || a.tasks.length !== b.tasks.length) return false
	for (let i = 0; i < a.members.length; i++) {
		const left = a.members[i]
		const right = b.members[i]
		if (
			left?.name !== right?.name ||
			left?.viewId !== right?.viewId ||
			left?.state !== right?.state ||
			left?.since !== right?.since
		)
			return false
	}
	for (let i = 0; i < a.tasks.length; i++) {
		const left = a.tasks[i]
		const right = b.tasks[i]
		if (
			left?.id !== right?.id ||
			left?.subject !== right?.subject ||
			left?.status !== right?.status ||
			left?.owner !== right?.owner ||
			left?.blockedBy.join(',') !== right?.blockedBy.join(',')
		)
			return false
	}
	return true
}

/** The task a member finished last: the newest completion under its name, or undefined. */
export function lastFinishedTask(
	name: string,
	tasks: readonly TeamTaskView[],
): TeamTaskView | undefined {
	const done = tasks.filter((task) => task.status === 'completed' && task.owner === name)
	return [...done].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || byId(b, a))[0]
}

/** The words of a message to a teammate without the frame that says whose it is, for the line the lead reads. */
export function mailBody(text: string): string {
	if (/^A (?:message|shutdown request) from /u.test(text)) {
		const at = text.indexOf('\n\n')
		if (at >= 0) return text.slice(at + 2).trim()
	}
	return text
}
