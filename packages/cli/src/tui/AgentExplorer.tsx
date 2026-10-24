import { Box, Text } from 'ink'
import { Fragment, useEffect, useState } from 'react'
import stringWidth from 'string-width'

import {
	DEFAULT_AGENT_PHASE,
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
	type SubagentActivityStatus,
	type SubagentNarrationLine,
} from '../integrations/subagents/activity.js'
import {
	LARGE_WORKFLOW_WARNING,
	LARGE_WORKFLOW_WARNING_SHORT,
	type WorkflowSizeGuideline,
	isLargeRun,
} from '../integrations/workflows/size.js'
import {
	type WorkflowRunStatus,
	type WorkflowRunView,
	countAgents,
	isWorkflowRunAgent,
} from '../integrations/workflows/view.js'
import { fitHints } from './key-hints.js'
import { selectionWindow } from './selection-window.js'
import { END_WORDS, endWord } from './system-rows.js'
import { truncateChoiceText } from './terminal-choice-text.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'
import { formatElapsed } from './units.js'
import { formatCompactCount } from './units.js'
import { nextRunEviction, runPhaseId, runRailFacts, visibleRuns } from './workflow-runs.js'

const MAX_PICKER_ROWS = 9
/** Rows of list the detail dialog shows at most. */
const DETAIL_LIST_ROWS = 14
const COCKPIT_FRAME_COLUMNS = 4
/** Width from which the detail dialog lays its phases and agents side by side. */
const DETAIL_WIDE_COLUMNS = 64
const WIDE_COCKPIT_INNER_COLUMNS = 84
/**
 * A resolved model id is host-reported, unbounded text — a self-hosted or
 * gateway-style id routinely runs 60-90+ cells. The meta box that carries it
 * sits `flexShrink={0}` beside the description/activity boxes that ARE
 * allowed to shrink, so an uncapped model string does not get truncated
 * itself: it forces its shrinkable neighbours down first, to zero if the
 * deficit is large enough. Capping the label here, before it ever reaches
 * `agentMetaParts`, bounds the meta box's width unconditionally so it can
 * never outcompete the row's own description for space.
 */
const MAX_MODEL_LABEL_WIDTH = 24
/**
 * A focused phase's detail is wrapped to the pane width and clipped to this
 * many rows, so an operator-authored sentence never grows the cockpit taller
 * than a one-word one. The Box that holds it is always exactly this height
 * when a detail exists, whether wrapping produced one row or the full budget.
 */
const PHASE_DETAIL_LINE_BUDGET = 3
/**
 * Shown at the head of a transcript rebuilt from saved evidence.
 *
 * Both halves are load-bearing. The first says where the rows came from, so
 * an empty stretch reads as "the log did not record that" rather than as a
 * child sitting idle. The second is the guarantee the docs already make about
 * resume — delegated tasks are not restarted and their processes are not
 * reconnected — restated on the one screen that otherwise looks exactly like
 * a live child's. Nothing on this screen may imply otherwise: there is no
 * message box and no cancel affordance here for a live child either, and a
 * replayed one must never acquire one.
 */
export const REPLAYED_TRANSCRIPT_NOTICE =
	'Replayed from the saved record. This agent has finished and cannot be continued.'
/**
 * Rows outside the cockpit's own box: the one-line brand header, printed once
 * above it, and the one-line composer footer, which now renders directly
 * above the cockpit rather than below it (see StatusBar.tsx). The total is
 * unchanged by that reordering — both rows still sit outside this box exactly
 * once — so a box shorter than `terminalRows` minus this still leaves an
 * unclaimed row that does not belong to anything, and an unclaimed row does
 * not stay blank: it shows whatever transcript history was next in line to
 * scroll off.
 */
const COCKPIT_CHROME_ROWS = 2
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface AgentNarrationBandProps {
	readonly lines: readonly SubagentNarrationLine[]
}

/**
 * The parent's own commentary, directly above the rail and outside its tree.
 *
 * Outside is the point. Inside the tree these rows would read as chrome the
 * panel emitted about its agents; above it, unboxed and aligned with the
 * rail's inner text, they read as the turn talking — which is what they are
 * (see {@link SubagentNarrationLine} for why only the parent may write one).
 *
 * The band claims a row per line and nothing more: no border, no heading, no
 * blank separator, and nothing at all when there is no commentary, so a turn
 * that never narrates renders exactly as it did before this existed. The
 * monitor bounds the list, so the rows this can spend are bounded with it, and
 * the rail below keeps its own height budget either way — that budget is
 * computed from the terminal's rows and never from what is above it, so no
 * agent row is ever traded for a line of commentary.
 *
 * On a screen with no spare row, these rows are paid for the way every other
 * row this TUI adds is paid for: the frame grows, the terminal scrolls, and
 * what leaves is the oldest conversation at the TOP — the rail stays where it
 * is, whole. Measured in a real terminal at 24 rows with and without
 * narration; note that a replay reading row 0 of the emulator's BUFFER rather
 * than the viewport at `baseY` reports the opposite once the screen has
 * scrolled, because those are no longer the same rows
 * (`research/conversation-evidence/narration-band-cli.mjs`).
 */
export function AgentNarrationBand({ lines }: AgentNarrationBandProps) {
	if (lines.length === 0) return null
	return (
		// paddingLeft 3 lands the text where the rail's `main` label starts —
		// past its pointer and bullet cells, the rail being drawn one cell out
		// into the app's own margin — so the two columns line up.
		<Box flexDirection="column" paddingLeft={3} paddingRight={4}>
			{lines.map((line) => (
				<Box key={line.id}>
					<Text color={theme.text.muted} wrap="truncate-end">
						{terminalDisplayText(oneLine(line.text))}
					</Text>
				</Box>
			))}
		</Box>
	)
}

/** Rows of agents the rail shows at once; the rest sit behind `↓ N more`. */
export const AGENT_RAIL_WINDOW = 5
/** How long a finished agent stays on the rail before it leaves. */
export const AGENT_RAIL_FINISHED_LINGER_MS = 30_000
/** Widest the agent-type column grows before it is cut with `…`. */
const AGENT_RAIL_NAME_WIDTH = 28

/**
 * Whether a finished agent leaves the rail at once: one that was launched in
 * the background and completed cleanly has nothing left to manage, and its
 * result is already in the conversation. One that failed or was stopped
 * lingers, so the operator sees how it ended.
 */
function leavesAtOnce(agent: SubagentActivity): boolean {
	return agent.background === true && agent.status === 'completed'
}

/**
 * The agents the rail lists: everything running, plus a failed or stopped
 * agent for {@link AGENT_RAIL_FINISHED_LINGER_MS} after it ended, oldest
 * launch first. A background agent that completed is not listed at all.
 *
 * Saved children (`replayed`) never appear — they ended in another process,
 * and the rail says what is moving now; the cockpit still lists them. An
 * agent the operator already cleared with `x` stays off the rail.
 */
