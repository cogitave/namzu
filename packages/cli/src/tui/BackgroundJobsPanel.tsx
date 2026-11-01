import type { BackgroundJob, BackgroundJobOutput } from '@namzu/sdk'
import { Box, Text } from 'ink'
import type React from 'react'
import { formatSize } from './person-terms.js'

import {
	BACKGROUND_SECTION_TITLES,
	type BackgroundRow,
	type RowMeta,
	backgroundCounts,
	backgroundSubtitle,
	isRowRunning,
	rowLabel,
	rowMeta,
} from './background-view.js'
import { permissionReviewRows } from './permission-review.js'
import { SYSTEM_ROW_GLYPH, endOutcome } from './system-rows.js'
import { choiceDisplayWidth, truncateChoiceText } from './terminal-choice-text.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

/** Keep a live log readable without projecting a whole retained 1 MiB on every repaint. */
const MAX_VISIBLE_OUTPUT_BYTES = 32 * 1024

export interface BackgroundJobsPanelProps {
	/** Everything the dialog lists: commands, monitors, subagents, in section order. */
	readonly entries: readonly BackgroundRow[]
	/** The highlighted row's key in the list. An ended row remains selectable. */
	readonly selectedKey: string | null
	/** Null shows the list; a command's key shows that command's details and retained output. */
	readonly detailKey: string | null
	/** Physical output rows to stay above the live tail. Zero follows new output. */
	readonly tailOffset: number
	/** Bound to the current session by the host. Reading must never start a job. */
	readonly readJob: (id: string) => BackgroundJobOutput | undefined
	readonly rows: number
	readonly columns: number
	readonly now?: number
	readonly busyJobId?: string | null
	readonly notice?: string | null
}

/** A list row per job, with room left for the composer and its footer. */
export function backgroundJobsPageSize(rows: number): number {
	return Math.max(1, Math.min(8, Math.floor(rows) - 11))
}

/** Detail output grows on taller terminals, while retaining the surrounding UI. */
export function backgroundJobOutputPageSize(rows: number): number {
	return Math.max(1, Math.min(18, Math.floor(rows) - 16))
}

