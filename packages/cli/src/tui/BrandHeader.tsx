import { Box, Text, useWindowSize } from 'ink'

import type { PermissionMode } from '../permissions/mode.js'
import { NAMZU_MARK, NAMZU_MARK_COLOR, NAMZU_MONOGRAM, NAMZU_MONOGRAM_MIN_WIDTH } from './logo.js'
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
	const wide = columns >= NAMZU_MONOGRAM_MIN_WIDTH
	const home = process.env.HOME
	const prettyCwd =
		home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd
	return (
		<Box flexDirection="column" marginY={1}>
			<Box flexDirection="row">
				<Box width={wide ? 6 : 2} flexShrink={0} flexDirection="column">
					{wide ? (
						NAMZU_MONOGRAM.map((line) => (
							<Text key={line} color={NAMZU_MARK_COLOR}>
								{line}
							</Text>
						))
					) : (
						<Text color={NAMZU_MARK_COLOR}>{NAMZU_MARK}</Text>
					)}
				</Box>
				<Box flexDirection="column" flexGrow={1} minWidth={0}>
					<Text wrap="truncate-end">
						<Text color={theme.text.primary} bold>
							namzu
						</Text>
						<Text color={theme.text.muted}> Cogitave v{terminalDisplayText(version)}</Text>
					</Text>
					<Text color={theme.text.secondary} wrap="truncate-start">
						{terminalDisplayText(prettyCwd)}
					</Text>
					<Text color={theme.text.muted} wrap="truncate-end">
						{provider
							? terminalDisplayText(`${provider}${model ? ` · ${model}` : ''}`)
							: 'Ready when you are'}
					</Text>
				</Box>
			</Box>
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
