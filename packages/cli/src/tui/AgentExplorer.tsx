import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import stringWidth from 'string-width'

import {
	DEFAULT_AGENT_PHASE,
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
	type SubagentActivityStatus,
	type SubagentNarrationLine,
} from '../integrations/subagents/activity.js'
import { formatElapsed } from './LiveActivity.js'
import { selectionWindow } from './selection-window.js'
import { terminalDisplayText } from './terminal-display.js'
import { truncateChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

const MAX_PICKER_ROWS = 9
const COCKPIT_FRAME_COLUMNS = 4
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
	'Replayed from saved evidence. This child cannot be continued.'
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
		// paddingX 2 lands the text where the rail's title starts — past its
		// two-cell header glyph — so the two columns line up.
		<Box flexDirection="column" paddingX={2}>
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

export interface AgentTaskPanelProps {
	readonly agents: readonly SubagentActivity[]
	readonly terminalRows: number
	readonly terminalColumns: number
	/**
	 * Draw the header line only. Used while a review owns the screen: the
	 * operator still sees that the work they already approved is moving,
	 * without the rows competing with the question being asked.
	 */
	readonly compact?: boolean
}

/**
 * Compact, automatic view of every cohort that still owns live work.
 *
 * This is intentionally not a modal: the composer remains mounted directly
 * above it and the operator can keep typing while children run. Completed
 * siblings remain until their last live sibling settles, then the whole
 * cohort leaves this projection together.
 *
 * Drawn as a borderless tree aligned with the transcript's own gutter — a
 * header line, then one `├`/`└` branch per agent with its latest activity on
 * a `⎿` line beneath it — rather than as a boxed panel: the rows are the
 * turn's live work, not chrome around it.
 */
export function AgentTaskPanel({
	agents,
	terminalRows,
	terminalColumns,
	compact = false,
}: AgentTaskPanelProps) {
	const now = useLiveNow(true)
	const activityLines = agentTaskPanelShowsActivity(terminalRows)
	const pageSize = agentTaskPanelPageSize(terminalRows)
	const active = agents.filter((agent) => !isTerminalStatus(agent.status)).length
	const workflows = [...new Set(agents.map((agent) => agent.workflow))]
	const workflowLabel = workflows.length === 1 ? workflows[0] : undefined
	// A shared, explicitly supplied workflow label earns the title slot; an
	// absent one (every agent still carries the unlabelled default) or a mix
	// of several distinct labels falls back to a neutral count instead of the
	// generic default name, which named nothing about THESE agents.
	const labelled = workflowLabel !== undefined && workflowLabel !== DEFAULT_AGENT_WORKFLOW
	const title = labelled
		? workflowLabel
		: `${agents.length} agent${agents.length === 1 ? '' : 's'}`
	const narrow = terminalColumns < 64
	const showModel = !narrow && terminalColumns >= 76
	const showCounters = !narrow && terminalColumns >= 96
	// A workflow the model split into several phases is drawn the way its
	// phases went: a settled phase is one line (`✓ Phase 1 · 2/2 · 3.9s`), a
	// live one is its line with its agents beneath it. One phase is drawn as
	// before, the agents straight under the header.
	const phases = agentPhases(agents)
	const phased = phases.length > 1
	const groups = (phased ? phases : [{ id: 'all', agents } as const]).map((phase) => ({
		phase: phased ? (phase as AgentPhase) : undefined,
		agents: [...phase.agents],
	}))
	// The page budget is spent on agents of live phases only; a settled
	// phase costs its one line, and on a short screen not even that.
	let budget = compact ? 0 : pageSize
	const drawn = groups.map((group) => {
		const settled = group.phase !== undefined && isTerminalStatus(group.phase.status)
		if (settled) return { ...group, settled, visible: [] as SubagentActivity[] }
		const visible = group.agents.slice(0, Math.max(0, budget))
		budget -= visible.length
		return { ...group, settled, visible }
	})
	const hidden = compact
		? 0
		: drawn.reduce(
				(sum, group) => sum + (group.settled ? 0 : group.agents.length - group.visible.length),
				0,
			)
	const showSettledPhases = !compact && activityLines
	const running = agents.filter(
		(agent) => agent.status === 'working' || agent.status === 'starting',
	).length
	const queued = agents.filter((agent) => agent.status === 'queued').length
	const done = agents.length - active
	const startedAt = Math.min(...agents.map((agent) => agent.startedAt))
	const spent = agents.reduce<number | undefined>(
		(sum, agent) => (agent.tokens === undefined ? sum : (sum ?? 0) + agent.tokens),
		undefined,
	)
	// Narrow or wide, the count is the reference's `done/total`, the same
	// figure the cockpit header and each phase line carry, so one moment
	// never reads as two different numbers.
	const counts = narrow
		? `${done}/${agents.length} done${hidden > 0 ? ` +${hidden}` : ''}`
		: [
				`${running} running`,
				...(queued > 0 ? [`${queued} queued`] : []),
				// The reference's own counter: how much of this workflow is done.
				...(done > 0 ? [`${done}/${agents.length} done`] : []),
				...(showCounters
					? [
							formatElapsed(Math.max(0, now - startedAt)),
							...(spent !== undefined ? [`${formatCompactCount(spent)} tokens`] : []),
						]
					: []),
				// A review owns the keyboard, so neither key reaches the rail while
				// the panel is reduced for one: it names no key it cannot keep.
				...(compact ? [] : ['↓ / ctrl+t']),
			].join(' · ')

	return (
		<Box flexDirection="column">
			<Box>
				<Box width={2} flexShrink={0}>
					<Text color={active > 0 ? theme.accent.assistant : theme.status.ok}>
						{active > 0 ? '●' : '✓'}
					</Text>
				</Box>
				<Box flexShrink={1} minWidth={0}>
					<Text color={theme.text.primary} bold wrap="truncate-end">
						{terminalDisplayText(title)}
					</Text>
				</Box>
				<Box flexShrink={0}>
					<Text color={theme.text.muted}> · {counts}</Text>
				</Box>
			</Box>
			{drawn.map((group) => {
				const phase = group.phase
				if (phase && group.settled && !showSettledPhases) return null
				const indent = phase ? 4 : 2
				return (
					<Box key={phase?.id ?? 'all'} flexDirection="column">
						{phase ? (
							<Box paddingLeft={2}>
								<Box width={2} flexShrink={0}>
									<Text color={statusColor(phase.status)}>{statusGlyph(phase.status)}</Text>
								</Box>
								<Box flexShrink={1} minWidth={0}>
									<Text
										color={group.settled ? theme.text.secondary : theme.text.primary}
										wrap="truncate-end"
									>
										{oneLine(phase.name)}
									</Text>
								</Box>
								<Box flexShrink={0}>
									<Text color={theme.text.muted}>
										{' · '}
										{phaseProgress(phase)}
										{group.settled ? ` · ${formatElapsed(phaseElapsed(phase, now))}` : ''}
									</Text>
								</Box>
							</Box>
						) : null}
						{group.visible.map((agent, index) => {
							const last =
								index === group.visible.length - 1 &&
								group.agents.length === group.visible.length &&
								(phase !== undefined || hidden === 0)
							// Clamped: a child begun after this panel's last clock tick would
							// otherwise read `-0.0s` until the next one.
							const elapsed = formatElapsed(
								Math.max(0, (agent.completedAt ?? now) - agent.startedAt),
							)
							const meta = agentRailMetaParts(agent, { showModel, showCounters })
							const agentRunning = !isTerminalStatus(agent.status)
							const activity = agentRunning ? railActivity(agent) : undefined
							return (
								<Box key={agent.viewId} flexDirection="column">
									<Box paddingLeft={indent}>
										<Box width={2} flexShrink={0}>
											<Text color={theme.text.muted}>{last ? '└' : '├'}</Text>
										</Box>
										<Box width={2} flexShrink={0}>
											<Text color={statusColor(agent.status)}>{statusGlyph(agent.status)}</Text>
										</Box>
										<Box
											width={narrow ? undefined : 28 - (indent - 2)}
											flexGrow={narrow ? 1 : 0}
											flexShrink={1}
										>
											<Text color={theme.text.primary} wrap="truncate-end">
												{oneLine(agent.description || agent.agentId)}
											</Text>
										</Box>
										<Box flexGrow={narrow ? 0 : 1} flexShrink={1} marginLeft={1}>
											<Text color={theme.text.secondary} wrap="truncate-end">
												{agent.status === 'queued' ? 'queued' : elapsed}
												{!narrow && !activityLines && activity ? ` · ${activity}` : ''}
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
									{activityLines && activity ? (
										<Box paddingLeft={indent}>
											<Box width={4} flexShrink={0}>
												<Text color={theme.text.muted}>{last ? ' ' : '│'}</Text>
											</Box>
											<Box flexShrink={1} minWidth={0}>
												<Text color={theme.text.secondary} wrap="truncate-end">
													⎿ {activity}
												</Text>
											</Box>
										</Box>
									) : null}
								</Box>
							)
						})}
					</Box>
				)
			})}
			{hidden > 0 ? (
				<Box paddingLeft={2}>
					<Text color={theme.text.muted}>└ +{hidden} more · ctrl+t</Text>
				</Box>
			) : null}
		</Box>
	)
}

/**
 * Whether each running agent gets its own `⎿ activity` line. On a short
 * terminal the activity stays inline after the elapsed time instead, so the
 * rail keeps one row per agent where rows are scarcest.
 */
export function agentTaskPanelShowsActivity(terminalRows: number | undefined): boolean {
	return terminalRows !== undefined && Number.isFinite(terminalRows) && terminalRows >= 24
}

/**
 * Agents the compact panel may show without crowding the composer/footer.
 * An agent costs two rows where activity lines are drawn and one elsewhere,
 * so the budget in ROWS stays what it was when every agent took one.
 */
export function agentTaskPanelPageSize(terminalRows: number | undefined): number {
	if (terminalRows === undefined || !Number.isFinite(terminalRows)) return 2
	const rowsPerAgent = agentTaskPanelShowsActivity(terminalRows) ? 2 : 1
	return Math.max(1, Math.min(4, Math.floor((terminalRows - 12) / (3 * rowsPerAgent))))
}

/** What the running agent is doing now, or its status when it has said nothing yet. */
function railActivity(agent: SubagentActivity): string {
	if (agent.status === 'queued') return 'Waiting for a slot'
	return distinctActivity(agent) ?? statusLabel(agent.status)
}

/**
 * The rail's own ordering: tool uses and spend first, then the model, with
 * counters dropped first on a narrow screen. The saved marker, when present,
 * leads for the reason `agentMetaParts` gives.
 */
function agentRailMetaParts(
	agent: SubagentActivity,
	options: { readonly showModel: boolean; readonly showCounters: boolean },
): readonly string[] {
	const parts: string[] = []
	if (agent.replayed) parts.push('saved')
	if (options.showCounters) {
		if (agent.toolCalls !== undefined) {
			parts.push(`${agent.toolCalls} ${agent.toolCalls === 1 ? 'tool' : 'tools'}`)
		}
		if (agent.tokens !== undefined) parts.push(formatCompactCount(agent.tokens))
	}
	if (options.showModel && agent.model) {
		parts.push(truncateChoiceText(agent.model, MAX_MODEL_LABEL_WIDTH))
	}
	return parts
}

/**
 * Live cohorts plus their already-settled siblings. Terminal cohorts are
 * retained by the monitor for explicit history but never reappear here.
 */
export function activeSubagentCohorts(
	agents: readonly SubagentActivity[],
): readonly SubagentActivity[] {
	// Replayed rows are excluded before anything else, in BOTH directions:
	// they never appear in this panel, and a replayed row whose saved status
	// never reached a terminal value never makes a cohort look live. Saved
	// evidence describes work that ended in another process, and this panel
	// exists to say what is running now.
	const live = agents.filter((agent) => agent.replayed !== true)
	const activeCohorts = new Set(
		live.filter((agent) => !isTerminalStatus(agent.status)).map(agentCohortKey),
	)
	return live.filter((agent) => activeCohorts.has(agentCohortKey(agent)))
}

/**
 * What stays on the rail together. A labelled workflow is one cohort across
 * every batch of its parent turn, so a settled Phase 1 is still drawn while
 * Phase 2 runs; an unlabelled batch is its own cohort, as it always was
 * (`workflowGroupId` is exactly that split, made by the monitor).
 */
function agentCohortKey(agent: SubagentActivity): string {
	return agent.workflowGroupId
}

export type AgentCockpitFocus = 'workflows' | 'phases' | 'agents'

export interface AgentWorkflow {
	readonly id: string
	readonly name: string
	readonly startedAt: number
	readonly status: SubagentActivityStatus
	readonly phases: readonly AgentPhase[]
	readonly agents: readonly SubagentActivity[]
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
	selectedPhaseId,
	selectedId,
	focus,
	terminalRows,
	terminalColumns,
}: AgentCockpitProps) {
	const workflows = agentWorkflows(agents)
	const workflowIndex = Math.max(
		0,
		workflows.findIndex((workflow) => workflow.phases.some((phase) => phase.id === selectedPhaseId)),
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
	const active = workflow?.agents.filter((agent) => !isTerminalStatus(agent.status)).length ?? 0
	const wide = agentCockpitIsWide(terminalColumns)
	const compact = terminalRows < 20
	const sideBySide = wide
	const phasePaneWidth = sideBySide
		? Math.max(24, Math.min(36, Math.floor(terminalColumns * 0.3)))
		: undefined
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
								<Text color={theme.text.primary} bold={item.id === workflow?.id} wrap="truncate-end">
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
						{terminalColumns >= 60
							? '↑↓ navigate · PgUp/PgDn jump · enter select · esc return'
							: '↑↓ · enter select · esc return'}
					</Text>
				</Box>
			</Box>
		)
	}
	const navigation =
		terminalColumns >= 90
			? '←→ pane · ↑↓ navigate · PgUp/PgDn jump · enter select · esc return'
			: terminalColumns >= 60
				? '←→ pane · ↑↓ navigate · enter select · esc return'
				: terminalColumns >= 38
					? '←→ pane · ↑↓ · enter · esc return'
					: 'enter · esc return'
	const totalWorkflowAgents = workflow?.agents.length ?? 0
	// Same rule as the automatic rail's title: an explicit label names this
	// workflow, an absent one (the unlabelled default) gets a neutral count
	// instead of the generic default name.
	const workflowTitle =
		selectedPhase?.workflow !== undefined && selectedPhase.workflow !== DEFAULT_AGENT_WORKFLOW
			? oneLine(selectedPhase.workflow)
			: `${totalWorkflowAgents} agent${totalWorkflowAgents === 1 ? '' : 's'} · ${active} running`

	return (
		<Box
			flexDirection="column"
			height={Math.max(8, terminalRows - COCKPIT_CHROME_ROWS)}
			borderStyle="single"
			borderColor={theme.border.default}
			paddingX={1}
		>
			<Box height={1} flexShrink={0}>
				<Box flexGrow={1} minWidth={0}>
					<Text color={theme.text.primary} bold wrap="truncate-end">
						{workflowTitle}
					</Text>
				</Box>
				<Box flexShrink={0} marginLeft={1}>
					<Text color={theme.text.muted} wrap="truncate-end">
						{workflow ? workflowProgress(workflow, now, terminalColumns) : ''}
					</Text>
				</Box>
			</Box>
			{compact ? null : (
				<Text color={theme.text.muted} wrap="truncate-end">
					{workflows.length > 1
						? 'Select a phase, then inspect a child. Esc returns to workflows.'
						: 'Select a phase, then inspect a child.'}
				</Text>
			)}
			<Box flexDirection={sideBySide ? 'row' : 'column'} flexGrow={1} paddingTop={compact ? 0 : 1}>
				<Box flexDirection="column" width={phasePaneWidth} flexShrink={0}>
					<PhasePane
						phases={phases}
						selected={selectedPhaseIndex}
						focused={focus === 'phases'}
						pageSize={compact ? 1 : agentPhasePageSize(terminalRows, wide)}
						paneWidth={phasePaneWidth ?? Math.max(1, terminalColumns - COCKPIT_FRAME_COLUMNS)}
						showDetail={!compact}
						now={now}
					/>
				</Box>
				{sideBySide ? (
					<Box
						width={1}
						marginX={1}
						flexShrink={0}
						borderStyle="single"
						borderColor={theme.border.default}
						borderTop={false}
						borderBottom={false}
						borderRight={false}
					/>
				) : null}
				<Box
					flexDirection="column"
					flexGrow={1}
					minWidth={0}
					paddingTop={sideBySide || compact ? 0 : 1}
				>
					<AgentPane
						agents={phaseAgents}
						{...(selectedPhase && selectedPhase.name !== DEFAULT_AGENT_PHASE
							? { phaseName: selectedPhase.name }
							: {})}
						selected={selectedAgentIndex}
						focused={focus === 'agents'}
						pageSize={compact ? 1 : agentPickerPageSize(terminalRows, wide)}
						now={now}
						wide={wide}
						terminalColumns={terminalColumns}
						detailWidth={Math.floor(
							Math.max(
								2,
								terminalColumns - COCKPIT_FRAME_COLUMNS - (phasePaneWidth ?? 0) - (sideBySide ? 3 : 0),
							) / 2,
						)}
					/>
				</Box>
			</Box>
			<Box paddingTop={compact ? 0 : 1}>
				<Text color={theme.text.muted} wrap="truncate-end">
					{navigation}
				</Text>
			</Box>
		</Box>
	)
}