export function railAgents(
	agents: readonly SubagentActivity[],
	now: number,
	dismissed: ReadonlySet<string> = new Set(),
	pinned: string | null = null,
): readonly SubagentActivity[] {
	return agents
		.filter((agent) => {
			if (agent.replayed === true) return false
			// The agent on screen stays listed, however it ended, so the way back
			// to the conversation is never a row that has just vanished.
			if (agent.viewId === pinned && !isWorkflowRunAgent(agent)) return true
			if (dismissed.has(agent.viewId)) return false
			// A workflow run's agents are listed by the run, never as rows of their own.
			if (isWorkflowRunAgent(agent)) return false
			// An agent the model gave a `workflow` label lives only inside that
			// workflow's row and detail view, never as an agent row of its own.
			if (agent.workflow !== DEFAULT_AGENT_WORKFLOW) return false
			if (!isTerminalStatus(agent.status)) return true
			if (leavesAtOnce(agent)) return false
			return (
				agent.completedAt !== undefined && now - agent.completedAt < AGENT_RAIL_FINISHED_LINGER_MS
			)
		})
		.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Milliseconds until the next finished agent leaves the rail, or undefined
 * when none is waiting to leave. App sleeps exactly this long instead of
 * ticking, so an idle session re-renders nothing.
 */
export function railNextEviction(
	agents: readonly SubagentActivity[],
	now: number,
	runs: readonly WorkflowRunView[] = [],
): number | undefined {
	let soonest = nextRunEviction(runs, now, AGENT_RAIL_FINISHED_LINGER_MS)
	for (const agent of agents) {
		if (agent.replayed === true || isWorkflowRunAgent(agent) || !isTerminalStatus(agent.status))
			continue
		if (leavesAtOnce(agent) || agent.completedAt === undefined) continue
		const left = agent.completedAt + AGENT_RAIL_FINISHED_LINGER_MS - now
		if (left > 0 && (soonest === undefined || left < soonest)) soonest = left
	}
	return soonest
}

/** Whether `x` stops this agent (it is running) or only clears it (it has finished). */
export function railActionFor(agent: SubagentActivity): 'stop' | 'clear' {
	return isTerminalStatus(agent.status) ? 'clear' : 'stop'
}

/**
 * `↑ 1.2k tokens` while the agent has done nothing but read its task, `↓ 1.2k
 * tokens` once it has acted (its first tool call). Nothing until it has
 * reported some usage. REA fn p0e, chunk-2rs9vjmc.js: the arrow follows
 * `progress.lastActivity`.
 */
function railTokens(agent: SubagentActivity): string | undefined {
	if (agent.tokens === undefined || agent.tokens <= 0) return undefined
	const arrow = agent.toolCalls !== undefined && agent.toolCalls > 0 ? '↓' : '↑'
	return `${arrow} ${formatCompactCount(agent.tokens)} tokens`
}

/**
 * The right-hand block of an agent row: how long it has run and what it has
 * spent. A queued agent says so instead of showing a clock that has not
 * started.
 */
export function railStatusText(agent: SubagentActivity, now: number): string {
	const clock =
		agent.status === 'queued'
			? 'waiting'
			: formatElapsed(Math.max(0, (agent.completedAt ?? now) - agent.startedAt))
	const tokens = railTokens(agent)
	return tokens ? `${clock} · ${tokens}` : clock
}

/** `2 queued`: messages sent to the agent that it has not taken in yet. */
export function railQueuedText(agent: SubagentActivity): string | undefined {
	return agent.queued !== undefined && agent.queued > 0 && !isTerminalStatus(agent.status)
		? `${agent.queued} queued`
		: undefined
}

function railBulletColor(status: SubagentActivityStatus): string | undefined {
	if (status === 'completed') return theme.status.ok
	if (status === 'failed' || status === 'cancelled') return theme.status.error
	return undefined
}

/** What a workflow row shows about how the group ended; `running` until every member has settled. */
export type RailWorkflowStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * One row of the rail: the agents that share an explicit `workflow` label,
 * seen as a single piece of work. Derived from the agents alone — the kernel
 * has no workflow object, only the display label each child carries.
 */
export interface RailWorkflow {
	/** The group id the cockpit also uses, so a row opens its own workflow. */
	readonly id: string
	/** Keyboard-focus id of the row; never collides with an agent's view id. */
	readonly focusId: string
	readonly name: string
	readonly startedAt: number
	/** When the last member settled; undefined while any member is still going. */
	readonly endedAt?: number
	readonly done: number
	readonly total: number
	/** Summed spend of the members that reported usage; undefined when none has. */
	readonly tokens?: number
	readonly failed: number
	readonly status: RailWorkflowStatus
	readonly agents: readonly SubagentActivity[]
	/** The `workflow` tool's run this row stands for; absent for a group of labelled `Agent` calls. */
	readonly runId?: string
	/** The run is big enough to warn about (see `isLargeRun`); only set while it runs. */
	readonly large?: true
}

/** What the rail needs to decide whether a running workflow is a large one. */
export interface LargeRunSettings {
	readonly hypermode: boolean
	readonly configuredGuideline?: WorkflowSizeGuideline
	readonly env?: Readonly<Record<string, string | undefined>>
}

const WORKFLOW_FOCUS_PREFIX = 'workflow:'

function isSettled(agent: SubagentActivity): boolean {
	return agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled'
}

/**
 * The workflows the rail lists: a group of agents the model gave one explicit
 * `workflow` label, running or finished less than
 * {@link AGENT_RAIL_FINISHED_LINGER_MS} ago, oldest first. Unlabelled batches
 * are only agents, and saved (`replayed`) children belong to another process.
 * A workflow the operator already cleared with `x` stays off the rail.
 */
export function railWorkflows(
	agents: readonly SubagentActivity[],
	now: number,
	dismissed: ReadonlySet<string> = new Set(),
	runs: readonly WorkflowRunView[] = [],
	large?: LargeRunSettings,
): readonly RailWorkflow[] {
	return [
		...groupWorkflows(agents, now, dismissed, true),
		...visibleRuns(runs, now, AGENT_RAIL_FINISHED_LINGER_MS, dismissed).map((run) =>
			runRailWorkflow(run, agents, large),
		),
	].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** One run's rail row, from the run itself: queued agents count, and a run with no agent yet still has a row. */
export function runRailWorkflow(
	run: WorkflowRunView,
	agents: readonly SubagentActivity[],
	large?: LargeRunSettings,
): RailWorkflow {
	const facts = runRailFacts(run)
	const counts = countAgents(run)
	const isLarge =
		large !== undefined &&
		run.status === 'running' &&
		isLargeRun({
			scheduledAgents: counts.total,
			startedAgents: counts.total - counts.queued,
			totalTokens: facts.tokens ?? 0,
			hypermode: large.hypermode,
			...(large.configuredGuideline !== undefined
				? { configuredGuideline: large.configuredGuideline }
				: {}),
			...(large.env !== undefined ? { env: large.env } : {}),
		})
	return {
		...(isLarge ? { large: true as const } : {}),
		id: run.groupId,
		focusId: `${WORKFLOW_FOCUS_PREFIX}${run.groupId}`,
		name: run.name,
		startedAt: run.startedAt,
		...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		done: facts.done,
		total: facts.total,
		...(facts.tokens !== undefined ? { tokens: facts.tokens } : {}),
		failed: facts.failed,
		status: run.status,
		agents: agents.filter((agent) => agent.workflowRunId === run.runId),
		runId: run.runId,
	}
}

/**
 * Every labelled workflow whose members have all settled, however long ago:
 * what a closing line reports. The rail's 30 second lifetime does not apply.
 */
export function settledWorkflows(agents: readonly SubagentActivity[]): readonly RailWorkflow[] {
	return groupWorkflows(agents, 0, new Set(), false).filter(
		(workflow) => workflow.status !== 'running',
	)
}

function groupWorkflows(
	agents: readonly SubagentActivity[],
	now: number,
	dismissed: ReadonlySet<string>,
	expire: boolean,
): readonly RailWorkflow[] {
	const groups = new Map<string, SubagentActivity[]>()
	for (const agent of agents) {
		if (
			agent.replayed === true ||
			isWorkflowRunAgent(agent) ||
			agent.workflow === DEFAULT_AGENT_WORKFLOW
		)
			continue
		const group = groups.get(agent.workflowGroupId)
		if (group) group.push(agent)
		else groups.set(agent.workflowGroupId, [agent])
	}
	const rows: RailWorkflow[] = []
	for (const [id, members] of groups) {
		const focusId = `${WORKFLOW_FOCUS_PREFIX}${id}`
		if (dismissed.has(focusId)) continue
		const settled = members.filter(isSettled)
		const running = settled.length < members.length
		const failed = members.filter((agent) => agent.status === 'failed').length
		const endedAt = running
			? undefined
			: Math.max(...members.map((agent) => agent.completedAt ?? agent.startedAt))
		if (expire && endedAt !== undefined && now - endedAt >= AGENT_RAIL_FINISHED_LINGER_MS) continue
		const spent = members.reduce<number | undefined>(
			(sum, agent) => (agent.tokens === undefined ? sum : (sum ?? 0) + agent.tokens),
			undefined,
		)
		rows.push({
			id,
			focusId,
			name: members[0]?.workflow ?? DEFAULT_AGENT_WORKFLOW,
			startedAt: Math.min(...members.map((agent) => agent.startedAt)),
			...(endedAt !== undefined ? { endedAt } : {}),
			done: settled.length,
			total: members.length,
			...(spent !== undefined ? { tokens: spent } : {}),
			failed,
			status: running
				? 'running'
				: failed > 0
					? 'failed'
					: members.some((agent) => agent.status === 'cancelled')
						? 'stopped'
						: 'completed',
			agents: members,
		})
	}
	return rows.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** Whether `x` stops this workflow (something is still going) or only clears the finished row. */
export function railWorkflowActionFor(workflow: RailWorkflow): 'stop' | 'clear' {
	return workflow.status === 'running' ? 'stop' : 'clear'
}

/**
 * Only the outcome colours the bullet: green when it completed, red when it
 * failed or was stopped — and already red while it runs once a member has
 * failed. A running workflow with nothing wrong keeps the dim default.
 */
function railWorkflowBulletColor(workflow: RailWorkflow): string | undefined {
	if (workflow.status === 'completed') return theme.status.ok
	if (workflow.status === 'failed' || workflow.status === 'stopped') return theme.status.error
	return workflow.failed > 0 ? theme.status.error : undefined
}

/** Widths the progress bar tries, widest first. */
const WORKFLOW_BAR_WIDTHS = [20, 12, 8] as const

/** `▰▰▰▱▱▱`: filled cells are the share of agents settled, rounded down. */
export function railProgressBar(done: number, total: number, width: number): [string, string] {
	const filled = total <= 0 ? 0 : Math.max(0, Math.min(width, Math.floor((done * width) / total)))
	return ['▰'.repeat(filled), '▱'.repeat(width - filled)]
}

/** One way to draw a row's right-hand block: a bar width and the text after it. */
export interface WorkflowRowVariant {
	readonly barWidth: number
	readonly text: string
}

/**
 * The right-hand block of a workflow row, widest first. Words go before
 * numbers as the row narrows: the counter, then the elapsed time, then the
 * word `tokens`, then the bar shrinks from 20 to 12 to 8 cells and finally
 * stands alone. The caller takes the first one that fits.
 */
export function workflowRowVariants(
	workflow: RailWorkflow,
	now: number,
): readonly WorkflowRowVariant[] {
	const count = `${workflow.done}/${workflow.total}`
	// A failed agent shows beside the counter, so a run that finished with a
	// failure never reads as a clean one.
	const counted = workflow.failed > 0 ? `${count} · ${workflow.failed} failed` : count
	const elapsed = formatElapsed(Math.max(0, (workflow.endedAt ?? now) - workflow.startedAt))
	const spent = workflow.tokens === undefined ? undefined : formatCompactCount(workflow.tokens)
	const join = (parts: readonly (string | undefined)[]): string =>
		parts.filter((part): part is string => part !== undefined).join(' · ')
	const [wide, mid, narrow] = WORKFLOW_BAR_WIDTHS
	const warned: WorkflowRowVariant[] = workflow.large
		? [
				{
					barWidth: wide,
					text: join([counted, elapsed, spent && `↓ ${spent} tokens`, LARGE_WORKFLOW_WARNING]),
				},
				{
					barWidth: wide,
					text: join([
						counted,
						elapsed,
						spent && `↓ ${spent} tokens`,
						LARGE_WORKFLOW_WARNING_SHORT,
					]),
				},
				{
					barWidth: wide,
					text: join([elapsed, spent && `↓ ${spent}`, LARGE_WORKFLOW_WARNING_SHORT]),
				},
			]
		: []
	const variants: WorkflowRowVariant[] = [
		...warned,
		{
			barWidth: wide,
			text: join([counted, elapsed, spent && `↓ ${spent} tokens`]),
		},
		...(counted === count
			? []
			: [{ barWidth: wide, text: join([count, elapsed, spent && `↓ ${spent} tokens`]) }]),
		{ barWidth: wide, text: join([elapsed, spent && `↓ ${spent} tokens`]) },
		{ barWidth: wide, text: join([elapsed, spent && `↓ ${spent}`]) },
		{ barWidth: wide, text: join([spent && `↓ ${spent}`]) },
		{ barWidth: mid, text: join([spent && `↓ ${spent}`]) },
		{ barWidth: narrow, text: join([spent && `↓ ${spent}`]) },
		{ barWidth: narrow, text: '' },
	]
	return variants.filter(
		(variant, index) =>
			variants.findIndex(
				(other) => other.barWidth === variant.barWidth && other.text === variant.text,
			) === index,
	)
}

/** Cells of the pointer and bullet columns in front of every rail row. */
const RAIL_PREFIX_CELLS = 4
/** Gap between the name and the bar. */
const WORKFLOW_ROW_GAP = 2

/**
 * Picks how a workflow row is laid out in `columns` cells: the first variant
 * of {@link workflowRowVariants} that leaves the name at least
 * `min(8, nameWidth)` cells, with the name squeezed into whatever is left.
 */
export function layoutWorkflowRow(
	workflow: RailWorkflow,
	now: number,
	columns: number,
	nameWidth: number,
): { readonly variant: WorkflowRowVariant; readonly nameWidth: number } {
	const variants = workflowRowVariants(workflow, now)
	const room = Math.max(1, columns - RAIL_PREFIX_CELLS - 2)
	const wanted = Math.min(8, nameWidth)
	const widthOf = (variant: WorkflowRowVariant): number =>
		WORKFLOW_ROW_GAP + variant.barWidth + (variant.text ? 2 + stringWidth(variant.text) : 0)
	for (const variant of variants) {
		if (room - widthOf(variant) >= wanted) {
			return { variant, nameWidth: Math.min(nameWidth, room - widthOf(variant)) }
		}
	}
	const last = variants[variants.length - 1] as WorkflowRowVariant
	return { variant: last, nameWidth: Math.max(1, room - widthOf(last)) }
}

export interface AgentTaskPanelProps {
	/** Already filtered to what the rail shows — see {@link railAgents}. */
	readonly agents: readonly SubagentActivity[]
	/** One row each below the agents — see {@link railWorkflows}. */
	readonly workflows?: readonly RailWorkflow[]
	readonly terminalRows: number
	readonly terminalColumns: number
	/**
	 * One row only (`main` and a count). Used while a review owns the screen:
	 * the operator still sees that the work they already approved is moving,
	 * without the rows competing with the question being asked.
	 */
	readonly compact?: boolean
	/**
	 * The highlighted row while the rail has the keyboard: 0 is `main`, 1 the
	 * first agent, then the workflow rows after the last agent. Undefined
	 * means the rail is not focused.
	 */
	readonly selectedIndex?: number
	/** The agent whose transcript is on screen; undefined or null means `main`. */
	readonly viewingId?: string | null
	/** Clock for tests; the panel otherwise ticks once a second. */
	readonly now?: number
}

/** What an agent row says in its description column: what it was asked to do. */
export function railDescription(agent: SubagentActivity): string {
	return agent.description || agent.agentId
}

/** Widest the live label grows in a row's status block before it is cut with `…`. */
const RAIL_LIVE_LABEL_WIDTH = 24

/** What a running agent is doing right now (`Reading config loader`), shown beside its clock; undefined when finished or silent. */
export function railLiveLabel(agent: SubagentActivity, narrow = false): string | undefined {
	if (narrow || isTerminalStatus(agent.status) || !agent.summary) return undefined
	const label = oneLine(agent.summary)
	if (!label || label === oneLine(railDescription(agent))) return undefined
	return truncateChoiceText(label, RAIL_LIVE_LABEL_WIDTH)
}

/** The row's right-hand block: the live label (when there is one), the clock and the spend. */
function railStatusBlock(agent: SubagentActivity, now: number, narrow: boolean): string {
	const label = railLiveLabel(agent, narrow)
	const status = railStatusText(agent, now)
	return label ? `${label} · ${status}` : status
}

/** Cells the `↓ N more` row and the pointer share with a row's first slot. */
const RAIL_POINTER_CELLS = 2

/**
 * The agents rail: a blank row, then a `main` row, one row per running or
 * recently failed sub-agent, and one per workflow, drawn under the footer
 * line.
 *
 * ```
 *
 *   ● main
 *   ◯ count-words        Read(a.txt)                       12s · ↓ 3.2k tokens
 *   ◯ release-audit      ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  1/4 · 35s · ↓ 12.5k tokens
 * ```
 *
 * The first cell of a row is the pointer slot and the bullet sits two cells in,
 * directly under the first glyph of the mode line above (the rail reaches one
 * cell into the app's margin to put it there), and rows stop two cells short
 * of the right edge. `●` marks the transcript on screen, `◯` the others. No
 * accent colour: the pointer and bullets take the row's own colour, and only a
 * finished row's bullet turns green or red. Not a modal: the composer stays
 * mounted above and keeps taking input until the operator presses ↓ on an
 * empty composer to move into the rail. The key line for the focused row is
 * not drawn here; it takes the place of the mode line (see {@link railHint}).
 */
export function AgentTaskPanel({
	agents,
	workflows = [],
	terminalColumns,
	compact = false,
	selectedIndex,
	viewingId,
	now: nowOverride,
}: AgentTaskPanelProps) {
	const ticked = useLiveNow(nowOverride === undefined)
	const now = nowOverride ?? ticked
	const focused = selectedIndex !== undefined
	const mainViewed = viewingId === undefined || viewingId === null
	const narrow = terminalColumns < 64
	const hasMain = railShowsMain(agents.length, viewingId, compact)
	// Rows before the first agent: 1 with `main` drawn, else 0.
	const lead = hasMain ? 1 : 0
	const selectedAgent = focused ? Math.min(agents.length, selectedIndex - lead + 1) - 1 : 0
	const { start, items } = selectionWindow(
		agents,
		Math.max(0, selectedAgent),
		compact ? 0 : AGENT_RAIL_WINDOW,
	)
	const above = start
	const below = compact ? agents.length : Math.max(0, agents.length - start - items.length)
	// One name column for agent and workflow rows alike: as wide as the longest
	// name on screen (never past the cap), so the second column starts right
	// after it instead of at a fixed tab.
	// One label rule for every row: the type column is always there, so a row
	// reads the same whatever its neighbours are doing.
	const nameWidth = Math.min(
		narrow ? 14 : AGENT_RAIL_NAME_WIDTH,
		Math.max(
			4,
			...agents.map((agent) => stringWidth(oneLine(agent.agentId))),
			...workflows.map((workflow) => stringWidth(oneLine(workflow.name))),
		),
	)
	// The right-hand blocks of the agent rows share one width, so they end in
	// the same column however long each one's clock and spend are.
	const statusWidth = Math.max(
		0,
		...items.map((agent) => {
			const queued = railQueuedText(agent)
			return (
				stringWidth(railStatusBlock(agent, now, narrow)) + (queued ? 3 + stringWidth(queued) : 0)
			)
		}),
	)
	const mainRight = compact
		? [
				...(agents.length > 0 || workflows.length === 0
					? [`${agents.length} agent${agents.length === 1 ? '' : 's'}`]
					: []),
				...(workflows.length > 0
					? [`${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`]
					: []),
			].join(' · ')
		: above > 0
			? `↑ ${above} more`
			: ''

	return (
		// marginLeft/Right -1 reach into the app's one cell of side padding, so the
		// pointer slot is the row's first cell and the bullet lands under the mode
		// line's first glyph; paddingRight 2 keeps rows off the right edge.
		<Box flexDirection="column" marginTop={1} marginLeft={-1} marginRight={-1} paddingRight={2}>
			{hasMain ? (
				<Box>
					<Box width={RAIL_POINTER_CELLS} flexShrink={0}>
						<Text bold color={theme.text.primary}>
							{focused && selectedIndex === 0 ? '❯' : ' '}
						</Text>
					</Box>
					<Box width={2} flexShrink={0}>
						<Text
							bold={mainViewed}
							color={theme.text.primary}
							dimColor={!mainViewed && !(focused && selectedIndex === 0)}
						>
							{mainViewed ? '●' : '◯'}
						</Text>
					</Box>
					<Box flexGrow={1} flexShrink={1} minWidth={0}>
						<Text
							bold={mainViewed || (focused && selectedIndex === 0)}
							dimColor={!mainViewed && !(focused && selectedIndex === 0)}
							color={theme.text.primary}
						>
							main
						</Text>
					</Box>
					{mainRight ? (
						<Box flexShrink={0} marginLeft={1}>
							<Text color={theme.text.muted}>{mainRight}</Text>
						</Box>
					) : null}
				</Box>
			) : null}
			{compact
				? null
				: items.map((agent, offset) => {
						const index = start + offset + lead
						const selected = focused && selectedIndex === index
						const viewed = viewingId === agent.viewId
						const finished = isTerminalStatus(agent.status)
						const status = railStatusBlock(agent, now, narrow)
						const bright = viewed || selected
						return (
							<Box key={agent.viewId}>
								<Box width={RAIL_POINTER_CELLS} flexShrink={0}>
									<Text bold color={theme.text.primary}>
										{selected ? '❯' : ' '}
									</Text>
								</Box>
								<Box width={2} flexShrink={0}>
									<Text
										bold={viewed}
										color={railBulletColor(agent.status) ?? theme.text.primary}
										dimColor={!bright && railBulletColor(agent.status) === undefined}
									>
										{viewed ? '●' : '◯'}
									</Text>
								</Box>
								<Box width={nameWidth} flexShrink={0}>
									<Text
										bold={bright}
										dimColor={!bright}
										color={theme.text.primary}
										wrap="truncate-end"
									>
										{terminalDisplayText(oneLine(agent.agentId))}
									</Text>
								</Box>
								<Box flexGrow={1} flexShrink={1} minWidth={0} paddingLeft={2}>
									<Text
										bold={bright}
										dimColor={!bright}
										color={theme.text.primary}
										wrap="truncate-end"
									>
										{terminalDisplayText(oneLine(railDescription(agent)))}
									</Text>
								</Box>
								<Box flexShrink={0} marginLeft={1} minWidth={statusWidth} justifyContent="flex-end">
									<Text color={finished ? theme.text.muted : theme.text.secondary}>
										{status}
										{railQueuedText(agent) ? (
											<Text color={theme.status.warn}> · {railQueuedText(agent)}</Text>
										) : null}
									</Text>
								</Box>
							</Box>
						)
					})}
			{!compact && below > 0 ? (
				<Box paddingLeft={2}>
					<Text color={theme.text.muted}>↓ {below} more</Text>
				</Box>
			) : null}
			{/* Once there are more agents than the window holds, the row stays (empty
			    when nothing is below) so the block's height does not change as the
			    selection scrolls. */}
			{!compact && below === 0 && agents.length > AGENT_RAIL_WINDOW ? <Text> </Text> : null}
			{compact
				? null
				: workflows.map((workflow, offset) => {
						const selected = focused && selectedIndex === agents.length + lead + offset
						const { variant, nameWidth: workflowNameWidth } = layoutWorkflowRow(
							workflow,
							now,
							terminalColumns,
							nameWidth,
						)
						const [filled, empty] = railProgressBar(workflow.done, workflow.total, variant.barWidth)
						return (
							<Box key={workflow.focusId}>
								<Box width={RAIL_POINTER_CELLS} flexShrink={0}>
									<Text bold color={theme.text.primary}>
										{selected ? '❯' : ' '}
									</Text>
								</Box>
								<Box width={2} flexShrink={0}>
									<Text
										color={railWorkflowBulletColor(workflow) ?? theme.text.primary}
										dimColor={!selected && railWorkflowBulletColor(workflow) === undefined}
									>
										◯
									</Text>
								</Box>
								<Box width={workflowNameWidth} flexShrink={0}>
									<Text
										bold={selected}
										color={theme.text.primary}
										dimColor={!selected}
										wrap="truncate-end"
									>
										{terminalDisplayText(oneLine(workflow.name))}
									</Text>
								</Box>
								<Box flexShrink={0} paddingLeft={WORKFLOW_ROW_GAP}>
									<Text bold={selected} color={theme.text.primary} dimColor={!selected}>
										{filled}
										<Text dimColor>{empty}</Text>
										{variant.text ? `  ${variant.text}` : ''}
									</Text>
								</Box>
							</Box>
						)
					})}
		</Box>
	)
}

/**
 * Whether the rail draws its `main` row: only beside at least one agent row,
 * or while an agent's transcript is the one on screen (so the way back to the
 * conversation is visible). A rail with nothing but workflow rows has no
 * `main`; `compact` is the one-row form and always keeps it.
 */
export function railShowsMain(
	agentCount: number,
	viewingId?: string | null,
	compact = false,
): boolean {
	return compact || agentCount > 0 || (viewingId !== undefined && viewingId !== null)
}

/** The chord that stops every running agent from the rail. */
export const RAIL_STOP_ALL_CHORD = 'ctrl+x ctrl+k'
/** Below this width the key line keeps only the row's own keys, not the stop-all chord. */
const RAIL_HINT_CHORD_COLUMNS = 90

/**
 * The key line for the focused rail row. It takes the place of the footer's
 * mode line while the rail has the keyboard (the rows stay where they are),
 * and says only what the row can do:
 *
 * - an agent or workflow row: `enter to view · x to stop` (`x to clear` once
 *   it has finished), plus `ctrl+x ctrl+k to stop all agents` when more than
 *   one agent runs and the line is at least 90 columns wide;
 * - `main`, or nothing selected: `↑/↓ to select · enter to view`.
 *
 * Esc leaves the rail but is not advertised here.
 */
export function railHint(
	selected: SubagentActivity | RailWorkflow | undefined,
	columns: number,
	runningAgents = 0,
	viewedId?: string,
): string {
	if (!selected) return '↑/↓ to select · enter to view'
	// The row on screen already is the view: only moving off it is left to say.
	if (viewedId !== undefined && !('focusId' in selected) && selected.viewId === viewedId)
		return '↑/↓ to select'
	const action = 'focusId' in selected ? railWorkflowActionFor(selected) : railActionFor(selected)
	const items = ['enter to view', `x to ${action}`]
	if (runningAgents > 1 && columns >= RAIL_HINT_CHORD_COLUMNS)
		items.push(`${RAIL_STOP_ALL_CHORD} to stop all agents`)
	return items.join(' · ')
}

export type AgentCockpitFocus = 'workflows' | 'phases' | 'agents'

export interface AgentWorkflow {
	readonly id: string
	readonly name: string
	readonly startedAt: number
	readonly status: SubagentActivityStatus
	readonly phases: readonly AgentPhase[]
	readonly agents: readonly SubagentActivity[]
	/** The `workflow` tool's run, when this is one: its agents are scripted, not model-launched. */
	readonly runId?: string
	readonly description?: string
	readonly runStatus?: WorkflowRunStatus
	/** What the script's `log()` said, oldest first. */
	readonly logs?: readonly string[]
}

export interface AgentPhase {
	readonly id: string
	readonly workflowId: string
	readonly workflow: string
	readonly name: string
	readonly order?: number
	/** Detail text the phase's first agent declared; display-only, never execution state. */
	readonly detail?: string
	readonly sequence: number
	readonly startedAt: number
	readonly status: SubagentActivityStatus
	readonly agents: readonly SubagentActivity[]
}

export interface AgentCockpitProps {
	readonly agents: readonly SubagentActivity[]
	/** The `workflow` tool's runs, for the phases they declared that nothing has started in yet. */
	readonly runs?: readonly WorkflowRunView[]
	readonly selectedPhaseId: string
	readonly selectedId: string
	readonly focus: AgentCockpitFocus
	readonly terminalRows: number
	readonly terminalColumns: number
}

/**
 * Live workflow projection. App owns input; this component renders only the
 * bounded scheduler state it receives and never invents orchestration state.
 */
export function AgentCockpit({
	agents,
	runs = [],
	selectedPhaseId,
	selectedId,
	focus,
	terminalRows,
	terminalColumns,
}: AgentCockpitProps) {
	const workflows = agentWorkflows(agents, runs)
	const workflowIndex = Math.max(
		0,
		workflows.findIndex((workflow) =>
			workflow.phases.some((phase) => phase.id === selectedPhaseId),
		),
	)
	const workflow = workflows[workflowIndex]
	const phases = workflow?.phases ?? []
	const selectedPhaseIndex = Math.max(
		0,
		phases.findIndex((phase) => phase.id === selectedPhaseId),
	)
	const selectedPhase = phases[selectedPhaseIndex]
	const phaseAgents = selectedPhase?.agents ?? []
	const selectedAgentIndex = Math.max(
		0,
		phaseAgents.findIndex((agent) => agent.viewId === selectedId),
	)
	const now = useLiveNow(agents.some((agent) => agent.completedAt === undefined))
	const compact = terminalRows < 20
	if (focus === 'workflows') {
		const { items } = selectionWindow(workflows, workflowIndex, agentWorkflowPageSize(terminalRows))
		return (
			<Box
				flexDirection="column"
				height={Math.max(8, terminalRows - COCKPIT_CHROME_ROWS)}
				borderStyle="single"
				borderColor={theme.border.default}
				paddingX={1}
			>
				<Text color={theme.accent.assistant} bold wrap="truncate-end">
					Workflows · {workflowIndex + 1}/{workflows.length}
				</Text>
				{compact ? null : (
					<Text color={theme.text.muted} wrap="truncate-end">
						Select a workflow to inspect its phases and agents.
					</Text>
				)}
				<Box flexDirection="column" flexGrow={1} paddingTop={compact ? 0 : 1}>
					{items.map((item) => (
						<Box key={item.id} height={1} flexShrink={0}>
							<Box width={4} flexShrink={0}>
								<Text color={item.id === workflow?.id ? theme.accent.assistant : theme.text.muted}>
									{item.id === workflow?.id ? '›' : ' '} {statusGlyph(item.status)}
								</Text>
							</Box>
							<Box flexGrow={1} minWidth={0}>
								<Text
									color={theme.text.primary}
									bold={item.id === workflow?.id}
									wrap="truncate-end"
								>
									{oneLine(item.name)}
								</Text>
							</Box>
							<Box flexShrink={0} marginLeft={1}>
								<Text color={statusColor(item.status)} wrap="truncate-end">
									{terminalColumns >= 70
										? `${item.phases.length} ${item.phases.length === 1 ? 'phase' : 'phases'} · `
										: ''}
									{item.agents.length} agents · {statusLabel(item.status)}
								</Text>
							</Box>
						</Box>
					))}
				</Box>
				<Box paddingTop={compact ? 0 : 1}>
					<Text color={theme.text.muted} wrap="truncate-end">
						{fitHints(
							[
								{ text: '↑↓ select', short: '↑↓', rank: 4 },
								{ text: 'PgUp/PgDn jump', rank: 1 },
								{ text: 'enter select', rank: 5 },
								{ text: 'esc return', rank: 5 },
							],
							Math.max(1, terminalColumns - 4),
						)}
					</Text>
				</Box>
			</Box>
		)
	}
	if (!workflow || !selectedPhase) return null
	return (
		<WorkflowDetail
			workflow={workflow}
			phases={phases}
			selectedPhaseIndex={selectedPhaseIndex}
			selectedAgentIndex={selectedAgentIndex}
			level={focus === 'agents' ? 2 : 1}
			terminalRows={terminalRows}
			terminalColumns={terminalColumns}
			now={now}
		/>
	)
}

/** Title of a group the model gave no `phase` label: one group, named for what it holds. */
export const UNLABELLED_PHASE_TITLE = 'Agents'

/** The words a phase is listed under: the model's label verbatim, `Agents` when it gave none. */
export function phaseTitle(phase: Pick<AgentPhase, 'name'>): string {
	return phase.name === DEFAULT_AGENT_PHASE ? UNLABELLED_PHASE_TITLE : phase.name
}

export type PhaseOutcome = 'not-started' | 'running' | 'done' | 'failed' | 'skipped'

/**
 * How a phase stands, from its agents alone: `done` once every agent has
 * settled cleanly, `failed` once every agent has settled and any failed or
 * was stopped, `running` otherwise. Only a workflow run declares phases ahead
 * of their agents, so only a run's phase is ever `not-started`. A run's phase
 * whose agents were all skipped has nothing that finished, so it is `skipped`,
 * never `done`.
 */
export function phaseOutcome(phase: Pick<AgentPhase, 'agents'>): PhaseOutcome {
	// A phase a script declared and nothing has started in.
	if (phase.agents.length === 0) return 'not-started'
	if (phase.agents.some((agent) => !isTerminalStatus(agent.status))) return 'running'
	// An agent the operator skipped in a workflow run is not a failure of its phase.
	if (
		phase.agents.some(
			(agent) =>
				agent.status !== 'completed' &&
				!(agent.workflowRunId !== undefined && agent.status === 'cancelled'),
		)
	)
		return 'failed'
	// Skipped is not done: the tick is for a phase where something finished.
	return phase.agents.some((agent) => agent.status === 'completed') ? 'done' : 'skipped'
}

/** The phase list's `done/total`: settled agents over every agent seen in it. */
export function phaseCount(
	phase: Pick<AgentPhase, 'agents'>,
	/** The run the phase belongs to was stopped: a phase where nothing finished says so. */
	runStopped = false,
): string {
	if (phase.agents.length === 0) return ''
	// In a workflow run only an agent that completed counts; one that was skipped,
	// failed or stopped has not done its work.
	const counted = phase.agents.filter((agent) =>
		agent.workflowRunId !== undefined
			? agent.status === 'completed'
			: isTerminalStatus(agent.status),
	).length
	if (runStopped && counted === 0 && phase.agents.every((agent) => isTerminalStatus(agent.status)))
		return 'stopped'
	return `${counted}/${phase.agents.length}`
}

/**
 * Whether opening a workflow starts at its list of phases. A workflow the
 * model labelled always does (its agents are only reachable through it); the
 * unlabelled default group keeps jumping straight to its agents when it has
 * a single group.
 */
export function cockpitEntryFocus(workflow: AgentWorkflow): 'phases' | 'agents' {
	const labelled =
		workflow.runId !== undefined ||
		workflow.agents.some((agent) => agent.workflow !== DEFAULT_AGENT_WORKFLOW)
	return labelled || workflow.phases.length > 1 ? 'phases' : 'agents'
}

/**
 * Rows of list the detail dialog shows at once: 14 on a tall screen, fewer on
 * a short one, never fewer than 4. The dialog is this many rows of list
 * whether it holds two items or none, so it does not change height as agents
 * come and go. Shared with the key handler so paging matches the screen.
 */
export function workflowDetailPageSize(terminalRows: number): number {
	return Math.max(4, Math.min(DETAIL_LIST_ROWS, terminalRows - 20))
}

function agentDetailGlyph(agent: Pick<SubagentActivity, 'status' | 'workflowRunId'>): {
	text: string
	color: string | undefined
} {
	switch (agent.status) {
		case 'completed':
			return { text: '✔', color: theme.status.ok }
		case 'failed':
			return { text: '✘', color: theme.status.error }
		case 'cancelled':
			// An agent the operator skipped in a run is not an error of its own.
			return {
				text: '✘',
				color: agent.workflowRunId !== undefined ? theme.text.muted : theme.status.error,
			}
		case 'working':
			return { text: '●', color: theme.text.secondary }
		default:
			return { text: '◌', color: theme.text.muted }
	}
}

interface WorkflowDetailProps {
	readonly workflow: AgentWorkflow
	readonly phases: readonly AgentPhase[]
	readonly selectedPhaseIndex: number
	readonly selectedAgentIndex: number
	readonly level: 1 | 2
	readonly terminalRows: number
	readonly terminalColumns: number
	readonly now: number
}

/** The word a finished workflow's stats carry: `3/3 agents · 1m05s · finished`. */
function endedWord(workflow: AgentWorkflow): string {
	if (workflow.runStatus !== undefined) return endWord(workflow.runStatus)
	if (workflow.agents.some((agent) => agent.status === 'failed')) return END_WORDS.failed
	if (workflow.agents.some((agent) => agent.status === 'cancelled')) return END_WORDS.stopped
	return END_WORDS.finished
}

function padEndCells(text: string, cells: number): string {
	const clipped = stringWidth(text) > cells ? truncateChoiceText(text, cells) : text
	return clipped + ' '.repeat(Math.max(0, cells - stringWidth(clipped)))
}

function padStartCells(text: string, cells: number): string {
	return ' '.repeat(Math.max(0, cells - stringWidth(text))) + text
}

/**
 * `↑ 1–8 of 14 ↓`: which rows of a longer list the box shows. An arrow is
 * drawn on the side that has more, a space on the side that does not. Set in
 * the box's bottom border, one per list (REA fns vt/Bo/Zt, chunk-t32eta2x.js).
 */
export function windowTag(
	window: { readonly start: number; readonly items: readonly unknown[] },
	total: number,
): string {
	const end = window.start + window.items.length
	return `${window.start > 0 ? '↑' : ' '} ${window.start + 1}–${end} of ${total} ${end < total ? '↓' : ' '}`
}

/** A stretch of a box border: dashes, with an optional dim tag ending it. */
function BorderSegment({
	width,
	tag,
	color,
}: {
	readonly width: number
	readonly tag?: string | undefined
	readonly color: string
}) {
	const text = tag ? ` ${tag} ` : ''
	const shown = text !== '' && stringWidth(text) <= width ? text : ''
	const dashes = Math.max(0, width - stringWidth(shown))
	return (
		<>
			<Text color={color}>{'─'.repeat(dashes)}</Text>
			{shown ? <Text color={theme.text.muted}>{shown}</Text> : null}
		</>
	)
}

/** What an agent row says after its label: model, spend, and how it ended. */
function agentDetailMeta(agent: SubagentActivity, columns: number): string {
	return [
		...(columns >= 90 && agent.workflowRunId === undefined ? [oneLine(agent.agentId)] : []),
		...(columns >= 70 && agent.model
			? [truncateChoiceText(agent.model, MAX_MODEL_LABEL_WIDTH)]
			: []),
		...(agent.tokens !== undefined ? [`${formatCompactCount(agent.tokens)} tok`] : []),
		...(agent.status === 'failed' ? ['failed'] : []),
		...(agent.status === 'cancelled'
			? [agent.workflowRunId !== undefined ? 'skipped' : 'stopped']
			: []),
	].join(' · ')
}

function agentDetailLabel(agent: SubagentActivity): string {
	return terminalDisplayText(oneLine(agent.description || agent.agentId))
}

/**
 * The detail of one workflow, as a frameless dialog: a rule across the top, the
 * workflow's name, then its description on the left and `done/total agents ·
 * elapsed` on the right, then the lists.
 *
 * From 64 columns the lists sit side by side in one box: the phases on the left
 * (`✔`/`✘` or the phase's number, its title, `done/total`), and the agents of the
 * selected phase on the right (status glyph, label, `model · tokens`, elapsed
 * flush right). Level 1 puts the pointer on the phases, level 2 on the agents.
 * Below 64 columns the same two lists are stacked: one at a time, the phases at
 * level 1 and the selected phase's agents at level 2.
 */
export function WorkflowDetail({
	workflow,
	phases,
	selectedPhaseIndex,
	selectedAgentIndex,
	level,
	terminalRows,
	terminalColumns,
	now,
}: WorkflowDetailProps) {
	const columns = Math.max(20, terminalColumns)
	const pageSize = workflowDetailPageSize(terminalRows)
	const phase = phases[selectedPhaseIndex]
	const isRun = workflow.runId !== undefined
	const settled = workflow.agents.filter((agent) =>
		isRun ? agent.status === 'completed' : isTerminalStatus(agent.status),
	).length
	const running = isRun
		? workflow.runStatus === 'running'
		: workflow.agents.some((agent) => !isTerminalStatus(agent.status))
	const ended = !running
	const ends = workflow.agents.map((agent) => agent.completedAt ?? now)
	const elapsed = formatElapsed(
		Math.max(0, Math.max(isRun && running ? now : 0, ...ends) - workflow.startedAt),
	)
	const named = isRun || workflow.agents.some((agent) => agent.workflow !== DEFAULT_AGENT_WORKFLOW)
	// Same rule as the rail: an explicit label names the workflow, an absent
	// one gets a neutral count instead of the generic default name.
	const live = workflow.agents.filter((agent) => !isTerminalStatus(agent.status)).length
	const total = workflow.agents.length
	const title = named
		? oneLine(workflow.name)
		: `${total} agent${total === 1 ? '' : 's'} · ${live} running`
	const failedAgents = workflow.agents.filter((agent) => agent.status === 'failed').length
	const stats = `${settled}/${total} ${total === 1 ? 'agent' : 'agents'} · ${elapsed}${
		failedAgents > 0 ? ` · ${failedAgents} failed` : ''
	}${ended && total > 0 ? ` · ${endedWord(workflow)}` : ''}`
	const selectedAgent = phase?.agents[selectedAgentIndex]
	const canStop =
		level === 1
			? running
			: selectedAgent !== undefined &&
				!isTerminalStatus(selectedAgent.status) &&
				(!isRun || workflow.runStatus === 'running')
	// On a run's agents `x` skips that one agent; the run goes on without it.
	const hint = fitHints(
		level === 1
			? [
					{ text: '↑↓ select', rank: 4 },
					...(canStop ? [{ text: 'x stop workflow', rank: 2 }] : []),
					{ text: 'esc back', rank: 5 },
				]
			: [
					{ text: '↑↓ select', rank: 4 },
					{ text: 'enter view', rank: 3 },
					...(canStop ? [{ text: `x ${isRun ? 'skip' : 'stop'}`, rank: 2 }] : []),
					{ text: 'esc back', rank: 5 },
				],
		Math.max(1, columns - 2),
	)
	const agents = phase?.agents ?? []
	const agentsTitle = phase
		? `${oneLine(phaseTitle(phase))} · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`
		: ''
	const phaseWindow = selectionWindow(phases, selectedPhaseIndex, pageSize)
	const agentWindow = selectionWindow(agents, selectedAgentIndex, pageSize)
	const emptyNote =
		phase && agents.length === 0 ? (isRun && !running ? 'No agents' : 'Not started yet') : ''

	const phaseGlyph = (item: AgentPhase, index: number) => {
		const outcome = phaseOutcome(item)
		const color =
			outcome === 'done'
				? theme.status.ok
				: outcome === 'failed'
					? theme.status.error
					: theme.text.muted
		return {
			outcome,
			color,
			text:
				outcome === 'done'
					? '✔'
					: outcome === 'failed' || outcome === 'skipped'
						? '✘'
						: String(index + 1),
		}
	}

	const boxWidth = columns - 2
	const leftTitleCells = Math.min(
		22,
		Math.max(6, ...phases.map((item) => stringWidth(oneLine(phaseTitle(item))))),
	)
	const countCells = Math.max(
		3,
		...phases.map((item) => phaseCount(item, workflow.runStatus === 'stopped').length),
	)
	const leftInner = 5 + leftTitleCells + 1 + countCells + 1
	const rightInner = boxWidth - 3 - leftInner
	const sideBySide = columns >= DETAIL_WIDE_COLUMNS && rightInner >= 24

	// The script's last log() line sits under the header, the two before it dim.
	const recentLogs = (workflow.logs ?? [])
		.slice(-(terminalRows >= 30 ? 3 : terminalRows >= 24 ? 1 : 0))
		.map((line) => terminalDisplayText(oneLine(line)))

	const header = (
		<>
			<Text color={theme.border.default} wrap="truncate-end">
				{'─'.repeat(columns)}
			</Text>
			<Box paddingX={1}>
				<Text color={theme.text.primary} bold wrap="truncate-end">
					{title}
				</Text>
			</Box>
			<Box paddingX={1}>
				<Box flexGrow={1} minWidth={0}>
					<Text color={theme.text.muted} wrap="truncate-end">
						{workflow.description ? terminalDisplayText(oneLine(workflow.description)) : ''}
					</Text>
				</Box>
				<Box flexShrink={0} marginLeft={1}>
					<Text color={theme.text.muted}>{stats}</Text>
				</Box>
			</Box>
			{recentLogs.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the last few lines, in order
				<Box key={index} paddingX={1}>
					<Text
						color={index === recentLogs.length - 1 ? theme.text.primary : theme.text.muted}
						dimColor={index !== recentLogs.length - 1}
						wrap="truncate-end"
					>
						{line}
					</Text>
				</Box>
			))}
			<Text> </Text>
		</>
	)
	const footer = (
		<Box paddingX={1}>
			<Text color={theme.text.muted} wrap="truncate-end">
				{hint}
			</Text>
		</Box>
	)

	// Stacked, the selected phase's own detail sits right under its row.
	const stackedDetail =
		level === 1 &&
		terminalRows >= 20 &&
		phase?.detail &&
		phaseWindow.items.length + 1 + 1 <= pageSize
			? wrapPhaseDetailLines(phase.detail, columns - 4).slice(
					0,
					Math.min(PHASE_DETAIL_LINE_BUDGET, pageSize - phaseWindow.items.length - 1),
				)
			: []

	if (!sideBySide) {
		return (
			<Box flexDirection="column" marginTop={1} marginLeft={-1} marginRight={-1} width={columns}>
				{header}
				<Box paddingX={1}>
					<Text color={theme.text.primary} bold wrap="truncate-end">
						{level === 1 || !phase ? 'Phases' : agentsTitle}
					</Text>
				</Box>
				<Box flexDirection="column" height={pageSize} flexShrink={0} paddingX={1}>
					{level === 1
						? phaseWindow.items.map((item, offset) => {
								const index = phaseWindow.start + offset
								const active = index === selectedPhaseIndex
								const glyph = phaseGlyph(item, index)
								return (
									<Fragment key={item.id}>
										<Box>
											<Box width={2} flexShrink={0}>
												<Text color={theme.accent.assistant}>{active ? '❯' : ' '}</Text>
											</Box>
											<Box width={3} flexShrink={0}>
												<Text color={glyph.color}>{glyph.text}</Text>
											</Box>
											<Box flexGrow={1} flexShrink={1} minWidth={0}>
												<Text
													color={active ? theme.accent.assistant : theme.text.primary}
													bold={active}
													dimColor={glyph.outcome === 'not-started' && !active}
													wrap="truncate-end"
												>
													{oneLine(phaseTitle(item))}
												</Text>
											</Box>
											<Box flexShrink={0} marginLeft={1}>
												<Text color={theme.text.muted}>
													{phaseCount(item, workflow.runStatus === 'stopped')}
												</Text>
											</Box>
										</Box>
										{active
											? stackedDetail.map((line, lineIndex) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: order-stable lines of one wrap pass
													<Text key={lineIndex} color={theme.text.muted} wrap="truncate-end">
														{'     '}
														{line}
													</Text>
												))
											: null}
									</Fragment>
								)
							})
						: agentWindow.items.map((agent, offset) => {
								const active = agentWindow.start + offset === selectedAgentIndex
								const glyph = agentDetailGlyph(agent)
								const queued = agent.status === 'queued' || agent.status === 'starting'
								return (
									<Box key={agent.viewId}>
										<Box width={2} flexShrink={0}>
											<Text color={theme.accent.assistant}>{active ? '❯' : ' '}</Text>
										</Box>
										<Box width={2} flexShrink={0}>
											<Text color={glyph.color}>{glyph.text}</Text>
										</Box>
										<Box flexGrow={1} flexShrink={1} minWidth={0}>
											<Text
												color={active ? theme.accent.assistant : theme.text.primary}
												bold={active}
												dimColor={agent.status === 'working' && !active}
												wrap="truncate-end"
											>
												{agentDetailLabel(agent)}
											</Text>
										</Box>
										<Box flexShrink={0} marginLeft={1}>
											<Text color={theme.text.muted}>
												{queued
													? 'queued'
													: formatElapsed(
															Math.max(0, (agent.completedAt ?? now) - agent.startedAt),
														)}
											</Text>
										</Box>
									</Box>
								)
							})}
					{level === 2 && emptyNote ? (
						<Text color={theme.text.muted} dimColor>
							{emptyNote}
						</Text>
					) : null}
				</Box>
				{footer}
			</Box>
		)
	}

	// Side by side. The detail text the phase declared fills the right pane's
	// free rows once its agents are listed.
	const detailLines =
		level === 1 && phase?.detail
			? wrapPhaseDetailLines(phase.detail, rightInner - 2).slice(0, PHASE_DETAIL_LINE_BUDGET)
			: []
	const showDetail =
		detailLines.length > 0 && detailLines.length + 1 + agentWindow.items.length <= pageSize
	// The phase's detail sits under its title, ahead of the agents, then a blank row.
	const detailRows = showDetail ? detailLines.length + 1 : 0
	const border = theme.border.default
	const leftTitle = ' Phases '
	const rightTitle = ` ${truncateChoiceText(agentsTitle, Math.max(1, rightInner - 4))} `
	const rows = Array.from({ length: pageSize }, (_, row) => row)
	return (
		<Box flexDirection="column" marginTop={1} marginLeft={-1} marginRight={-1} width={columns}>
			{header}
			<Box paddingX={1}>
				<Text wrap="truncate-end">
					<Text color={border}>╭</Text>
					<Text color={theme.text.primary} bold>
						{leftTitle}
					</Text>
					<Text color={border}>{'─'.repeat(Math.max(0, leftInner - stringWidth(leftTitle)))}┬</Text>
					<Text color={theme.text.primary} bold>
						{rightTitle}
					</Text>
					<Text color={border}>
						{'─'.repeat(Math.max(0, rightInner - stringWidth(rightTitle)))}╮
					</Text>
				</Text>
			</Box>
			{rows.map((row) => {
				const item = phaseWindow.items[row]
				const index = phaseWindow.start + row
				const phaseActive = level === 1 && index === selectedPhaseIndex
				const glyph = item ? phaseGlyph(item, index) : undefined
				const agentRow = row - detailRows
				const agent = agentRow >= 0 ? agentWindow.items[agentRow] : undefined
				const agentActive = level === 2 && agentWindow.start + agentRow === selectedAgentIndex
				const agentGlyph = agent ? agentDetailGlyph(agent) : undefined
				const queued = agent?.status === 'queued' || agent?.status === 'starting'
				const labelCells = Math.min(
					Math.max(0, ...agentWindow.items.map((value) => stringWidth(agentDetailLabel(value)))),
					Math.floor(rightInner * 0.45),
				)
				const detailRow = showDetail && row < detailLines.length ? row : -1
				return (
					<Box key={item?.id ?? `row-${row}`} paddingX={1}>
						<Text color={border}>│</Text>
						<Box width={leftInner} flexShrink={0}>
							{item && glyph ? (
								<Text wrap="truncate-end">
									{' '}
									<Text color={theme.accent.assistant}>{phaseActive ? '❯' : ' '}</Text>{' '}
									<Text color={glyph.color}>{glyph.text}</Text>{' '}
									<Text
										color={phaseActive ? theme.accent.assistant : theme.text.primary}
										bold={phaseActive}
										dimColor={glyph.outcome === 'not-started' && !phaseActive}
									>
										{padEndCells(oneLine(phaseTitle(item)), leftTitleCells)}
									</Text>{' '}
									<Text color={theme.text.muted}>
										{padStartCells(phaseCount(item, workflow.runStatus === 'stopped'), countCells)}
									</Text>
								</Text>
							) : null}
						</Box>
						<Text color={border}>│</Text>
						<Box width={rightInner} flexShrink={0}>
							{agent && agentGlyph ? (
								<>
									<Text color={theme.accent.assistant}>{agentActive ? '❯' : ' '}</Text>
									<Text> </Text>
									<Text color={agentGlyph.color}>{agentGlyph.text}</Text>
									<Text> </Text>
									<Box width={labelCells + 3} flexShrink={0}>
										<Text
											color={agentActive ? theme.accent.assistant : theme.text.primary}
											bold={agentActive}
											dimColor={agent.status === 'working' && !agentActive}
											wrap="truncate-end"
										>
											{agentDetailLabel(agent)}
										</Text>
									</Box>
									<Box flexGrow={1} flexShrink={1} minWidth={0}>
										<Text color={theme.text.muted} wrap="truncate-end">
											{agentDetailMeta(agent, columns)}
										</Text>
									</Box>
									<Box flexShrink={0} marginLeft={1}>
										<Text color={theme.text.muted}>
											{queued
												? 'queued'
												: formatElapsed(
														Math.max(0, (agent.completedAt ?? now) - agent.startedAt),
													)}{' '}
										</Text>
									</Box>
								</>
							) : detailRow >= 0 && detailLines[detailRow] !== undefined ? (
								<Text color={theme.text.muted} wrap="truncate-end">
									{'    '}
									{detailLines[detailRow]}
								</Text>
							) : row === detailRows && emptyNote ? (
								<Text color={theme.text.muted} dimColor wrap="truncate-end">
									{'  '}
									{emptyNote}
								</Text>
							) : null}
						</Box>
						<Text color={border}>│</Text>
					</Box>
				)
			})}
			<Box paddingX={1}>
				<Text wrap="truncate-end">
					<Text color={border}>╰</Text>
					<BorderSegment
						width={leftInner}
						tag={phases.length > pageSize ? windowTag(phaseWindow, phases.length) : undefined}
						color={border}
					/>
					<Text color={border}>┴</Text>
					<BorderSegment
						width={rightInner}
						tag={agents.length > pageSize ? windowTag(agentWindow, agents.length) : undefined}
						color={border}
					/>
					<Text color={border}>╯</Text>
				</Text>
			</Box>
			{footer}
		</Box>
	)
}