function elapsed(job: BackgroundJob, now: number): string {
	const seconds = Math.max(0, Math.floor(((job.exitedAt ?? now) - job.startedAt) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function metaColor(meta: RowMeta): string {
	switch (meta) {
		case 'running':
			return theme.accent.system
		case 'done':
			return theme.status.ok
		case 'error':
		case 'failed':
			return theme.status.error
		default:
			return theme.status.warn
	}
}

function statusText(job: BackgroundJob): string {
	if (job.status === 'running') return 'running'
	if (job.kind === 'monitor') {
		if (job.stopReason === 'expired') return 'ran out of time'
		if (job.stopReason === 'too_much_output') return 'stopped: it printed too much'
	}
	if (endOutcome(job.status) === 'stopped') return 'stopped'
	if (job.exitCode === undefined) return 'done'
	return `${job.exitCode === 0 ? 'done' : 'error'} (exit code: ${job.exitCode})`
}

/** The exact physical lines the output pager uses; App uses the same count for keys. */
export function backgroundJobOutputRows(
	output: BackgroundJobOutput | undefined,
	columns: number,
): readonly string[] {
	if (!output) return ['No output available']
	const bytes = Buffer.from(output.chunk, 'utf8')
	const omittedHere = Math.max(0, bytes.length - MAX_VISIBLE_OUTPUT_BYTES)
	const latest = bytes.subarray(omittedHere).toString('utf8').replace(/\n$/u, '')
	const lines = [
		...(output.droppedBytes > 0
			? [`Earlier output was dropped (${formatSize(output.droppedBytes)}).`]
			: []),
		...(omittedHere > 0 ? [`Showing the latest ${formatSize(MAX_VISIBLE_OUTPUT_BYTES)}.`] : []),
		latest.length > 0 ? latest : 'No output available',
	]
	// This wrapper preserves shell spacing and splits long lines before Ink can
	// wrap them below the panel's row budget. It also makes terminal controls
	// visible instead of letting process output move the cursor.
	return permissionReviewRows(lines.join('\n').replace(/\t/gu, '    '), columns).map(
		(row) => row.text,
	)
}

export function maxBackgroundJobTailOffset(
	output: BackgroundJobOutput | undefined,
	rows: number,
	columns: number,
): number {
	return Math.max(
		0,
		backgroundJobOutputRows(output, columns).length - backgroundJobOutputPageSize(rows),
	)
}

function oneLine(command: string): string {
	return terminalDisplayText(command).replace(/\s+/gu, ' ').trim()
}

function readOutput(
	readJob: BackgroundJobsPanelProps['readJob'],
	id: string,
): BackgroundJobOutput | undefined {
	try {
		return readJob(id)
	} catch {
		// A session can close between a status snapshot and a render. The host
		// still owns the error and the panel stays navigable.
		return undefined
	}
}

/** Keep the exit key readable when a narrow terminal cannot carry every hint. */
function fitClosingHint(candidates: readonly string[], columns: number): string {
	for (const candidate of candidates) {
		if (choiceDisplayWidth(candidate) <= columns) return candidate
	}
	return truncateChoiceText(candidates.at(-1) ?? 'esc', columns)
}

export function BackgroundJobsPanel({
	entries,
	selectedKey,
	detailKey,
	tailOffset,
	readJob,
	rows,
	columns,
	now = Date.now(),
	busyJobId = null,
	notice = null,
}: BackgroundJobsPanelProps) {
	const counts = backgroundCounts(entries)
	const subtitle = backgroundSubtitle(counts)
	const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0]
	const detailedEntry = detailKey ? entries.find((entry) => entry.key === detailKey) : undefined
	const detailed = detailedEntry?.kind === 'job' ? detailedEntry.job : undefined
	const innerColumns = Math.max(1, columns - 6)

	if (!detailKey || !detailed) {
		const pageSize = backgroundJobsPageSize(rows)
		const selectedIndex = selected ? entries.findIndex((entry) => entry.key === selected.key) : 0
		const start = Math.max(
			0,
			Math.min(selectedIndex - Math.floor(pageSize / 2), entries.length - pageSize),
		)
		const shown = entries.slice(start, start + pageSize)
		const stop =
			selected && isRowRunning(selected) && !busyJobId && selected.kind === 'job' ? ' · x stop' : ''
		const agentStop = selected?.kind === 'agent' && isRowRunning(selected) ? ' · x stop' : ''
		const stopHint = stop || agentStop
		const listHint =
			entries.length === 0
				? 'esc close'
				: fitClosingHint(
						[
							`↑/↓ select · enter view${stopHint} · esc close`,
							`↑/↓ select · enter${stopHint} · esc`,
							`enter${stopHint} · esc`,
							`${stopHint ? 'x stop · ' : ''}esc`,
							'esc',
						],
						innerColumns,
					)
		// A lone section carries no heading: the dialog's title already says it.
		const sectionCount = new Set(entries.map((entry) => entry.section)).size
		const lines: React.ReactElement[] = []
		let lastSection: BackgroundRow['section'] | undefined
		for (const entry of shown) {
			if (sectionCount > 1 && entry.section !== lastSection) {
				if (lastSection !== undefined) lines.push(<Text key={`gap-${entry.section}`}> </Text>)
				const total = entries.filter((other) => other.section === entry.section).length
				lines.push(
					<Text key={`head-${entry.section}`} wrap="truncate-end">
						<Text bold>{BACKGROUND_SECTION_TITLES[entry.section]}</Text>
						<Text color={theme.text.muted}> ({total})</Text>
					</Text>,
				)
			}
			lastSection = entry.section
			const focused = entry.key === selected?.key
			const meta = rowMeta(entry)
			const tail = `  ${meta}`
			const room = Math.max(1, innerColumns - 4 - tail.length)
			lines.push(
				<Text key={entry.key} wrap="truncate-end">
					<Text color={theme.accent.user}>{focused ? '❯ ' : '  '}</Text>
					<Text color={metaColor(meta)}>{SYSTEM_ROW_GLYPH} </Text>
					<Text color={focused ? theme.accent.user : theme.text.secondary}>
						{truncateChoiceText(oneLine(rowLabel(entry)), room)}
					</Text>
					<Text color={theme.text.muted}>{tail}</Text>
				</Text>,
			)
		}
		return (
			<Box
				flexDirection="column"
				borderStyle="single"
				borderColor={theme.border.default}
				paddingX={1}
			>
				<Text bold color={theme.accent.system} wrap="truncate-end">
					Background
				</Text>
				{subtitle ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						{subtitle}
					</Text>
				) : null}
				{entries.length === 0 ? (
					<Text color={theme.text.secondary}>No tasks currently running</Text>
				) : (
					lines
				)}
				{entries.length > pageSize ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						{`${start + 1}–${Math.min(start + pageSize, entries.length)}/${entries.length}`}
					</Text>
				) : null}
				{notice ? (
					<Text color={theme.status.warn} wrap="truncate-end">
						{truncateChoiceText(notice, innerColumns)}
					</Text>
				) : null}
				<Text color={theme.text.muted} wrap="truncate-end">
					{listHint}
				</Text>
			</Box>
		)
	}

	const output = readOutput(readJob, detailed.id)
	const outputRows = backgroundJobOutputRows(output, columns)
	const pageSize = backgroundJobOutputPageSize(rows)
	const maxOffset = Math.max(0, outputRows.length - pageSize)
	const offset = Math.max(0, Math.min(tailOffset, maxOffset))
	const end = outputRows.length - offset
	const start = Math.max(0, end - pageSize)
	const allCommandRows = permissionReviewRows(
		terminalDisplayText(detailed.command).replace(/\t/gu, '    '),
		columns,
	)
	const commandRows = allCommandRows.slice(0, 2)
	const commandMore = allCommandRows.length > 2
	const shownOutput = outputRows.map((text, index) => ({ index, text })).slice(start, end)
	const canStop = detailed.status === 'running' && !busyJobId
	const earlierOutputOmitted =
		(output?.droppedBytes ?? 0) > 0 ||
		(output?.chunk !== undefined && Buffer.byteLength(output.chunk) > MAX_VISIBLE_OUTPUT_BYTES)
	const pageLabel = `${start + 1}–${end}/${outputRows.length}`
	const stopHint = canStop ? ' · x stop' : ''
	const footer = fitClosingHint(
		[
			`${pageLabel} · ↑↓ scroll · PgUp/PgDn · g/G${stopHint} · ← go back · esc/enter/space close`,
			`${pageLabel} · ↑↓ scroll${stopHint} · ← back · esc close`,
			`↑↓ scroll${stopHint} · ← back · esc`,
			`↑↓${stopHint} · ← back`,
			`${canStop ? 'x stop · ' : ''}← back`,
			'← back',
			'esc',
		],
		innerColumns,
	)

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.border.focus} paddingX={1}>
			<Text bold color={theme.accent.system} wrap="truncate-end">
				{detailed.kind === 'monitor' ? 'Monitor details' : 'Shell details'}
			</Text>
			<Text wrap="truncate-end">
				<Text bold>Status: </Text>
				<Text
					color={metaColor(rowMeta({ kind: 'job', key: '', section: 'shells', job: detailed }))}
				>
					{truncateChoiceText(
						busyJobId === detailed.id ? 'Stopping…' : statusText(detailed),
						innerColumns - 8,
					)}
				</Text>
			</Text>
			<Text wrap="truncate-end">
				<Text bold>Runtime: </Text>
				<Text>{elapsed(detailed, now)}</Text>
			</Text>
			{detailed.kind === 'monitor' ? (
				<Text wrap="truncate-end">
					<Text bold>Watching: </Text>
					<Text>{truncateChoiceText(oneLine(detailed.description ?? ''), innerColumns - 10)}</Text>
				</Text>
			) : null}
			<Text bold>Command:</Text>
			{commandRows.map((row) => (
				<Text key={row.index} color={theme.text.primary} wrap="truncate-end">
					{row.text || ' '}
				</Text>
			))}
			{commandMore ? <Text color={theme.text.muted}>… command continues</Text> : null}
			<Text bold wrap="truncate-end">
				{truncateChoiceText(
					earlierOutputOmitted ? 'Output: (earlier output not shown)' : 'Output:',
					innerColumns,
				)}
			</Text>
			{shownOutput.map((row) => (
				<Text key={row.index} color={theme.text.secondary} wrap="truncate-end">
					{row.text || ' '}
				</Text>
			))}
			{notice ? (
				<Text color={theme.status.warn} wrap="truncate-end">
					{truncateChoiceText(notice, innerColumns)}
				</Text>
			) : null}
			<Text color={theme.text.muted} wrap="truncate-end">
				{footer}
			</Text>
		</Box>
	)
}