function PhasePane({
	phases,
	selected,
	focused,
	pageSize,
	paneWidth,
	showDetail,
	now,
}: {
	readonly phases: readonly AgentPhase[]
	/** The cockpit's clock, for each phase's first-start-to-last-finish time. */
	readonly now: number
	readonly selected: number
	readonly focused: boolean
	readonly pageSize: number
	/** Wrap width for the focused phase's detail text; never affects row layout above it. */
	readonly paneWidth: number
	/**
	 * False in the compact (terminalRows < 20) cockpit layout, where the
	 * phase and agent panes already share a tight, stacked vertical budget
	 * that the detail band's rows were never accounted for — showing it
	 * there starves the agent pane of height and corrupts the frame. Compact
	 * mode already drops every other non-essential line (the subtitle text,
	 * the pane paddings); the detail band is dropped the same way, for the
	 * same reason.
	 */
	readonly showDetail: boolean
}) {
	const { start, items } = selectionWindow(phases, selected, pageSize)
	// A narrow pane keeps the count and gives the time up first.
	const showElapsed = paneWidth >= 28
	// "Focused" here is the phase carrying the `›` cursor, not which sub-pane
	// currently holds keyboard focus — the detail stays visible while the
	// operator drills into that phase's agents.
	const focusedPhase = phases[selected]
	const detailLines =
		showDetail && focusedPhase?.detail
			? wrapPhaseDetailLines(focusedPhase.detail, paneWidth).slice(0, PHASE_DETAIL_LINE_BUDGET)
			: []
	return (
		<>
			<Text color={focused ? theme.accent.assistant : theme.text.secondary} bold>
				{/* No count: every `N/M` beside a phase or a workflow reads done out
				    of total, so a cursor position here would read as progress. */}
				Phases
			</Text>
			{items.map((phase, visibleIndex) => {
				const active = start + visibleIndex === selected
				return (
					<Box key={phase.id}>
						<Box width={4} flexShrink={0}>
							<Text color={active && focused ? theme.accent.assistant : theme.text.muted}>
								{active ? '›' : ' '} {statusGlyph(phase.status)}
							</Text>
						</Box>
						<Box flexGrow={1} flexShrink={1}>
							<Text
								color={active ? theme.text.primary : theme.text.secondary}
								bold={active && focused}
								wrap="truncate-end"
							>
								{phase.order !== undefined ? `${phase.order + 1} ` : ''}
								{oneLine(phase.name)}
							</Text>
						</Box>
						<Box flexShrink={0} marginLeft={1}>
							<Text color={statusColor(phase.status)}>
								{phaseProgress(phase)}
								{showElapsed ? ` · ${formatElapsed(phaseElapsed(phase, now))}` : ''}
							</Text>
						</Box>
					</Box>
				)
			})}
			{detailLines.length > 0 ? (
				<Box
					flexDirection="column"
					height={PHASE_DETAIL_LINE_BUDGET}
					flexShrink={0}
					overflow="hidden"
					marginTop={1}
				>
					{detailLines.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-budget, order-stable lines of one wrap pass
						<Text key={index} color={theme.text.muted} wrap="truncate-end">
							{line}
						</Text>
					))}
				</Box>
			) : null}
		</>
	)
}