export function agentCockpitIsWide(terminalColumns: number): boolean {
	return Math.max(0, terminalColumns - COCKPIT_FRAME_COLUMNS) >= WIDE_COCKPIT_INNER_COLUMNS
}

/** Group retained work before exposing phases. Labels do not create execution dependencies. */
export function agentWorkflows(
	agents: readonly SubagentActivity[],
	runs: readonly WorkflowRunView[] = [],
): readonly AgentWorkflow[] {
	const groups = new Map<string, SubagentActivity[]>()
	for (const agent of agents) {
		const group = groups.get(agent.workflowGroupId)
		if (group) group.push(agent)
		else groups.set(agent.workflowGroupId, [agent])
	}
	const byRun = new Map(runs.map((run) => [run.groupId, run]))
	for (const run of runs) if (!groups.has(run.groupId)) groups.set(run.groupId, [])
	return [...groups]
		.map(([id, members]) => {
			const run = byRun.get(id)
			return {
				id,
				name: run?.name ?? workflowGroupName(members),
				startedAt: run
					? Math.min(run.startedAt, ...members.map((agent) => agent.startedAt))
					: Math.min(...members.map((agent) => agent.startedAt)),
				status: members.length > 0 ? phaseStatus(members) : 'working',
				phases: run ? runPhases(run, members) : agentPhases(members),
				agents: members,
				...(run
					? {
							runId: run.runId,
							description: run.description,
							runStatus: run.status,
							logs: run.logs,
						}
					: {}),
			} satisfies AgentWorkflow
		})
		.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
}

