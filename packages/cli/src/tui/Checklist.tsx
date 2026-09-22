/**
 * The one way this interface draws the model's plan.
 *
 * Every surface that shows tasks — the transcript block a task operation
 * leaves, the one-line progress above the composer, `/tasks` — renders rows
 * through here, so a mark means the same thing wherever it appears and the
 * spacing is decided once.
 *
 * The marks are chosen for how they render, not only for what they mean.
 * `☑` and `⏸` are emoji code points (`Extended_Pictographic`); Windows
 * Terminal and other emoji-capable fonts draw them as colour pictures two
 * cells wide, which is how `☑` came out as a blue tile and `☐` ate the space
 * after it. Every mark here is outside the emoji set and one cell wide in
 * Unicode's own width data, and each row puts exactly one space between the
 * mark and the text — the mark sits in a two-column gutter, so a wrapped
 * subject hangs under its first letter rather than under the mark.
 */

import { Box, Text } from 'ink'
import stringWidth from 'string-width'

import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface ChecklistItem {
	readonly id: string
	readonly subject: string
	readonly status: ChecklistStatus
}

/** One text-presentation, single-cell mark per status. */
export const CHECKLIST_MARK: Readonly<Record<ChecklistStatus, string>> = {
	pending: '□',
	in_progress: '■',
	completed: '✓',
	failed: '✗',
}

export function isTerminalChecklistStatus(status: ChecklistStatus): boolean {
	return status === 'completed' || status === 'failed'
}

/** Completed-of-total, the count every task surface leads with. */
export function checklistProgress(items: readonly ChecklistItem[]): string {
	const done = items.filter((item) => item.status === 'completed').length
	const failed = items.filter((item) => item.status === 'failed').length
	return `Tasks · ${done}/${items.length} done${failed > 0 ? ` · ${failed} failed` : ''}`
}

/**
 * A row as plain text: mark, one space, subject. For the raw view, exports
 * and height estimates, which must agree with what `ChecklistRow` draws.
 */
export function checklistLine(item: ChecklistItem): string {
	return `${CHECKLIST_MARK[item.status]} ${oneLine(item.subject)}`
}

function oneLine(subject: string): string {
	return terminalDisplayText(subject.replace(/\s+/g, ' ').trim())
}

function markColor(status: ChecklistStatus): string {
	switch (status) {
		case 'in_progress':
			return theme.accent.assistant
		case 'completed':
			return theme.text.muted
		case 'failed':
			return theme.status.error
		default:
			return theme.text.secondary
	}
}

/**
 * One task. Completed is dimmed and struck through, the current step is bold
 * in the accent colour, a failure keeps its red mark and ordinary text.
 */
export function ChecklistRow({
	item,
	wrap = 'wrap',
}: {
	readonly item: ChecklistItem
	/** `truncate-end` for a surface that has exactly one row to give. */
	readonly wrap?: 'wrap' | 'truncate-end'
}) {
	return (
		<Box flexDirection="row">
			<Box width={2} flexShrink={0}>
				<Text color={markColor(item.status)}>{CHECKLIST_MARK[item.status]}</Text>
			</Box>
			<Box flexGrow={1} flexShrink={1}>
				<Text
					color={
						item.status === 'completed'
							? theme.text.muted
							: item.status === 'in_progress'
								? theme.text.primary
								: theme.text.secondary
					}
					bold={item.status === 'in_progress'}
					strikethrough={item.status === 'completed'}
					dimColor={item.status === 'completed'}
					wrap={wrap}
				>
					{oneLine(item.subject)}
				</Text>
			</Box>
		</Box>
	)
}

export function Checklist({ items }: { readonly items: readonly ChecklistItem[] }) {
	if (items.length === 0) return null
	return (
		<Box flexDirection="column">
			{items.map((item) => (
				<ChecklistRow key={item.id} item={item} />
			))}
		</Box>
	)
}

/**
 * Rows a transcript row carrying a checklist takes at `columns`: a blank
 * separator, its header, and each task wrapped under the four-column indent
 * (App padding plus the gutter). An estimate for the live-region budget,
 * erring high: over-counting only shows the current-step row once more.
 */
export function checklistBlockRows(
	row: { readonly content: string; readonly checklist?: readonly ChecklistItem[] },
	columns: number,
): number {
	const room = Math.max(1, columns - 4)
	const wrapped = (text: string) => Math.max(1, Math.ceil(stringWidth(text) / room))
	return (
		2 +
		wrapped(row.content) +
		(row.checklist ?? []).reduce((sum, item) => sum + wrapped(checklistLine(item)), 0)
	)
}