function AgentPane({
	agents,
	phaseName,
	selected,
	focused,
	pageSize,
	now,
	wide,
	terminalColumns,
	detailWidth,
}: {
	readonly agents: readonly SubagentActivity[]
	readonly phaseName?: string
	/**
	 * Cells for the status and meta half of a wide row, worked out from the
	 * pane's width. As `50%` the row came out one cell wider than its pane,
	 * and its last character sat on the frame's padding, touching the border.
	 */
	readonly detailWidth?: number
	readonly selected: number
	readonly focused: boolean
	readonly pageSize: number
	readonly now: number
	readonly wide: boolean
	readonly terminalColumns: number
}) {
	const { start, items } = selectionWindow(agents, selected, pageSize)
	const showModel = wide
	const showCounters = wide && terminalColumns >= 120
	return (
		<>
			<Text color={focused ? theme.accent.assistant : theme.text.secondary} bold wrap="truncate-end">
				{/* Titled by the phase it lists, as the reference's panel is: the
				    operator reads which phase these are without looking left. */}
				{phaseName !== undefined ? `${oneLine(phaseName)} · ` : ''}
				{agents.length} {agents.length === 1 ? 'agent' : 'agents'}
				{agents.length > pageSize ? ` · ${selected + 1}/${agents.length}` : ''}
			</Text>
			{items.map((agent, visibleIndex) => {
				const active = start + visibleIndex === selected
				const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
				const meta = agentMetaParts(agent, { showModel, showCounters })
				return (
					<Box key={agent.viewId}>
						<Box width={4} flexShrink={0}>
							<Text color={active && focused ? theme.accent.assistant : theme.text.muted}>
								{active ? '›' : ' '} {statusGlyph(agent.status)}
							</Text>
						</Box>
						<Box flexGrow={1} flexShrink={1} minWidth={0}>
							<Text
								color={active ? theme.text.primary : theme.text.secondary}
								bold={active && focused}
								wrap="truncate-end"
							>
								{oneLine(agent.description || agent.agentId)}
							</Text>
						</Box>
						<Box marginLeft={1} flexShrink={0} width={wide ? detailWidth : undefined}>
							<Box flexGrow={1} flexShrink={1} minWidth={0}>
								<Text color={theme.text.secondary} wrap="truncate-end">
									{statusLabel(agent.status)} ·{' '}
									{elapsed}
									{wide && distinctActivity(agent) ? ` · ${distinctActivity(agent)}` : ''}
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
					</Box>
				)
			})}
		</>
	)
}

