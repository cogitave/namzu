import { Box, Text, useWindowSize } from 'ink'

import { type PermissionMode, permissionModeLabel } from '../permissions/mode.js'
import {
	NAMZU_COMPACT_WORDMARK,
	NAMZU_MARK_COLOR,
	NAMZU_WORDMARK,
	NAMZU_WORDMARK_MIN_WIDTH,
} from './logo.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

interface BrandHeaderProps {
	readonly version: string
	readonly permissionMode: PermissionMode
}

/** Printed once by the transcript's Static owner; active model state lives in the footer. */
export function BrandHeader({ version, permissionMode }: BrandHeaderProps) {
	const { columns, rows } = useWindowSize()
	const wordmark = columns >= NAMZU_WORDMARK_MIN_WIDTH && rows >= 20 ? NAMZU_WORDMARK : NAMZU_COMPACT_WORDMARK
	const attribution = `${columns >= 40 ? 'Cogitave ' : ''}v${terminalDisplayText(version)}`
	return (
		<Box flexDirection="column" marginY={1}>
			<Box flexDirection="row" alignItems="flex-end">
				<Box flexShrink={0}>
					<Text color={NAMZU_MARK_COLOR} bold>
						{wordmark}
					</Text>
				</Box>
				{columns >= 16 ? (
					<Box marginLeft={2} flexGrow={1} minWidth={0}>
						<Text color={theme.text.muted} wrap="truncate-end">
							{attribution}
						</Text>
					</Box>
				) : null}
			</Box>
			{permissionMode === 'auto' ? (
				<Box marginTop={1}>
					<Text color={theme.status.warn}>
						⚠ {permissionModeLabel(permissionMode)} — tools run without asking. Use /permissions to
						change this.
					</Text>
				</Box>
			) : null}
		</Box>
	)
}