/**
 * A run's phases: the ones its agents are in, plus every phase the script
 * declared or announced that has no agent yet, in the script's order.
 */
function runPhases(
	run: WorkflowRunView,
	members: readonly SubagentActivity[],
): readonly AgentPhase[] {
	const started = new Map(agentPhases(members).map((phase) => [phase.id, phase]))
	const ordered: AgentPhase[] = []
	for (const phase of [...run.phases].sort((a, b) => a.index - b.index)) {
		const id = runPhaseId(run, phase.index)
		const existing = started.get(id)
		started.delete(id)
		ordered.push(
			existing ?? {
				id,
				workflowId: run.workflowId,
				workflow: run.name,
				name: phase.title,
				order: phase.index,
				...(phase.detail !== undefined ? { detail: phase.detail } : {}),
				sequence: phase.index,
				startedAt: run.startedAt,
				status: 'queued',
				agents: [],
			},
		)
	}
	// Agents the script never gave a phase come last, as one group.
	return [...ordered, ...started.values()]
}

/**
 * A group's display name. An explicit, shared `workflow` label names it
 * directly; a group whose agents never set one (the unlabelled default —
 * `agentWorkflows` still groups them by batch, so two unrelated unlabelled
 * batches are two separate groups here) never uses that default's literal
 * text, which describes none of them in particular and is indistinguishable
 * from any other unlabelled group's name. It gets a neutral name built from
 * its own members instead, so two unlabelled groups stay tellable apart in
 * a list — the first member's title, plus a `+N` count when there are more,
 * or a plain agent count when even a title is missing.
 */
