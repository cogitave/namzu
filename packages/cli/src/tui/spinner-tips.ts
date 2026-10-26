import type { TipHistory } from './tip-history.js'

/**
 * Tips shown under the working row. One is picked when a reply ends and holds
 * for the next reply; it is never swapped mid-reply. The choice is
 * deterministic: among the tips that are relevant and off cooldown, the one
 * not shown for the most launches wins (never shown first), then the higher
 * priority, then registry order.
 */

/** What a tip's condition may look at. Plain data, so a condition is easy to test. */
export interface TipContext {
	/** This launch's number: how many times the terminal has started. */
	readonly launch: number
	/** How many times a command has run, by name without the slash. */
	readonly used: (command: string) => number
	readonly env: Readonly<Record<string, string | undefined>>
	/** Whether the person has set a status line / terminal notifications. */
	readonly statusLineSet: boolean
	readonly notificationsSet: boolean
	/** Tool calls the last reply made. */
	readonly lastTurnToolCalls: number
}

export interface Tip {
	readonly id: string
	readonly text: string
	/** Launches that must pass after a showing before the tip may return. */
	readonly cooldownLaunches: number
	readonly priority?: number
	/** Stop for good after this many showings. */
	readonly maxLifetimeShows?: number
	readonly relevant: (ctx: TipContext) => boolean
}

const NEVER = (command: string, from: number) => (ctx: TipContext) =>
	ctx.used(command) === 0 && ctx.launch >= from

export const SPINNER_TIPS: readonly Tip[] = [
	{
		id: 'queue-while-working',
		text: 'Type while Namzu works; your message waits and is sent when the reply ends.',
		cooldownLaunches: 10,
		relevant: () => true,
	},
	{
		id: 'goal',
		text: '/goal sets a result for Namzu to keep working toward over several replies.',
		cooldownLaunches: 8,
		relevant: NEVER('goal', 3),
	},
	{
		id: 'resume-fork',
		text: '/resume reopens an earlier conversation, and /fork branches this one.',
		cooldownLaunches: 10,
		relevant: (ctx) => ctx.used('resume') === 0 && ctx.used('fork') === 0 && ctx.launch >= 2,
	},
	{
		id: 'memory',
		text: '/memory keeps notes that Namzu recalls in this project.',
		cooldownLaunches: 10,
		relevant: NEVER('memory', 3),
	},
	{
		id: 'effort',
		text: '/effort sets how much Namzu reasons before it answers.',
		cooldownLaunches: 10,
		relevant: NEVER('effort', 3),
	},
	{
		id: 'restore',
		text: '/restore puts files back to an earlier checkpoint of this conversation.',
		cooldownLaunches: 12,
		relevant: NEVER('restore', 3),
	},
	{
		id: 'agents',
		text: '/agents lists delegated work that is running or finished.',
		cooldownLaunches: 10,
		relevant: NEVER('agents', 2),
	},
	{
		id: 'context',
		text: '/context shows what is filling the context window.',
		cooldownLaunches: 10,
		relevant: NEVER('context', 4),
	},
	{
		id: 'skills',
		text: '/skills lists the skills Namzu can use, and where each comes from.',
		cooldownLaunches: 12,
		relevant: NEVER('skills', 4),
	},
	{
		id: 'permissions',
		text: '/permissions sets which actions run without a prompt.',
		cooldownLaunches: 12,
		relevant: NEVER('permissions', 4),
	},
	{
		id: 'diff',
		text: '/diff shows what changed in the working tree.',
		cooldownLaunches: 10,
		relevant: (ctx) => ctx.used('diff') === 0 && ctx.lastTurnToolCalls >= 3,
	},
	{
		id: 'review',
		text: '/review reads your current changes and reports problems.',
		cooldownLaunches: 12,
		relevant: NEVER('review', 5),
	},
	{
		id: 'schedule',
		text: '/schedule runs a prompt on a timetable while you are away.',
		cooldownLaunches: 12,
		relevant: NEVER('schedule', 5),
	},
	{
		id: 'loop',
		text: '/loop repeats a prompt in this conversation at an interval.',
		cooldownLaunches: 12,
		relevant: NEVER('loop', 5),
	},
	{
		id: 'compact',
		text: '/compact summarises the conversation to free room before the window fills.',
		cooldownLaunches: 15,
		relevant: NEVER('compact', 6),
	},
	{
		id: 'hypermode',
		text: '/hypermode spreads one hard task across several agents at once.',
		cooldownLaunches: 15,
		relevant: NEVER('hypermode', 6),
	},
	{
		id: 'mcp',
		text: '/mcp lists the tool servers Namzu is connected to.',
		cooldownLaunches: 15,
		relevant: NEVER('mcp', 6),
	},
	{
		id: 'worktree',
		text: '/worktree gives a task its own checkout, so it leaves your files alone.',
		cooldownLaunches: 15,
		relevant: NEVER('worktree', 8),
	},
	{
		id: 'status-line',
		text: 'A statusLine command in your config puts a line of your own above the footer.',
		cooldownLaunches: 20,
		relevant: (ctx) => ctx.launch > 10 && !ctx.statusLineSet,
	},
	{
		id: 'notifications',
		text: 'Set tui.notifications in your config to be told when a long reply finishes.',
		cooldownLaunches: 15,
		relevant: (ctx) => ctx.launch >= 3 && !ctx.notificationsSet,
	},
	{
		id: 'truecolor',
		text: 'Set COLORTERM=truecolor if your terminal supports it; Namzu then draws full colour.',
		cooldownLaunches: 20,
		maxLifetimeShows: 3,
		relevant: (ctx) =>
			ctx.env.COLORTERM === undefined &&
			ctx.env.NO_COLOR === undefined &&
			ctx.env.TERM !== undefined &&
			ctx.env.TERM !== 'dumb',
	},
]

/**
 * The tip to show next, or undefined when none qualifies. `failed` holds the
 * ids of tips whose condition threw earlier in this process; a tip that
 * throws is added to it and skipped from then on.
 */
export function pickTip(
	tips: readonly Tip[],
	ctx: TipContext,
	history: TipHistory,
	failed: Set<string> = new Set(),
): Tip | undefined {
	const since = (tip: Tip): number => {
		const shown = history.shown[tip.id]
		return shown === undefined ? Number.POSITIVE_INFINITY : ctx.launch - shown.lastLaunch
	}
	const candidates: { tip: Tip; since: number; order: number }[] = []
	tips.forEach((tip, order) => {
		if (failed.has(tip.id)) return
		try {
			if (!tip.relevant(ctx)) return
		} catch {
			failed.add(tip.id)
			return
		}
		const gap = since(tip)
		if (gap < tip.cooldownLaunches) return
		if (
			tip.maxLifetimeShows !== undefined &&
			(history.shown[tip.id]?.total ?? 0) >= tip.maxLifetimeShows
		)
			return
		candidates.push({ tip, since: gap, order })
	})
	candidates.sort(
		(a, b) =>
			(a.since === b.since ? 0 : a.since > b.since ? -1 : 1) ||
			(b.tip.priority ?? 0) - (a.tip.priority ?? 0) ||
			a.order - b.order,
	)
	return candidates[0]?.tip
}
