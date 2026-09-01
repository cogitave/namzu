import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'

import type {
	SubagentActivity,
	SubagentActivityStatus,
} from '../integrations/subagents/activity.js'
import { formatElapsed } from './LiveActivity.js'
import { selectionWindow } from './selection-window.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

const MAX_PICKER_ROWS = 9
const MAX_TRANSCRIPT_ROWS = 12
const COCKPIT_FRAME_COLUMNS = 4
const WIDE_COCKPIT_INNER_COLUMNS = 84

export type AgentCockpitFocus = 'phases' | 'agents'

export interface AgentPhase {
	readonly id: string
	readonly workflowId: string
	readonly workflow: string
	readonly name: string
	readonly order?: number
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
	const phases = agentPhases(agents)
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
	const active = agents.filter((agent) => !isTerminalStatus(agent.status)).length
	const wide = agentCockpitIsWide(terminalColumns)

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold wrap="truncate-end">
					{selectedPhase?.workflow ?? 'Delegated work'}
				</Text>
				<Text color={theme.text.muted}>
					{active} active · {agents.length} total
				</Text>
			</Box>
			<Text color={theme.text.muted}>Live delegated work · select a phase, then inspect a child.</Text>
			<Box flexDirection={wide ? 'row' : 'column'} paddingTop={1}>
				<Box
					flexDirection="column"
					width={wide ? Math.max(28, Math.min(42, Math.floor(terminalColumns * 0.32))) : undefined}
					marginRight={wide ? 2 : 0}
				>
					<PhasePane
						phases={phases}
						selected={selectedPhaseIndex}
						focused={focus === 'phases'}
						pageSize={agentPhasePageSize(terminalRows, wide)}
					/>
				</Box>
				<Box flexDirection="column" flexGrow={1} paddingTop={wide ? 0 : 1}>
					<AgentPane
						agents={phaseAgents}
						selected={selectedAgentIndex}
						focused={focus === 'agents'}
						pageSize={agentPickerPageSize(terminalRows, wide)}
						now={now}
						wide={wide}
					/>
				</Box>
			</Box>
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>
					←→ pane · ↑↓ navigate · PgUp/PgDn jump · enter select · esc return
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
}: {
	readonly phases: readonly AgentPhase[]
	readonly selected: number
	readonly focused: boolean
	readonly pageSize: number
}) {
	const { start, items } = selectionWindow(phases, selected, pageSize)
	const multipleWorkflows = new Set(phases.map((phase) => phase.workflowId)).size > 1
	return (
		<>
			<Text color={focused ? theme.accent.user : theme.text.secondary} bold>
				Phases {phases.length > 0 ? `· ${selected + 1}/${phases.length}` : ''}
			</Text>
			{items.map((phase, visibleIndex) => {
				const active = start + visibleIndex === selected
				return (
					<Box key={phase.id}>
						<Box width={3} flexShrink={0}>
							<Text color={active && focused ? theme.accent.user : theme.text.muted}>
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
								{oneLine(multipleWorkflows ? `${phase.workflow} / ${phase.name}` : phase.name)}
							</Text>
						</Box>
						<Box flexShrink={0} marginLeft={1}>
							<Text color={statusColor(phase.status)}>{phaseProgress(phase)}</Text>
						</Box>
					</Box>
				)
			})}
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
}: {
	readonly agents: readonly SubagentActivity[]
	readonly selected: number
	readonly focused: boolean
	readonly pageSize: number
	readonly now: number
	readonly wide: boolean
}) {
	const { start, items } = selectionWindow(agents, selected, pageSize)
	return (
		<>
			<Text color={focused ? theme.accent.user : theme.text.secondary} bold>
				Agents {agents.length > 0 ? `· ${selected + 1}/${agents.length}` : ''}
			</Text>
			{items.map((agent, visibleIndex) => {
				const active = start + visibleIndex === selected
				const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
				return (
					<Box key={agent.viewId}>
						<Box width={3} flexShrink={0}>
							<Text color={active && focused ? theme.accent.user : theme.text.muted}>
								{active ? '›' : ' '} {statusGlyph(agent.status)}
							</Text>
						</Box>
						<Box width={wide ? 28 : undefined} flexGrow={wide ? 0 : 1} flexShrink={wide ? 0 : 1}>
							<Text
								color={active ? theme.text.primary : theme.text.secondary}
								bold={active && focused}
								wrap="truncate-end"
							>
								{oneLine(agent.description || agent.agentId)}
							</Text>
						</Box>
						<Box flexGrow={wide ? 1 : 0}>
							<Text color={statusColor(agent.status)} wrap="truncate-end">
								{wide ? `${statusLabel(agent.status)} · ` : ' · '}
								{elapsed}
								{agent.latestActivity ? ` · ${oneLine(agent.latestActivity)}` : ''}
							</Text>
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

export function agentPhases(agents: readonly SubagentActivity[]): readonly AgentPhase[] {
	const records = new Map<
		string,
		{
			workflowId: string
			workflow: string
			name: string
			order?: number
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
	const available = Math.max(2, terminalRows - 10)
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

/** Bounded observational child transcript. Deliberately contains no Ink Static. */
export function AgentTranscript({
	agent,
	tailOffset,
	terminalRows,
	terminalColumns,
}: AgentTranscriptProps) {
	const page = agentTranscriptPage(agent, tailOffset, terminalRows, terminalColumns)
	const now = useLiveNow(agent.completedAt === undefined)
	const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold wrap="truncate-end">
					{statusGlyph(agent.status)} {oneLine(agent.description || agent.agentId)}
				</Text>
				<Text color={statusColor(agent.status)}>
					{statusLabel(agent.status)} · {elapsed}
				</Text>
			</Box>
			<Text color={theme.text.muted} wrap="truncate-end">
				{oneLine(agent.agentId)} · {agent.taskId ?? agent.viewId}
			</Text>
			<Box flexDirection="column" paddingTop={1} height={page.pageSize}>
				{page.rows.length === 0 ? (
					<Text color={theme.text.muted}>Waiting for this scheduler to expose child events…</Text>
				) : (
					page.rows.map((line) => (
						<Box key={line.id}>
							<Box width={3} flexShrink={0}>
								<Text color={lineColor(line)}>{line.continuation ? ' ' : lineGlyph(line)}</Text>
							</Box>
							<Text color={lineColor(line)}>{line.text}</Text>
						</Box>
					))
				)}
			</Box>
			<Box justifyContent="space-between" paddingTop={1}>
				<Text color={theme.text.muted}>
					PgUp/PgDn scroll · Home oldest · End live · esc agents · q parent
				</Text>
				<Text color={theme.text.muted}>
					{page.total === 0 ? '0/0' : `${page.first}-${page.last}/${page.total}`}
				</Text>
			</Box>
		</Box>
	)
}

export function agentPickerPageSize(terminalRows: number, wide = true): number {
	const available = Math.max(2, terminalRows - 10)
	return wide
		? Math.max(1, Math.min(MAX_PICKER_ROWS, available))
		: Math.max(1, Math.min(MAX_PICKER_ROWS, available - agentPhasePageSize(terminalRows, false)))
}

export function agentTranscriptPageSize(terminalRows: number): number {
	return Math.max(3, Math.min(MAX_TRANSCRIPT_ROWS, terminalRows - 11))
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
			text: row.kind === 'tool' && row.detail ? `${row.text}\n${row.detail}` : row.text,
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
			for (const point of logical) {
				const codePoint = point.codePointAt(0)
				const pointCells = codePoint !== undefined && codePoint <= 0x7e ? 1 : 2
				if (text.length > 0 && cells + pointCells > width) {
					lines.push({
						id: `${source.id}:${sourceLine++}`,
						text,
						continuation,
						source: source.source,
					})
					text = ''
					cells = 0
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

function oneLine(text: string): string {
	return terminalDisplayText(text).replace(/\r?\n/g, ' ↵ ').replace(/\t/g, ' ⇥ ')
}

function phaseStatus(agents: readonly SubagentActivity[]): SubagentActivityStatus {
	if (agents.some((agent) => agent.status === 'failed')) return 'failed'
	if (agents.some((agent) => agent.status === 'working')) return 'working'
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

function isTerminalStatus(status: SubagentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function statusGlyph(status: SubagentActivityStatus): string {
	switch (status) {
		case 'starting':
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
			return theme.status.ok
		case 'failed':
			return theme.status.error
		case 'starting':
		case 'working':
			return theme.status.warn
		case 'cancelled':
			return theme.text.muted
	}
}

function lineGlyph(line: AgentTranscriptLine): string {
	if (line.source === 'prompt') return '›'
	return rowGlyph(line.source)
}

function rowGlyph(row: SubagentActivity['transcript'][number]): string {
	if (row.kind === 'assistant') return '✦'
	if (row.kind === 'system') return '·'
	return row.status === 'working' ? '◌' : row.status === 'failed' ? '✗' : '✓'
}

function lineColor(line: AgentTranscriptLine): string {
	if (line.source === 'prompt') return theme.text.secondary
	return rowColor(line.source)
}

function rowColor(row: SubagentActivity['transcript'][number]): string {
	if (row.kind === 'assistant') return theme.text.primary
	if (row.kind === 'system') return theme.text.muted
	return row.status === 'failed'
		? theme.status.error
		: row.status === 'working'
			? theme.status.warn
			: theme.accent.tool
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