function workflowGroupName(members: readonly SubagentActivity[]): string {
	const label = members[0]?.workflow
	if (label !== undefined && label !== DEFAULT_AGENT_WORKFLOW) return label
	const title = oneLine(members[0]?.description || members[0]?.agentId || '').trim()
	if (!title) return `${members.length} agent${members.length === 1 ? '' : 's'}`
	return members.length > 1 ? `${title} +${members.length - 1}` : title
}

export function agentWorkflowPageSize(terminalRows: number): number {
	return Math.max(1, Math.min(MAX_PICKER_ROWS, terminalRows - 10))
}

export function agentPhases(agents: readonly SubagentActivity[]): readonly AgentPhase[] {
	const records = new Map<
		string,
		{
			workflowId: string
			workflow: string
			name: string
			order?: number
			detail?: string
			sequence: number
			startedAt: number
			agents: SubagentActivity[]
		}
	>()
	const workflowStartedAt = new Map<string, number>()
	for (const agent of agents) {
		const id = agent.phaseId
		const current = records.get(id)
		if (current) {
			current.startedAt = Math.min(current.startedAt, agent.startedAt)
			current.agents.push(agent)
		} else {
			records.set(id, {
				workflowId: agent.workflowId,
				workflow: agent.workflow,
				name: agent.phase,
				...(agent.phaseOrder !== undefined ? { order: agent.phaseOrder } : {}),
				...(agent.phaseDetail !== undefined ? { detail: agent.phaseDetail } : {}),
				sequence: agent.phaseSequence,
				startedAt: agent.startedAt,
				agents: [agent],
			})
		}
		workflowStartedAt.set(
			agent.workflowId,
			Math.min(workflowStartedAt.get(agent.workflowId) ?? agent.startedAt, agent.startedAt),
		)
	}
	return [...records.entries()]
		.map(([id, phase]) => ({
			id,
			workflowId: phase.workflowId,
			workflow: phase.workflow,
			name: phase.name,
			...(phase.order !== undefined ? { order: phase.order } : {}),
			...(phase.detail !== undefined ? { detail: phase.detail } : {}),
			sequence: phase.sequence,
			startedAt: phase.startedAt,
			status: phaseStatus(phase.agents),
			agents: phase.agents,
		}))
		.sort((left, right) => {
			const workflowOrder =
				(workflowStartedAt.get(left.workflowId) ?? left.startedAt) -
				(workflowStartedAt.get(right.workflowId) ?? right.startedAt)
			if (workflowOrder !== 0) return workflowOrder
			const workflowName = left.workflow.localeCompare(right.workflow)
			if (workflowName !== 0) return workflowName
			if (left.order !== right.order) {
				if (left.order === undefined) return 1
				if (right.order === undefined) return -1
				return left.order - right.order
			}
			if (left.sequence !== right.sequence) return left.sequence - right.sequence
			return left.name.localeCompare(right.name)
		})
}

