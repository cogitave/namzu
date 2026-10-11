/**
 * Trust-folder gate, shown on launch when the working directory hasn't
 * been trusted before. namzu can read, run commands in, and edit files in
 * this folder, so the user confirms first. The parent
 * (App) owns the keypress handling; this component is presentational.
 */

import { Box, Text, useWindowSize } from 'ink'
import stringWidth from 'string-width'

import { boxedContentWidth } from './key-hints.js'
import { displayPath } from './person-terms.js'
import { wrapBalancedText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface TrustPromptProps {
	readonly cwd: string
}

const PADDING_X = 2

const TITLE = 'Do you trust the files in this folder?'
const SENTENCES = [
	'namzu can read, run commands in, and edit files in this folder.',
	'Only continue if you trust its contents.',
] as const
const YES = 'y trust this folder'
const NO = 'n or esc exit'
const KEYS = new Set(['n', 'esc'])

/** The box's real content width: the host's inset, the border and the padding. */
export function trustPathWidth(columns: number): number {
	return Math.max(8, boxedContentWidth(columns, PADDING_X))
}

/** The title, wrapped evenly to the box's content width. */
export function trustTitleLines(columns: number): readonly string[] {
	return wrapBalancedText(TITLE, trustPathWidth(columns))
}

/** The two sentences, each wrapped evenly to the box's content width. */
export function trustSentenceLines(columns: number): readonly (readonly string[])[] {
	return SENTENCES.map((sentence) => wrapBalancedText(sentence, trustPathWidth(columns)))
}

/** The two choices on one row when they fit, else one row each. */
export function trustChoiceRows(columns: number): readonly (readonly [string, string])[] {
	const room = trustPathWidth(columns)
	return stringWidth(`${YES} · ${NO}`) <= room
		? [[YES, NO]]
		: [
				[YES, ''],
				['', NO],
			]
}

/** One choice: its keys in colour and bold, the rest of the words quiet. */
function choice(text: string) {
	return text.split(' ').map((word, at) => {
		const color = word === 'y' ? theme.status.ok : KEYS.has(word) ? theme.status.error : undefined
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: the words of a fixed label have no identity beyond their order.
			<Text key={at} color={color} bold={color !== undefined}>
				{at > 0 ? ' ' : ''}
				{word}
			</Text>
		)
	})
}

export function TrustPrompt({ cwd }: TrustPromptProps) {
	const terminal = useWindowSize()
	const choices = trustChoiceRows(terminal.columns)
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.status.warn}
			paddingX={PADDING_X}
			paddingY={1}
		>
			{/* Wrapped by hand: Ink keeps the space a break falls on, and the next line starts with it. */}
			{trustTitleLines(terminal.columns).map((line) => (
				<Text key={line} color={theme.status.warn} bold>
					{line}
				</Text>
			))}
			<Box marginTop={1}>
				<Text color={theme.accent.user}>{displayPath(cwd, trustPathWidth(terminal.columns))}</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{trustSentenceLines(terminal.columns).flatMap((lines, sentence) =>
					lines.map((line, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
						<Text key={`${sentence}-${at}`} color={theme.text.secondary}>
							{line}
						</Text>
					)),
				)}
			</Box>
			<Box marginTop={1} flexDirection="column">
				{choices.map(([yes, no]) => (
					<Text key={`${yes}|${no}`} color={theme.text.muted}>
						{yes ? choice(yes) : null}
						{yes && no ? ' · ' : null}
						{no ? choice(no) : null}
					</Text>
				))}
			</Box>
		</Box>
	)
}
