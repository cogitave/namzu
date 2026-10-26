import type { ToolDiffHunk } from '@namzu/sdk'
import { Box, Text } from 'ink'

import { diffViewRows } from './diff-view.js'
import { theme } from './theme.js'

const SAMPLE_HUNK: ToolDiffHunk = {
	oldStart: 1,
	oldLines: 3,
	newStart: 1,
	newLines: 3,
	lines: [
		' function greet() {',
		'-  console.log("Hello, World!");',
		'+  console.log("Hello, Namzu!");',
		' }',
	],
}

/** What the theme picker shows under its list: a small change and the two result colours. */
export function ThemeSample({ width }: { readonly width: number }) {
	const rows = diffViewRows([SAMPLE_HUNK], { width: Math.max(10, Math.min(width, 48)) })
	return (
		<Box flexDirection="column" marginTop={1}>
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a sample row has no identity beyond its position.
				<Text key={`s-${i}`} wrap="truncate-end">
					{row.map((segment, j) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
							key={`g-${j}`}
							{...(segment.bg ? { backgroundColor: segment.bg } : {})}
							{...(segment.fg ? { color: segment.fg } : {})}
							{...(segment.dim ? { dimColor: true } : {})}
						>
							{segment.text}
						</Text>
					))}
				</Text>
			))}
			<Text>
				<Text color={theme.status.ok}>✓ Done</Text>
				<Text color={theme.text.muted}> · </Text>
				<Text color={theme.status.error}>✗ Failed</Text>
				<Text color={theme.text.muted}> · </Text>
				<Text color={theme.status.warn}>Careful</Text>
			</Text>
		</Box>
	)
}