export function agentPhasePageSize(terminalRows: number, _wide = true): number {
	return workflowDetailPageSize(terminalRows)
}

export interface AgentTranscriptProps {
	readonly agent: SubagentActivity
	/** Number of physical display rows skipped backward from the live tail. */
	readonly tailOffset: number
	readonly terminalRows: number
	readonly terminalColumns: number
	/** Reserve more of a short terminal for the child's message editor. */
	readonly compact?: boolean
	readonly navigationHint?: string
	/** What Esc does here: `agents` returns to the cockpit list, `back` to the rail. */
	readonly escapeTo?: 'agents' | 'back'
}

/** Child screen; leave two parent footer rows and one terminal cursor row free. */
export function AgentTranscript({
	agent,
	tailOffset,
	terminalRows,
	terminalColumns,
	compact = false,
	navigationHint,
	escapeTo = 'agents',
}: AgentTranscriptProps) {
	const page = agentTranscriptPage(
		agent,
		tailOffset,
		terminalRows + (compact ? 3 : 0),
		terminalColumns,
	)
	// A replayed child whose saved record never got an ending still has no
	// clock running: ticking one would be the same claim the banner denies.
	const now = useLiveNow(!agent.replayed && agent.completedAt === undefined)
	const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
	const tailLabel = isTerminalStatus(agent.status) ? 'Latest' : 'Live'
	const meta = agentMetaParts(agent, {
		showModel: terminalColumns >= 50,
		showCounters: terminalColumns >= 70,
	})
	const navigation =
		navigationHint ??
		fitHints(
			[
				{ text: 'PgUp/PgDn', short: '↑↓ scroll', rank: 2 },
				{ text: 'Home oldest', rank: 1 },
				{ text: `End ${tailLabel.toLowerCase()}`, rank: 1 },
				escapeTo === 'back'
					? { text: 'esc back', rank: 5 }
					: { text: 'esc agents', short: 'esc list', rank: 5 },
				{ text: 'q main', rank: 5 },
			],
			Math.max(1, terminalColumns - 4),
		)

	return (
		<Box
			flexDirection="column"
			height={page.pageSize + (compact ? 5 : 8) + transcriptBannerRows(agent)}
			flexShrink={0}
			borderStyle="single"
			borderColor={theme.accent.assistant}
			paddingX={1}
			overflow="hidden"
		>
			<Box justifyContent="space-between" height={1} flexShrink={0}>
				<Box flexGrow={1} minWidth={0}>
					<Text color={theme.accent.assistant} bold wrap="truncate-end">
						{compact
							? oneLine(agent.agentId)
							: agent.workflowRunId !== undefined
								? terminalDisplayText(
										`${oneLine(agent.workflow)} · ${oneLine(phaseTitle({ name: agent.phase }))}`,
									)
								: 'Subagent'}
					</Text>
				</Box>
				<Box flexShrink={0}>
					<Text color={statusColor(agent.status)} wrap="truncate-end">
						{statusLabel(agent.status)}
						{terminalColumns >= 40 ? ` · ${elapsed}` : ''}
					</Text>
				</Box>
			</Box>
			{compact ? null : (
				<Box height={1} flexShrink={0}>
					<Box flexGrow={1} flexShrink={1} minWidth={0}>
						<Text color={theme.text.primary} bold wrap="truncate-end">
							{oneLine(agent.description || agent.agentId)}
						</Text>
					</Box>
					{meta.length > 0 ? (
						<Box flexShrink={0} marginLeft={1}>
							<Text color={theme.text.muted} wrap="truncate-end">
								{meta.join(' · ')}
							</Text>
						</Box>
					) : null}
				</Box>
			)}
			{agent.replayed ? (
				<Box height={1} flexShrink={0}>
					<Text color={theme.status.warn} wrap="truncate-end">
						{REPLAYED_TRANSCRIPT_NOTICE}
					</Text>
				</Box>
			) : null}
			<Box flexDirection="column" marginTop={compact ? 0 : 1} height={page.pageSize} flexShrink={0}>
				{page.rows.length === 0 ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						{agent.replayed
							? 'The saved record has no output for this agent.'
							: 'Waiting for agent output…'}
					</Text>
				) : (
					page.rows.map((line) => (
						<Box key={line.id} height={1} flexShrink={0} overflow="hidden">
							<Box width={3} flexShrink={0}>
								<Text
									color={
										line.source !== 'prompt' && line.source.kind === 'tool'
											? statusColor(line.source.status)
											: lineColor(line)
									}
								>
									{line.continuation ? ' ' : lineGlyph(line)}
								</Text>
							</Box>
							<Box flexGrow={1} minWidth={0}>
								<Text color={lineColor(line)} wrap="truncate-end">
									{line.text}
								</Text>
							</Box>
						</Box>
					))
				)}
			</Box>
			<Box flexDirection="column" marginTop={compact ? 0 : 1} height={2} flexShrink={0}>
				<Text color={theme.text.muted} wrap="truncate-end">
					{page.last === page.total ? tailLabel : 'History'} ·{' '}
					{page.total === 0 ? '0/0' : `${page.first}-${page.last}/${page.total}`}
				</Text>
				<Text color={theme.text.muted} wrap="truncate-end">
					{navigation}
				</Text>
			</Box>
		</Box>
	)
}

