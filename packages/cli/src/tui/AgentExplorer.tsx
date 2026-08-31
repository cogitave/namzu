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

export interface AgentPickerProps {
	readonly agents: readonly SubagentActivity[]
	readonly selectedId: string
	readonly terminalRows: number
}

/** Live child-run chooser. App owns input and keeps selection by stable view id. */
export function AgentPicker({ agents, selectedId, terminalRows }: AgentPickerProps) {
	const selected = Math.max(
		0,
		agents.findIndex((agent) => agent.viewId === selectedId),
	)
	const pageSize = agentPickerPageSize(terminalRows)
	const { start, items } = selectionWindow(agents, selected, pageSize)
	const now = useLiveNow(agents.some((agent) => agent.completedAt === undefined))

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold>
					Agents
				</Text>
				<Text color={theme.text.muted}>
					{agents.length === 0 ? '0/0' : `${selected + 1}/${agents.length}`}
				</Text>
			</Box>
			<Text color={theme.text.muted}>Observe delegated work without leaving the parent run.</Text>
			<Box flexDirection="column" paddingTop={1}>
				{items.map((agent, visibleIndex) => {
					const index = start + visibleIndex
					const active = agent.viewId === selectedId
					const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
					return (
						<Box key={agent.viewId}>
							<Box width={3} flexShrink={0}>
								<Text color={active ? theme.accent.user : theme.text.muted}>
									{active ? '›' : ' '} {statusGlyph(agent.status)}
								</Text>
							</Box>
							<Box width={28} flexShrink={0}>
								<Text
									color={active ? theme.text.primary : theme.text.secondary}
									bold={active}
									wrap="truncate-end"
								>
									{oneLine(agent.description || agent.agentId)}
								</Text>
							</Box>
							<Box flexGrow={1}>
								<Text color={statusColor(agent.status)} wrap="truncate-end">
									{statusLabel(agent.status)} · {elapsed}
									{agent.latestActivity ? ` · ${oneLine(agent.latestActivity)}` : ''}
								</Text>
							</Box>
						</Box>
					)
				})}
			</Box>
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>
					↑↓ navigate · PgUp/PgDn jump · enter inspect · esc return
				</Text>
			</Box>
		</Box>
	)
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

export function agentPickerPageSize(terminalRows: number): number {
	return Math.max(3, Math.min(MAX_PICKER_ROWS, terminalRows - 10))
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
