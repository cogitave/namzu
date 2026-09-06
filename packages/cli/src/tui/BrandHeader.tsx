import { Box, Text, useWindowSize } from 'ink'

import type { PermissionMode } from '../permissions/mode.js'
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
	readonly provider?: string | null
	readonly model?: string | null
	readonly permissionMode: PermissionMode
	readonly cwd: string
}

/** Printed once by the transcript's Static owner; active model state lives in the footer. */
export function BrandHeader({ version, provider, model, permissionMode, cwd }: BrandHeaderProps) {
	const { columns } = useWindowSize()
	const wordmark = columns >= NAMZU_WORDMARK_MIN_WIDTH ? NAMZU_WORDMARK : NAMZU_COMPACT_WORDMARK
	const attribution = `${columns >= 40 ? 'Cogitave ' : ''}v${terminalDisplayText(version)}`
	const home = process.env.HOME
	const prettyCwd =
		home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd
	return (
		<Box flexDirection="column" marginY={1}>
			<Box flexDirection="row">
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
			<Text color={theme.text.secondary} wrap="truncate-start">
				{terminalDisplayText(prettyCwd)}
			</Text>
			<Text color={theme.text.muted} wrap="truncate-end">
				{provider
					? terminalDisplayText(`${provider}${model ? ` · ${model}` : ''}`)
					: 'Ready when you are'}
			</Text>
			{permissionMode === 'auto' ? (
				<Box marginTop={1}>
					<Text color={theme.status.warn}>
						⚠ launched in auto permission mode — undecided tools run without asking until
						/permissions changes it
					</Text>
				</Box>
			) : null}
		</Box>
	)
}
