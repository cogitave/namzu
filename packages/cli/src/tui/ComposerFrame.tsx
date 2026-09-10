import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

import { theme } from './theme.js'

/** A bounded command frame; its content stays mounted while another prompt owns focus. */
export function ComposerFrame({
	focus,
	hidden = false,
	children,
}: {
	readonly focus: boolean
	readonly hidden?: boolean
	readonly working?: boolean
	readonly animate?: boolean
	readonly children: ReactNode
}) {
	const accent = focus ? theme.border.focus : theme.text.muted
	return (
		<Box position="relative" flexDirection="column" marginTop={hidden ? 0 : 1}>
			<Box display={hidden ? 'none' : 'flex'} height={1} flexShrink={0}>
				<Box flexShrink={0}>
					<Text color={accent}>┌</Text>
				</Box>
				{/* The caption yields to narrow widths while both corners stay fixed. */}
				<Box minWidth={0}>
					<Text color={accent} wrap="truncate-end">
						─ <Text bold>MESSAGE</Text>{' '}
					</Text>
				</Box>
				<Rule />
				<Box flexShrink={0}>
					<Text color={accent}>┐</Text>
				</Box>
			</Box>
			<Box
				flexDirection="column"
				{...(hidden ? {} : { borderStyle: 'single' as const })}
				borderTop={false}
				borderBottom={false}
				borderLeft={!hidden}
				borderRight={!hidden}
				borderColor={theme.border.default}
			>
				{children}
			</Box>
			<Box display={hidden ? 'none' : 'flex'} height={1} flexShrink={0}>
				<Box flexShrink={0}>
					<Text color={accent}>└</Text>
				</Box>
				<Box minWidth={0}>
					<Text color={accent} wrap="truncate-end">
						─
					</Text>
				</Box>
				<Rule />
				<Box flexShrink={0}>
					<Text color={accent}>┘</Text>
				</Box>
			</Box>
		</Box>
	)
}

/** Yoga sizes the rule; a repeated text string would truncate with an ellipsis. */
function Rule() {
	return (
		<Box
			flexGrow={1}
			minWidth={0}
			height={1}
			borderStyle="single"
			borderBottom={false}
			borderLeft={false}
			borderRight={false}
			borderColor={theme.border.default}
		/>
	)
}
