import { Box, Text, useWindowSize } from 'ink'

import { type PermissionMode, permissionModeLabel } from '../permissions/mode.js'
import {
	NAMZU_COMPACT_WORDMARK,
	NAMZU_MARK_COLOR,
	NAMZU_WORDMARK,
	NAMZU_WORDMARK_MIN_WIDTH,
} from './logo.js'
import { displayPath } from './person-terms.js'
import { wrapChoiceText } from './terminal-choice-text.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

interface BrandHeaderProps {
	readonly version: string
	readonly permissionMode: PermissionMode
	/** The folder Namzu works in, shown under the version, as a welcome header does. */
	readonly cwd?: string
}

/** The bypass warning wrapped on words, every continuation row indented by the same two columns. */
export function bypassWarningLines(label: string, columns: number): readonly string[] {
	const room = Math.max(10, columns - 3)
	const sentence = `Warning: ${label} — commands and edits run without asking, including outside this folder. Rules that deny or ask still apply. Use /permissions to change this.`
	return wrapChoiceText(sentence, room - 2).map((line, at) => (at === 0 ? line : `  ${line}`))
}

/** Printed once by the transcript's Static owner; active model state lives in the footer. */
export function BrandHeader({ version, permissionMode, cwd }: BrandHeaderProps) {
	const { columns, rows } = useWindowSize()
	const wordmark =
		columns >= NAMZU_WORDMARK_MIN_WIDTH && rows >= 20 ? NAMZU_WORDMARK : NAMZU_COMPACT_WORDMARK
	const shownVersion = `v${terminalDisplayText(version)}`
	const attribution =
		columns >= 52
			? `Namzu ${shownVersion} · by Cogitave`
			: columns >= 30
				? `Namzu ${shownVersion}`
				: shownVersion
	const wordmarkWidth = Math.max(...wordmark.split('\n').map((line) => line.length))
	// Past the wordmark, its two-column gap and the transcript's own column of padding.
	const folderRoom = columns - wordmarkWidth - 3
	const folder =
		cwd && cwd.length > 0 && columns >= 16 && folderRoom >= 8
			? terminalDisplayText(displayPath(cwd, folderRoom))
			: null
	return (
		<Box flexDirection="column" marginY={1}>
			<Box flexDirection="row" alignItems="flex-start">
				<Box flexShrink={0}>
					<Text color={NAMZU_MARK_COLOR} bold>
						{wordmark}
					</Text>
				</Box>
				{columns >= 16 ? (
					<Box marginLeft={2} flexGrow={1} minWidth={0} flexDirection="column">
						<Text color={theme.text.muted} wrap="truncate-end">
							{attribution}
						</Text>
						{folder ? (
							<Text color={theme.text.muted} wrap="truncate-end">
								{folder}
							</Text>
						) : null}
					</Box>
				) : null}
			</Box>
			{permissionMode === 'bypass' ? (
				<Box marginTop={1} flexDirection="column">
					{/* Wrapped by hand: the renderer keeps the space a break falls on, so
					    continuation rows came out one column off and ragged. */}
					{bypassWarningLines(permissionModeLabel(permissionMode), columns).map((line, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
						<Text key={at} color={theme.status.error}>
							{line}
						</Text>
					))}
				</Box>
			) : null}
		</Box>
	)
}