/** Rows the viewed agent's transcript gets: what is left once the composer, footer line and rail are drawn. */
export function agentViewPageRows(terminalRows: number, railRows: number): number {
	// Composer frame (rule, one input row, rule), the footer line, the rail's rows.
	return Math.max(3, terminalRows - 4 - railRows - 1)
}

/** How far a viewed transcript can be scrolled back from its tail. */
export function maxAgentViewTailOffset(
	agent: SubagentActivity,
	pageRows: number,
	terminalColumns: number,
): number {
	return Math.max(0, agentTranscriptRows(agent, terminalColumns + 5).length - pageRows)
}

export interface AgentViewProps {
	readonly agent: SubagentActivity
	/** Display rows skipped back from the live tail. */
	readonly tailOffset: number
	readonly pageRows: number
	readonly terminalColumns: number
	/** One plain sentence about the last message that could not be sent. */
	readonly notice?: string | undefined
}

/**
 * The transcript of the agent being viewed, drawn as part of the main screen:
 * no box, no header, no tail counter. The agent's own prompt and what you sent
 * it read as your rows (`❯`), what it said as `●`; its state is on the rail row
 * below, and the one main composer under this stays live. Bottom-aligned, so the
 * newest row sits against the composer.
 */
export function AgentView({
	agent,
	tailOffset,
	pageRows,
	terminalColumns,
	notice,
}: AgentViewProps) {
	const lines = agentTranscriptRows(agent, terminalColumns + 5)
	const room = Math.max(1, pageRows - (notice ? 1 : 0))
	const offset = Math.min(Math.max(0, tailOffset), Math.max(0, lines.length - room))
	const end = lines.length - offset
	const shown = lines.slice(Math.max(0, end - room), end)
	return (
		<Box flexDirection="column" height={pageRows} flexShrink={0} justifyContent="flex-end">
			{shown.length === 0 ? (
				<Text color={theme.text.muted}>Waiting for output…</Text>
			) : (
				shown.map((line) => (
					<Box key={line.id} height={1} flexShrink={0} overflow="hidden">
						<Box width={2} flexShrink={0}>
							<Text
								color={
									line.source !== 'prompt' && line.source.kind === 'tool'
										? statusColor(line.source.status)
										: lineColor(line)
								}
								bold={isOperatorLine(line)}
							>
								{line.continuation ? ' ' : lineGlyph(line)}
							</Text>
						</Box>
						<Box flexGrow={1} minWidth={0}>
							<Text color={lineColor(line)} bold={isOperatorLine(line)} wrap="truncate-end">
								{line.text}
							</Text>
						</Box>
					</Box>
				))
			)}
			{notice ? (
				<Text color={theme.status.warn} wrap="truncate-end">
					{notice}
				</Text>
			) : null}
		</Box>
	)
}

