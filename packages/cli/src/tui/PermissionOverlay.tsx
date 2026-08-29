/**
 * Tool-permission overlay. Shown when the agent wants to run a
 * non-read-only tool batch. Pages through the complete prepared input rather
 * than a friendly-but-lossy summary, then waits for Approve (y) / Reject (n) /
 * Approve-all (a). The parent (App) owns pagination and decision keypresses;
 * this component is presentational.
 */

import { Box, Text } from 'ink'

import type { PermissionToolCall } from './agent.js'
import {
	PERMISSION_REVIEW_PAGE_ROWS,
	permissionReviewRows,
} from './permission-review.js'
import { theme } from './theme.js'

export interface PermissionOverlayProps {
	readonly toolCalls: readonly PermissionToolCall[]
	/** Complete exact review envelope built before the callback was opened. */
	readonly review: string
	/** First physical review row shown in the fixed-height pager. */
	readonly reviewOffset?: number
	/** Live terminal width. Re-wrapping on resize keeps every suffix reachable. */
	readonly columns?: number
}

export function PermissionOverlay({
	toolCalls,
	review,
	reviewOffset = 0,
	columns,
}: PermissionOverlayProps) {
	const rows = permissionReviewRows(review, columns)
	const maxOffset = Math.max(0, rows.length - PERMISSION_REVIEW_PAGE_ROWS)
	const offset = Math.min(Math.max(0, reviewOffset), maxOffset)
	const visibleRows = rows.slice(offset, offset + PERMISSION_REVIEW_PAGE_ROWS)
	const first = rows.length === 0 ? 0 : offset + 1
	const last = Math.min(rows.length, offset + PERMISSION_REVIEW_PAGE_ROWS)
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.status.warn}
			paddingX={1}
			marginTop={1}
		>
			<Text color={theme.status.warn} bold>
				⚠ namzu wants to run {toolCalls.length === 1 ? 'a tool' : `${toolCalls.length} tools`}
			</Text>
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.text.muted}>
					Exact prepared input · rows {first}-{last}/{rows.length}
				</Text>
				<Box flexDirection="column" paddingLeft={2} height={PERMISSION_REVIEW_PAGE_ROWS}>
					{visibleRows.map((row) => (
						<Box key={row.index} width="100%">
							<Text color={theme.text.muted}>{row.continuation ? '↳ ' : '│ '}</Text>
							<Text color={theme.text.secondary}>{row.text}</Text>
						</Box>
					))}
				</Box>
				{rows.length > PERMISSION_REVIEW_PAGE_ROWS ? (
					<Text color={theme.text.muted}>↑↓ row · pgup/pgdn page · home/end</Text>
				) : null}
			</Box>
			{/* Every key that decides this prompt, and what each one decides.
			    `Ctrl+C` was missing, and it is the only one with a DIFFERENT
			    outcome: `n` and `esc` decline this batch and the turn carries on
			    trying something else, while `Ctrl+C` ends the turn. So someone
			    who wanted namzu to stop pressed `n`, watched it continue, and had
			    no way to learn otherwise from this screen — the distinction was
			    written down nowhere else.

			    Two rows rather than one: at four keys the line wraps on a narrow
			    terminal and wraps mid-key, and this is the box an operator reads
			    while deciding. Grouped by outcome, so the reading is "these two
			    let it continue, this one does not" rather than a list of four
			    equals. The status bar keeps the compact three-key echo — it is
			    budget-constrained by construction and this box is on screen
			    whenever it applies. */}
			<Box flexDirection="column">
				<Text color={theme.text.muted}>
					<Text color={theme.status.ok} bold>
						y
					</Text>{' '}
					approve ·{' '}
					<Text color={theme.accent.user} bold>
						a
					</Text>{' '}
					approve all for this session
				</Text>
				<Text color={theme.text.muted}>
					<Text color={theme.status.error} bold>
						n
					</Text>{' '}
					or{' '}
					<Text color={theme.status.error} bold>
						esc
					</Text>{' '}
					decline, and the agent tries something else ·{' '}
					<Text color={theme.status.error} bold>
						ctrl+c
					</Text>{' '}
					decline and stop the turn
				</Text>
			</Box>
		</Box>
	)
}
