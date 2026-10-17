import type { BackgroundJob, BackgroundJobOutput } from '@namzu/sdk'
import { Box, Text } from 'ink'
import { formatSize } from './person-terms.js'

import { permissionReviewRows } from './permission-review.js'
import { choiceDisplayWidth, truncateChoiceText } from './terminal-choice-text.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

/** Keep a live log readable without projecting a whole retained 1 MiB on every repaint. */
const MAX_VISIBLE_OUTPUT_BYTES = 32 * 1024

export interface BackgroundJobsPanelProps {
	readonly jobs: readonly BackgroundJob[]
	/** The highlighted row in the list. An ended job remains selectable. */
	readonly selectedJobId: string | null
	/** Null shows the list; an id shows that job's details and retained output. */
	readonly detailJobId: string | null
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

/** Claude Code's row words: running, done, error, stopped. */
function jobMeta(job: BackgroundJob): 'running' | 'done' | 'error' | 'stopped' {
	if (job.status === 'running') return 'running'
	if (job.status === 'killed') return 'stopped'
	return job.exitCode === 0 ? 'done' : 'error'
}

const META_ICON = { running: '●', done: '✓', error: '✗', stopped: '■' } as const

function metaColor(meta: ReturnType<typeof jobMeta>): string {
	switch (meta) {
		case 'running':
			return theme.accent.system
		case 'done':
			return theme.status.ok
		case 'error':
			return theme.status.error
		default:
			return theme.status.warn
	}
}

function statusText(job: BackgroundJob): string {
	if (job.status === 'running') return 'running'
	if (job.status === 'killed') return 'stopped'
	if (job.exitCode === undefined) return 'ended'
	return `${job.exitCode === 0 ? 'completed' : 'failed'} (exit code ${job.exitCode})`
}

/** The exact physical lines the output pager uses; App uses the same count for keys. */
export function backgroundJobOutputRows(
	output: BackgroundJobOutput | undefined,
	columns: number,
): readonly string[] {
	if (!output) return ['Output unavailable.']
	const bytes = Buffer.from(output.chunk, 'utf8')
	const omittedHere = Math.max(0, bytes.length - MAX_VISIBLE_OUTPUT_BYTES)
	const latest = bytes.subarray(omittedHere).toString('utf8').replace(/\n$/u, '')
	const lines = [
		...(output.droppedBytes > 0
			? [`Earlier output discarded by the job buffer (${formatSize(output.droppedBytes)}).`]
			: []),
		...(omittedHere > 0 ? [`Showing the latest ${formatSize(MAX_VISIBLE_OUTPUT_BYTES)}.`] : []),
		latest.length > 0 ? latest : 'No output yet.',
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
	jobs,
	selectedJobId,
	detailJobId,
	tailOffset,
	readJob,
	rows,
	columns,
	now = Date.now(),
	busyJobId = null,
	notice = null,
}: BackgroundJobsPanelProps) {
	const running = jobs.filter((job) => job.status === 'running').length
	const selected = jobs.find((job) => job.id === selectedJobId) ?? jobs[0]
	const detailed = detailJobId ? jobs.find((job) => job.id === detailJobId) : undefined
	const innerColumns = Math.max(1, columns - 6)
	const narrow = columns < 56

	if (!detailJobId || !detailed) {
		const pageSize = backgroundJobsPageSize(rows)
		const selectedIndex = selected ? jobs.findIndex((job) => job.id === selected.id) : 0
		const start = Math.max(
			0,
			Math.min(selectedIndex - Math.floor(pageSize / 2), jobs.length - pageSize),
		)
		const shown = jobs.slice(start, start + pageSize)
		const stop = selected?.status === 'running' && !busyJobId ? ' · x stop' : ''
		const listHint =
			jobs.length === 0
				? 'esc close'
				: fitClosingHint(
						[
							`↑/↓ select · enter view${stop} · esc close`,
							`↑/↓ select · enter${stop} · esc`,
							`enter${stop} · esc`,
							`${stop ? 'x stop · ' : ''}esc`,
							'esc',
						],
						innerColumns,
					)
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
				<Text color={theme.text.muted} wrap="truncate-end">
					{`${running} active ${running === 1 ? 'shell' : 'shells'}`}
				</Text>
				{jobs.length === 0 ? (
					<Text color={theme.text.secondary}>No tasks currently running</Text>
				) : (
					shown.map((job) => {
						const focused = job.id === selected?.id
						const meta = jobMeta(job)
						const tail = `  ${meta}`
						const room = Math.max(1, innerColumns - 4 - tail.length)
						return (
							<Text key={job.id} wrap="truncate-end">
								<Text color={theme.accent.user}>{focused ? '❯ ' : '  '}</Text>
								<Text color={metaColor(meta)}>{META_ICON[meta]} </Text>
								<Text color={focused ? theme.accent.user : theme.text.secondary}>
									{truncateChoiceText(oneLine(job.command), room)}
								</Text>
								<Text color={theme.text.muted}>{tail}</Text>
							</Text>
						)
					})
				)}
				{jobs.length > pageSize ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						{`${start + 1}–${Math.min(start + pageSize, jobs.length)}/${jobs.length}`}
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
			`${pageLabel} · ↑↓ scroll · PgUp/PgDn · g/G${stopHint} · esc back · q close`,
			`${pageLabel} · ↑↓ scroll${stopHint} · esc back`,
			`↑↓ scroll${stopHint} · esc back`,
			`↑↓${stopHint} · esc back`,
			`${canStop ? 'x stop · ' : ''}esc back`,
			'esc back',
			'esc',
		],
		innerColumns,
	)

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.border.focus} paddingX={1}>
			<Text bold color={theme.accent.system} wrap="truncate-end">
				Shell details
			</Text>
			<Text wrap="truncate-end">
				<Text bold>Status: </Text>
				<Text color={metaColor(jobMeta(detailed))}>
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
