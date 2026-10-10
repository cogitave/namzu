/**
 * Trust-folder gate, shown on launch when the working directory hasn't
 * been trusted before. namzu can read, run commands in, and edit files in
 * this folder, so the user confirms first. The parent
 * (App) owns the keypress handling; this component is presentational.
 */

import { Box, Text, useWindowSize } from 'ink'

import { displayPath } from './person-terms.js'
import { wrapChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface TrustPromptProps {
	readonly cwd: string
}

/** Cells the path may use: the terminal minus the border (2) and the padding (4). */
export function trustPathWidth(columns: number): number {
	return Math.max(8, columns - 6)
}

export function TrustPrompt({ cwd }: TrustPromptProps) {
	const terminal = useWindowSize()
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
				<Text color={theme.accent.user}>{displayPath(cwd, trustPathWidth(terminal.columns))}</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{/* Wrapped by hand: Ink keeps the space a break falls on, and the next line starts with it. */}
				{[
					'namzu can read, run commands in, and edit files in this folder.',
					'Only continue if you trust its contents.',
				].flatMap((sentence) =>
					wrapChoiceText(sentence, trustPathWidth(terminal.columns)).map((line, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
						<Text key={`${sentence}-${at}`} color={theme.text.secondary}>
							{line}
						</Text>
					)),
				)}
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
					or{' '}
					<Text color={theme.status.error} bold>
						esc
					</Text>{' '}
					exit
				</Text>
			</Box>
		</Box>
	)
}