function isOperatorLine(line: AgentTranscriptLine): boolean {
	return (
		line.source === 'prompt' ||
		(line.source.kind === 'system' && line.source.direction === 'operator-to-child')
	)
}

export function agentPickerPageSize(terminalRows: number, _wide = true): number {
	return workflowDetailPageSize(terminalRows)
}

/**
 * Rows one transcript header claims beyond the fixed chrome.
 *
 * A replayed child spends one on its banner. It comes out of the page rather
 * than growing the box, because the box is already sized to leave the parent
 * its two footer rows and the terminal its cursor row — a box one row taller
 * would take the cursor row, on the one screen where the extra row exists to
 * stop a misreading rather than to show more of the turn.
 */
function transcriptBannerRows(agent: SubagentActivity): number {
	return agent.replayed ? 1 : 0
}

export function agentTranscriptPageSize(terminalRows: number, reservedRows = 0): number {
	// Parent footer, cursor row, borders, heading, title, spacing and navigation.
	return Math.max(1, terminalRows - 11 - reservedRows)
}

export function maxAgentTranscriptTailOffset(
	agent: SubagentActivity,
	terminalRows: number,
	terminalColumns: number,
): number {
	return Math.max(
		0,
		agentTranscriptRows(agent, terminalColumns).length -
			agentTranscriptPageSize(terminalRows, transcriptBannerRows(agent)),
	)
}

export function agentTranscriptPage(
	agent: SubagentActivity,
	tailOffset: number,
	terminalRows: number,
	terminalColumns: number,
): {
	readonly rows: readonly AgentTranscriptLine[]
	readonly pageSize: number
	readonly first: number
	readonly last: number
	readonly total: number
} {
	const pageSize = agentTranscriptPageSize(terminalRows, transcriptBannerRows(agent))
	const rows = agentTranscriptRows(agent, terminalColumns)
	const total = rows.length
	const offset = Math.min(Math.max(0, tailOffset), Math.max(0, total - pageSize))
	const end = Math.max(0, total - offset)
	const start = Math.max(0, end - pageSize)
	return {
		rows: rows.slice(start, end),
		pageSize,
		first: total === 0 ? 0 : start + 1,
		last: end,
		total,
	}
}

export interface AgentTranscriptLine {
	readonly id: string
	readonly text: string
	readonly continuation: boolean
	readonly source: 'prompt' | SubagentActivity['transcript'][number]
}

/** Wrap before paging so every retained character remains reachable. */
export function agentTranscriptRows(
	agent: SubagentActivity,
	terminalColumns: number | undefined,
): readonly AgentTranscriptLine[] {
	const sources: readonly {
		readonly id: string
		readonly text: string
		readonly source: AgentTranscriptLine['source']
	}[] = [
		{ id: `${agent.viewId}:prompt`, text: agent.prompt, source: 'prompt' },
		...agent.transcript.map((row) => ({
			id: row.id,
			text: transcriptRowText(row),
			source: row,
		})),
	]
	// App padding, border, overlay padding and the three-cell glyph column sit
	// outside this text. Conservative cell counting may wrap early but never
	// hides a suffix.
	const width = Math.max(1, (terminalColumns ?? 80) - 10)
	const lines: AgentTranscriptLine[] = []
	for (const source of sources) {
		let sourceLine = 0
		for (const logical of terminalDisplayText(source.text).split('\n')) {
			let text = ''
			let cells = 0
			let continuation = sourceLine > 0
			for (const { segment: point } of graphemes.segment(expandTabs(logical))) {
				const pointCells = stringWidth(point)
				while (text.length > 0 && cells + pointCells > width) {
					// Prefer a word boundary, retaining whitespace so paging never
					// drops content. Unbroken URLs/code still split at graphemes.
					const boundary = text.lastIndexOf(' ') + 1
					const split =
						boundary > 0 && text.slice(0, boundary).trim().length > 0 ? boundary : text.length
					const rest = text.slice(split)
					lines.push({
						id: `${source.id}:${sourceLine++}`,
						text: text.slice(0, split),
						continuation,
						source: source.source,
					})
					text = rest
					cells = stringWidth(rest)
					continuation = true
				}
				text += point
				cells += pointCells
			}
			lines.push({
				id: `${source.id}:${sourceLine++}`,
				text,
				continuation,
				source: source.source,
			})
		}
	}
	return lines
}

/** Resolve indentation before paging; raw tabs can move the terminal beyond a row's box. */
function expandTabs(line: string): string {
	let text = ''
	let cells = 0
	for (const { segment } of graphemes.segment(line)) {
		const point = segment === '\t' ? ' '.repeat(8 - (cells % 8)) : segment
		text += point
		cells += stringWidth(point)
	}
	return text
}

function oneLine(text: string): string {
	return terminalDisplayText(text).replace(/\r?\n/g, ' ↵ ').replace(/\t/g, ' ⇥ ')
}

/** `42.1k`, `1.38M`; below 1,000 the exact count is short enough to show plainly. */
export { formatCompactCount }

/**
 * `undefined` when this child has reported neither figure — there is nothing
 * to show yet, which is different from having spent or called zero. Once
 * spend is known but the tool count is not (or vice versa), the missing half
 * renders as an em dash rather than a fabricated 0.
 */
function agentCounterText(agent: SubagentActivity): string | undefined {
	if (agent.tokens === undefined && agent.toolCalls === undefined) return undefined
	const tokens = agent.tokens !== undefined ? formatCompactCount(agent.tokens) : '—'
	if (agent.toolCalls === undefined) return tokens
	return `${tokens} · ${agent.toolCalls} ${agent.toolCalls === 1 ? 'tool' : 'tools'}`
}

/**
 * Ordered so a caller can drop the least essential piece first: counters
 * need the most room, the model name less, the saved marker none at all, and
 * the description (rendered separately by every caller) never yields to any
 * of them.
 */
function agentMetaParts(
	agent: SubagentActivity,
	options: { readonly showModel: boolean; readonly showCounters: boolean },
): readonly string[] {
	const parts: string[] = []
	// Unconditional, and first, because it is the only part here that changes
	// what the row MEANS rather than describing the work: a saved row reports
	// a child that finished in some other process. Five cells is a price worth
	// paying at every width to keep a past turn from reading as a present one.
	if (agent.replayed) parts.push('saved')
	if (options.showModel && agent.model) {
		parts.push(truncateChoiceText(agent.model, MAX_MODEL_LABEL_WIDTH))
	}
	const counters = options.showCounters ? agentCounterText(agent) : undefined
	if (counters) parts.push(counters)
	return parts
}

function phaseStatus(agents: readonly SubagentActivity[]): SubagentActivityStatus {
	if (agents.some((agent) => agent.status === 'failed')) return 'failed'
	if (agents.some((agent) => agent.status === 'working')) return 'working'
	if (agents.some((agent) => agent.status === 'queued')) return 'queued'
	if (agents.some((agent) => agent.status === 'starting')) return 'starting'
	if (agents.some((agent) => agent.status === 'cancelled')) return 'cancelled'
	return 'completed'
}

/**
 * Word-wrap phase detail text to `width` cells. An unbroken word wider than
 * the pane still occupies exactly one line — `wrap="truncate-end"` on the
 * rendered `Text` clips it visually rather than this function breaking a
 * word or growing the line count.
 */
function wrapPhaseDetailLines(text: string, width: number): readonly string[] {
	const safeWidth = Math.max(1, width)
	const words = oneLine(text)
		.split(' ')
		.filter((word) => word.length > 0)
	const lines: string[] = []
	let line = ''
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word
		if (line && stringWidth(candidate) > safeWidth) {
			lines.push(line)
			line = word
		} else {
			line = candidate
		}
	}
	if (line) lines.push(line)
	return lines
}

function isTerminalStatus(status: SubagentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function statusGlyph(status: SubagentActivityStatus): string {
	switch (status) {
		case 'starting':
		case 'queued':
			return '◌'
		case 'working':
			return '●'
		case 'completed':
			return '✓'
		case 'failed':
			return '✗'
		case 'cancelled':
			return '○'
	}
}

function statusLabel(status: SubagentActivityStatus): string {
	return status[0]?.toUpperCase() + status.slice(1)
}

function statusColor(status: SubagentActivityStatus): string {
	switch (status) {
		case 'completed':
			return theme.text.secondary
		case 'failed':
			return theme.status.error
		case 'starting':
		case 'queued':
		case 'working':
			return theme.accent.assistant
		case 'cancelled':
			return theme.text.muted
	}
}

function lineGlyph(line: AgentTranscriptLine): string {
	if (line.source === 'prompt') return '❯'
	return rowGlyph(line.source)
}

function rowGlyph(row: SubagentActivity['transcript'][number]): string {
	if (row.kind === 'assistant') return '●'
	if (row.kind === 'system')
		return row.direction === 'operator-to-child' ? '❯' : row.direction === 'to-child' ? '←' : '·'
	return row.status === 'working' ? '◌' : row.status === 'failed' ? '✗' : '✓'
}

/**
 * An accepted `send_message` renders as `← queued from main: …` — the arrow is
 * the row's own glyph (`rowGlyph`), so only the label goes here. Every other
 * row kind keeps its own text unchanged.
 */
function transcriptRowText(row: SubagentActivity['transcript'][number]): string {
	if (row.kind === 'tool' && row.detail) return `${row.text}\n${row.detail}`
	if (row.kind === 'system' && row.direction === 'to-child') return `queued from main: ${row.text}`
	// What you typed to the agent reads as your own row.
	if (row.kind === 'system' && row.direction === 'operator-to-child') return row.text
	return row.text
}

function lineColor(line: AgentTranscriptLine): string {
	if (line.source === 'prompt') return theme.text.secondary
	return rowColor(line.source)
}

function rowColor(row: SubagentActivity['transcript'][number]): string {
	if (row.kind === 'assistant') return theme.text.primary
	if (row.kind === 'system') return theme.text.muted
	return row.status === 'failed' ? theme.status.error : theme.text.secondary
}

function useLiveNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!active) return
		const timer = setInterval(() => setNow(Date.now()), 1_000)
		timer.unref?.()
		return () => clearInterval(timer)
	}, [active])
	return now
}
