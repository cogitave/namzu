import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { permissionReviewRows } from './permission-review.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

/** A bounded view of retained output; opening it never appends transcript rows. */
export function ToolOutputViewer({
	title, lines, rows, columns, onClose, onPrevious, onNext,
}: {
	readonly title: string
	readonly lines: readonly string[]
	readonly rows: number | undefined
	readonly columns: number | undefined
	readonly onClose: () => void
	readonly onPrevious?: () => void
	readonly onNext?: () => void
}) {
	const wrapped = useMemo(() => permissionReviewRows(lines.join('\n'), columns), [lines, columns])
	const pageSize = Math.max(1, (rows ?? 24) - 10)
	const [offset, setOffset] = useState(0)
	const last = Math.max(0, wrapped.length - pageSize)
	const start = Math.min(offset, last)
	useInput((input, key) => {
		if (key.escape || input === 'q' || (key.ctrl && (input === 'o' || input === 'c'))) {
			onClose()
			return
		}
		if (key.leftArrow) onPrevious?.()
		if (key.rightArrow) onNext?.()
		if (key.upArrow) setOffset(Math.max(0, start - 1))
		if (key.downArrow) setOffset(Math.min(last, start + 1))
		if (key.pageUp) setOffset(Math.max(0, start - pageSize))
		if (key.pageDown || input === ' ') setOffset(Math.min(last, start + pageSize))
		if (input === 'g') setOffset(0)
		if (input === 'G') setOffset(last)
	})
	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.text.muted} paddingX={1}>
			<Text bold color={theme.status.ok} wrap="truncate-end">Tool output · {terminalDisplayText(title)}</Text>
			{wrapped.slice(start, start + pageSize).map(row => (
				<Text key={row.index} wrap="truncate-end" color={
					row.text.trimStart().startsWith('+ ') ? theme.status.ok
						: row.text.trimStart().startsWith('- ') ? theme.status.error : undefined
				}>{row.text || ' '}</Text>
			))}
			<Text color={theme.text.muted} wrap="truncate-end">
				{start + 1}–{Math.min(start + pageSize, wrapped.length)}/{wrapped.length} · ←→ outputs · ↑↓ scroll · PgUp/PgDn · g/G · esc close
			</Text>
		</Box>
	)
}
