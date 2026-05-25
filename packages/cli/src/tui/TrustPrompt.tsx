/**
 * Trust-folder gate, shown on launch when the working directory hasn't
 * been trusted before. namzu can read, run commands in, and edit files in
 * this folder, so the user confirms first (Claude-Code style). The parent
 * (App) owns the keypress handling; this component is presentational.
 */

import { Box, Text } from 'ink'

import { theme } from './theme.js'

export interface TrustPromptProps {
	readonly cwd: string
}

export function TrustPrompt({ cwd }: TrustPromptProps) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.status.warn}
			paddingX={2}
			paddingY={1}
		>
			<Text color={theme.status.warn} bold>
				Do you trust the files in this folder?
			</Text>
			<Box marginTop={1}>
				<Text color={theme.accent.user}>{cwd}</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Text color={theme.text.secondary}>
					namzu can read, run commands in, and edit files in this folder.
				</Text>
				<Text color={theme.text.secondary}>Only continue if you trust its contents.</Text>
			</Box>
			<Box marginTop={1}>
				<Text color={theme.text.muted}>
					<Text color={theme.status.ok} bold>
						y
					</Text>{' '}
					trust this folder ·{' '}
					<Text color={theme.status.error} bold>
						n
					</Text>{' '}
					exit
				</Text>
			</Box>
		</Box>
	)
}