export function agentCockpitIsWide(terminalColumns: number): boolean {
	return Math.max(0, terminalColumns - COCKPIT_FRAME_COLUMNS) >= WIDE_COCKPIT_INNER_COLUMNS
}

/** Group retained work before exposing phases. Labels do not create execution dependencies. */
export function agentWorkflows(agents: readonly SubagentActivity[]): readonly AgentWorkflow[] {
	const groups = new Map<string, SubagentActivity[]>()
	for (const agent of agents) {
		const group = groups.get(agent.workflowGroupId)
		if (group) group.push(agent)
		else groups.set(agent.workflowGroupId, [agent])
	}
	return [...groups]
		.map(([id, members]) => ({
			id,
			name: workflowGroupName(members),
			startedAt: Math.min(...members.map((agent) => agent.startedAt)),
			status: phaseStatus(members),
			phases: agentPhases(members),
			agents: members,
		}))
		.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
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

export function agentPhasePageSize(terminalRows: number, wide = true): number {
	const available = Math.max(2, terminalRows - (wide ? 10 : 12))
	return wide
		? Math.max(1, Math.min(MAX_PICKER_ROWS, available))
		: Math.max(1, Math.min(4, Math.floor(available * 0.4)))
}

export interface AgentTranscriptProps {
	readonly agent: SubagentActivity
	/** Number of physical display rows skipped backward from the live tail. */
	readonly tailOffset: number
	readonly terminalRows: number
	readonly terminalColumns: number
}

/** Child screen; leave two parent footer rows and one terminal cursor row free. */
export function AgentTranscript({
	agent,
	tailOffset,
	terminalRows,
	terminalColumns,
}: AgentTranscriptProps) {
	const page = agentTranscriptPage(agent, tailOffset, terminalRows, terminalColumns)
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
		terminalColumns >= 70
			? `PgUp/PgDn · Home oldest · End ${tailLabel.toLowerCase()} · esc agents · q parent`
			: terminalColumns >= 40
				? '↑↓ scroll · esc agents · q parent'
				: terminalColumns >= 30
					? '↑↓ · esc list · q parent'
					: 'esc list · q parent'

	return (
		<Box
			flexDirection="column"
			height={page.pageSize + 8 + transcriptBannerRows(agent)}
			flexShrink={0}
			borderStyle="single"
			borderColor={theme.accent.assistant}
			paddingX={1}
			overflow="hidden"
		>
			<Box justifyContent="space-between" height={1} flexShrink={0}>
				<Box flexGrow={1} minWidth={0}>
					<Text color={theme.accent.assistant} bold wrap="truncate-end">
						Subagent
					</Text>
				</Box>
				<Box flexShrink={0}>
					<Text color={statusColor(agent.status)} wrap="truncate-end">
						{statusLabel(agent.status)}
						{terminalColumns >= 40 ? ` · ${elapsed}` : ''}
					</Text>
				</Box>
			</Box>
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
			{agent.replayed ? (
				<Box height={1} flexShrink={0}>
					<Text color={theme.status.warn} wrap="truncate-end">
						{REPLAYED_TRANSCRIPT_NOTICE}
					</Text>
				</Box>
			) : null}
			<Box flexDirection="column" marginTop={1} height={page.pageSize} flexShrink={0}>
				{page.rows.length === 0 ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						{agent.replayed
							? 'Saved evidence recorded no output for this child.'
							: 'Waiting for child output…'}
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
			<Box flexDirection="column" marginTop={1} height={2} flexShrink={0}>
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

export function agentPickerPageSize(terminalRows: number, wide = true): number {
	const available = Math.max(2, terminalRows - (wide ? 10 : 12))
	return wide
		? Math.max(1, Math.min(MAX_PICKER_ROWS, available))
		: Math.max(1, Math.min(MAX_PICKER_ROWS, available - agentPhasePageSize(terminalRows, false)))
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
					const split = boundary > 0 && text.slice(0, boundary).trim().length > 0
						? boundary : text.length
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
export function formatCompactCount(value: number): string {
	if (value < 1_000) return String(value)
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
	return `${(value / 1_000_000).toFixed(2)}M`
}

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

function distinctActivity(agent: SubagentActivity): string | undefined {
	const activity = agent.latestActivity ? oneLine(agent.latestActivity) : undefined
	if (!activity || activity.toLowerCase() === agent.status) return undefined
	const prefix = `${statusLabel(agent.status)} · `
	return activity.startsWith(prefix) ? activity.slice(prefix.length) : activity
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
 * The cockpit's summary of one workflow, in the reference's terms: how many
 * agents are done, how long it has run, what it has spent, and how it ended
 * once nothing is left running: `1/3 agents done · 2 running · 5.2s · 18.0k
 * tokens`, then `3/3 agents · 12s · 27.0k tokens · done` (or `failed`).
 */
function workflowProgress(workflow: AgentWorkflow, now: number, columns: number): string {
	const agents = workflow.agents
	const running = agents.filter((agent) => !isTerminalStatus(agent.status)).length
	const done = agents.length - running
	const ending = workflow.status === 'completed' ? 'done' : workflow.status
	// The title beside this keeps its room: below 60 columns only the count
	// and the ending, then the time from 70, the spend from 100.
	if (columns < 60) return running > 0 ? `${done}/${agents.length} done` : `${done}/${agents.length} · ${ending}`
	const ends = agents.map((agent) => agent.completedAt ?? now)
	const elapsed = formatElapsed(Math.max(0, Math.max(...ends) - workflow.startedAt))
	const spent = agents.reduce<number | undefined>(
		(sum, agent) => (agent.tokens === undefined ? sum : (sum ?? 0) + agent.tokens),
		undefined,
	)
	const counters = [
		...(columns >= 70 ? [elapsed] : []),
		...(columns >= 100 && spent !== undefined ? [`${formatCompactCount(spent)} tokens`] : []),
	]
	return (
		running > 0
			? [`${done}/${agents.length} agents done`, `${running} running`, ...counters]
			: [`${done}/${agents.length} agents`, ...counters, ending]
	).join(' · ')
}

/** First start to last finish; a phase still running counts to `now`. */
function phaseElapsed(phase: AgentPhase, now: number): number {
	const ends = phase.agents.map((agent) => agent.completedAt ?? now)
	return Math.max(0, Math.max(...ends) - phase.startedAt)
}

function phaseProgress(phase: AgentPhase): string {
	const completed = phase.agents.filter((agent) => isTerminalStatus(agent.status)).length
	const failed = phase.agents.filter((agent) => agent.status === 'failed').length
	const cancelled = phase.agents.filter((agent) => agent.status === 'cancelled').length
	return [
		`${completed}/${phase.agents.length}`,
		...(failed > 0 ? [`failed ${failed}`] : []),
		...(cancelled > 0 ? [`cancelled ${cancelled}`] : []),
	].join(' · ')
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
	if (line.source === 'prompt') return '›'
	return rowGlyph(line.source)
}

function rowGlyph(row: SubagentActivity['transcript'][number]): string {
	if (row.kind === 'assistant') return '∴'
	if (row.kind === 'system') return row.direction === 'to-child' ? '←' : '·'
	return row.status === 'working' ? '◌' : row.status === 'failed' ? '✗' : '✓'
}

/**
 * A delivered `send_message` renders as `← from parent: …` — the arrow is
 * the row's own glyph (`rowGlyph`), so only the label goes here. Every other
 * row kind keeps its own text unchanged.
 */
function transcriptRowText(row: SubagentActivity['transcript'][number]): string {
	if (row.kind === 'tool' && row.detail) return `${row.text}\n${row.detail}`
	if (row.kind === 'system' && row.direction === 'to-child') return `from parent: ${row.text}`
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
