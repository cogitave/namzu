import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import stringWidth from 'string-width'

import type {
	SubagentActivity,
	SubagentActivityStatus,
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
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface AgentTaskPanelProps {
	readonly agents: readonly SubagentActivity[]
	readonly terminalRows: number
	readonly terminalColumns: number
}

/**
 * Compact, automatic view of every cohort that still owns live work.
 *
 * This is intentionally not a modal: the composer remains mounted directly
 * above it and the operator can keep typing while children run. Completed
 * siblings remain until their last live sibling settles, then the whole
 * cohort leaves this projection together.
 */
export function AgentTaskPanel({ agents, terminalRows, terminalColumns }: AgentTaskPanelProps) {
	const now = useLiveNow(true)
	const pageSize = agentTaskPanelPageSize(terminalRows)
	const visible = agents.slice(0, pageSize)
	const hidden = agents.length - visible.length
	const active = agents.filter((agent) => !isTerminalStatus(agent.status)).length
	const workflows = [...new Set(agents.map((agent) => agent.workflow))]
	const title = workflows.length === 1 ? (workflows[0] ?? 'Delegated work') : 'Delegated work'
	const narrow = terminalColumns < 64
	const showModel = !narrow && terminalColumns >= 76
	const showCounters = !narrow && terminalColumns >= 96

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor={theme.border.default}
			paddingX={1}
		>
			<Box>
				<Box flexGrow={1} flexShrink={1}>
					<Text color={theme.text.primary} bold wrap="truncate-end">
						{terminalDisplayText(title)}
					</Text>
				</Box>
				<Box flexShrink={0} marginLeft={1}>
					<Text color={theme.text.muted}>
						{narrow
							? `${active}/${agents.length}${hidden > 0 ? ` +${hidden}` : ''}`
							: `${active} active · ${agents.length} total${hidden > 0 ? ` · +${hidden} more` : ''} · ↓ / ctrl+t`}
					</Text>
				</Box>
			</Box>
			{visible.map((agent) => {
				const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
				const meta = agentMetaParts(agent, { showModel, showCounters })
				return (
					<Box key={agent.viewId}>
						<Box width={narrow ? 2 : 3} flexShrink={0}>
							<Text color={statusColor(agent.status)}>{statusGlyph(agent.status)}</Text>
						</Box>
						<Box width={narrow ? undefined : 28} flexGrow={narrow ? 1 : 0} flexShrink={1}>
							<Text color={theme.text.primary} wrap="truncate-end">
								{oneLine(agent.description || agent.agentId)}
							</Text>
						</Box>
						<Box flexGrow={narrow ? 0 : 1} flexShrink={1} marginLeft={1}>
							<Text color={theme.text.secondary} wrap="truncate-end">
								{elapsed}
								{!narrow && agent.latestActivity ? ` · ${oneLine(agent.latestActivity)}` : ''}
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
				)
			})}
		</Box>
	)
}

/** Rows the compact panel may spend without crowding the composer/footer. */
export function agentTaskPanelPageSize(terminalRows: number | undefined): number {
	if (terminalRows === undefined || !Number.isFinite(terminalRows)) return 2
	return Math.max(1, Math.min(4, Math.floor((terminalRows - 12) / 3)))
}

/**
 * Live cohorts plus their already-settled siblings. Terminal cohorts are
 * retained by the monitor for explicit history but never reappear here.
 */
export function activeSubagentCohorts(
	agents: readonly SubagentActivity[],
): readonly SubagentActivity[] {
	const activeCohorts = new Set(
		agents.filter((agent) => !isTerminalStatus(agent.status)).map(agentCohortKey),
	)
	return agents.filter((agent) => activeCohorts.has(agentCohortKey(agent)))
}

function agentCohortKey(agent: SubagentActivity): string {
	return JSON.stringify([agent.workflowId, agent.batchId])
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
				height={Math.max(8, terminalRows - 3)}
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

	return (
		<Box
			flexDirection="column"
			height={Math.max(8, terminalRows - 3)}
			borderStyle="single"
			borderColor={theme.border.default}
			paddingX={1}
		>
			<Box height={1} flexShrink={0}>
				<Box flexGrow={1} minWidth={0}>
					<Text color={theme.text.primary} bold wrap="truncate-end">
						{oneLine(selectedPhase?.workflow ?? 'Delegated work')}
					</Text>
				</Box>
				<Box flexShrink={0} marginLeft={1}>
					<Text color={theme.text.muted} wrap="truncate-end">
						{active} active · {workflow?.agents.length ?? 0} total
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
						selected={selectedAgentIndex}
						focused={focus === 'agents'}
						pageSize={compact ? 1 : agentPickerPageSize(terminalRows, wide)}
						now={now}
						wide={wide}
						terminalColumns={terminalColumns}
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
}: {
	readonly phases: readonly AgentPhase[]
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
				Phases {phases.length > 0 ? `· ${selected + 1}/${phases.length}` : ''}
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
							<Text color={statusColor(phase.status)}>{phaseProgress(phase)}</Text>
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
	selected,
	focused,
	pageSize,
	now,
	wide,
	terminalColumns,
}: {
	readonly agents: readonly SubagentActivity[]
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
			<Text color={focused ? theme.accent.assistant : theme.text.secondary} bold>
				Agents {agents.length > 0 ? `· ${selected + 1}/${agents.length}` : ''}
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
						<Box marginLeft={1} flexShrink={0} width={wide ? '50%' : undefined}>
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
			name: members[0]?.workflow ?? 'Delegated work',
			startedAt: Math.min(...members.map((agent) => agent.startedAt)),
			status: phaseStatus(members),
			phases: agentPhases(members),
			agents: members,
		}))
		.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
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
	const now = useLiveNow(agent.completedAt === undefined)
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
			height={page.pageSize + 8}
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
			<Box flexDirection="column" marginTop={1} height={page.pageSize} flexShrink={0}>
				{page.rows.length === 0 ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						Waiting for child output…
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

export function agentTranscriptPageSize(terminalRows: number): number {
	// Parent footer, cursor row, borders, heading, title, spacing and navigation.
	return Math.max(1, terminalRows - 11)
}

export function maxAgentTranscriptTailOffset(
	agent: SubagentActivity,
	terminalRows: number,
	terminalColumns: number,
): number {
	return Math.max(
		0,
		agentTranscriptRows(agent, terminalColumns).length - agentTranscriptPageSize(terminalRows),
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
	const pageSize = agentTranscriptPageSize(terminalRows)
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
function formatCompactCount(value: number): string {
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
 * need the most room, the model name less, and the description (rendered
 * separately by every caller) never yields to either.
 */
function agentMetaParts(
	agent: SubagentActivity,
	options: { readonly showModel: boolean; readonly showCounters: boolean },
): readonly string[] {
	const parts: string[] = []
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
