/** Readable, source-preserving tool consent surface. App owns every key. */

import { Box, Text } from 'ink'

import type { PermissionToolCall } from './agent.js'
import {
	PERMISSION_REVIEW_PAGE_ROWS,
	type PermissionReviewSummary,
	permissionReviewRows,
} from './permission-review.js'
import { theme } from './theme.js'

export interface PermissionOverlayProps {
	readonly toolCalls: readonly PermissionToolCall[]
	/** Complete exact review envelope built before the callback was opened. */
	readonly review: string
	/** Readable projection derived only from `review`. */
	readonly summary: PermissionReviewSummary
	/** Unknown/evolved shapes begin here so no formatter can hide input. */
	readonly detailsOpen: boolean
	/** First physical row shown in the fixed-height pager. */
	readonly reviewOffset?: number
	/** Live terminal width. Re-wrapping on resize keeps every suffix reachable. */
	readonly columns?: number
}

/**
 * A change row reads as a change: removed text red, added text green. Only in
 * the readable view — the exact view is JSON, where a `-` at column one is a
 * value, not a sign — and only on the readable summary's own `+ ` / `- `
 * prefixes, which the indentation puts at column four.
 */
function rowColor(text: string, detailsOpen: boolean): string {
	if (detailsOpen) return theme.text.secondary
	if (/^\s{3}- /.test(text)) return theme.status.error
	if (/^\s{3}\+ /.test(text)) return theme.status.ok
	return theme.text.secondary
}

export function PermissionOverlay({
	toolCalls,
	review,
	summary,
	detailsOpen,
	reviewOffset = 0,
	columns,
}: PermissionOverlayProps) {
	const source = detailsOpen ? review : summary.text
	const rows = permissionReviewRows(source, columns)
	const maxOffset = Math.max(0, rows.length - PERMISSION_REVIEW_PAGE_ROWS)
	const offset = Math.min(Math.max(0, reviewOffset), maxOffset)
	const visibleRows = rows.slice(offset, offset + PERMISSION_REVIEW_PAGE_ROWS)
	const first = rows.length === 0 ? 0 : offset + 1
	const last = Math.min(rows.length, offset + PERMISSION_REVIEW_PAGE_ROWS)
	const noun = toolCalls.length === 1 ? 'this tool' : `these ${toolCalls.length} tools`
	const agentBatch = toolCalls.length > 0 && toolCalls.every((call) => call.name === 'Agent')
	const agentNoun = `${toolCalls.length} agent${toolCalls.length === 1 ? '' : 's'}`

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderTop
			borderBottom
			borderLeft={false}
			borderRight={false}
			borderColor={theme.status.warn}
			paddingX={1}
			marginTop={1}
		>
			<Text color={theme.status.warn} bold>
				{agentBatch ? `namzu wants to start ${agentNoun}` : `namzu wants to run ${noun}`}
			</Text>
			<Text color={theme.text.muted}>
				{detailsOpen ? 'Exact prepared input' : agentBatch ? 'Delegated work' : 'Prepared operation'} · rows {first}-{last}/
				{rows.length}
			</Text>
			<Box
				flexDirection="column"
				paddingTop={1}
				height={PERMISSION_REVIEW_PAGE_ROWS + 1}
			>
				{visibleRows.map((row) => (
					<Box key={row.index} width="100%">
						<Text color={theme.text.muted}>{row.continuation ? '↳ ' : '› '}</Text>
						<Text color={rowColor(row.text, detailsOpen)}>{row.text}</Text>
					</Box>
				))}
			</Box>
			{rows.length > PERMISSION_REVIEW_PAGE_ROWS ? (
				<Text color={theme.text.muted}>↑↓ row · PgUp/PgDn page · Home/End boundary</Text>
			) : null}
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.text.muted}>
					<Text color={theme.status.ok} bold>
						y
					</Text>{' '}
					{agentBatch ? `start ${agentNoun}` : 'run once'} ·{' '}
					<Text color={theme.accent.user} bold>
						a
					</Text>{' '}
					{agentBatch ? 'allow all tools this session' : 'approve all for this session'} ·{' '}
					<Text color={theme.text.primary} bold>
						d
					</Text>{' '}
					{detailsOpen ? 'readable view' : 'exact input'}
				</Text>
				<Text color={theme.text.muted}>
					<Text color={theme.status.error} bold>
						n / esc
					</Text>{' '}
					{agentBatch ? "don't start; revise the plan" : 'decline, and the agent tries something else'} ·{' '}
					<Text color={theme.status.error} bold>
						ctrl+c
					</Text>{' '}
					decline and stop the turn
				</Text>
			</Box>
		</Box>
	)
}
