import { Box, Text, useWindowSize } from 'ink'
import { statusPanelLayout } from './status-panel-layout.js'
import { theme } from './theme.js'

/** An operator snapshot in scrollback, with layout owned by Ink rather than text padding. */
export function StatusPanel({ rows }: { readonly rows: readonly (readonly [string, string])[] }) {
	const terminal = useWindowSize()
	const layout = statusPanelLayout(rows, terminal.columns)
	return (
		<Box
			width={layout.width}
			borderStyle="round"
			borderColor={theme.border.default}
			paddingX={1}
			flexDirection="column"
		>
			<Box marginBottom={1}>
				<Text bold color={theme.accent.user}>
					NAMZU
				</Text>
				<Text color={theme.text.muted}> / SESSION</Text>
			</Box>
			{layout.rows.map((row, index) => (
				<Box
					key={index}
					marginTop={row.gap ? 1 : 0}
					flexDirection={layout.stacked ? 'column' : 'row'}
				>
					<Box width={layout.stacked ? undefined : 14} flexShrink={0}>
						<Text color={theme.text.muted}>{row.label}</Text>
					</Box>
					<Box flexDirection="column" flexGrow={1}>
						{row.lines.map((line, lineIndex) => (
							<Text
								key={lineIndex}
								color={row.label === 'Model' ? theme.text.primary : theme.text.secondary}
								bold={row.label === 'Model'}
							>
								{line || ' '}
							</Text>
						))}
					</Box>
				</Box>
			))}
			<Box marginTop={1}>
				<Text color={theme.text.muted}>/config · settings /status details · full report</Text>
			</Box>
		</Box>
	)
}
