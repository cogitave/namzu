/**
 * Trust-folder gate, shown on launch when the working directory hasn't
 * been trusted before. namzu can read, run commands in, and edit files in
 * this folder, so the user confirms first. The parent
 * (App) owns the keypress handling; this component is presentational.
 */

import { Box, Text, useWindowSize } from 'ink'
import stringWidth from 'string-width'

import { type FolderGrants, MAX_SHOWN_GRANT_RULES } from '../integrations/trust/folder-grants.js'
import { boxedContentWidth } from './key-hints.js'
import { displayPath } from './person-terms.js'
import { wrapBalancedText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface TrustPromptProps {
	readonly cwd: string
	/** What the folder's own config pre-approves, shown before the choice. */
	readonly grants?: FolderGrants
}

const PADDING_X = 2

const TITLE = 'Do you trust the files in this folder?'
const SENTENCES = [
	'namzu can read, run commands in, and edit files in this folder.',
	'Only continue if you trust its contents.',
] as const
const YES = 'y trust this folder'
const NO = 'enter, n or esc exit'
const KEYS = new Set(['enter,', 'n', 'esc'])

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

const GRANTS_NOTICE = 'These will apply without asking. Only continue if you trust this config.'

/** The plain count: `1 rule`, `3 rules`. */
function countOf(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`
}

/**
 * What the folder's own config would let through without asking, before the
 * choice: each allow rule (at most eight, the rest counted) and each added
 * directory, then one line saying they apply unasked. Empty for a folder
 * whose config grants nothing.
 */
export function trustGrantLines(
	grants: FolderGrants | undefined,
	columns: number,
): readonly string[] {
	if (
		!grants ||
		(grants.allowRules.length === 0 &&
			grants.directories.length === 0 &&
			grants.toolServers.length === 0)
	)
		return []
	const room = trustPathWidth(columns)
	const lines: string[] = []
	if (grants.allowRules.length > 0) {
		lines.push(
			`This folder allows ${countOf(grants.allowRules.length, 'action', 'actions')} without asking:`,
		)
		for (const rule of grants.allowRules.slice(0, MAX_SHOWN_GRANT_RULES)) {
			lines.push(`  ${rule.length + 2 > room ? `${rule.slice(0, Math.max(1, room - 3))}…` : rule}`)
		}
		const more = grants.allowRules.length - MAX_SHOWN_GRANT_RULES
		if (more > 0) lines.push(`  and ${more} more`)
	}
	if (grants.directories.length > 0) {
		lines.push(
			`This folder adds ${countOf(grants.directories.length, 'folder', 'folders')} to the workspace:`,
		)
		for (const dir of grants.directories.slice(0, MAX_SHOWN_GRANT_RULES)) {
			lines.push(`  ${displayPath(dir, Math.max(1, room - 2))}`)
		}
		const more = grants.directories.length - MAX_SHOWN_GRANT_RULES
		if (more > 0) lines.push(`  and ${more} more`)
	}
	if (grants.toolServers.length > 0) {
		lines.push(
			`This folder starts ${countOf(grants.toolServers.length, 'tool server', 'tool servers')}:`,
		)
		for (const server of grants.toolServers.slice(0, MAX_SHOWN_GRANT_RULES)) {
			const line = `${server.name}: ${server.runs}`
			lines.push(`  ${line.length + 2 > room ? `${line.slice(0, Math.max(1, room - 3))}…` : line}`)
		}
		const more = grants.toolServers.length - MAX_SHOWN_GRANT_RULES
		if (more > 0) lines.push(`  and ${more} more`)
	}
	lines.push(...wrapBalancedText(GRANTS_NOTICE, room))
	return lines
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

export function TrustPrompt({ cwd, grants }: TrustPromptProps) {
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
			{trustGrantLines(grants, terminal.columns).length > 0 ? (
				<Box marginTop={1} flexDirection="column">
					{trustGrantLines(grants, terminal.columns).map((line, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the lines have no identity beyond their order.
						<Text key={at} color={theme.status.warn}>
							{line}
						</Text>
					))}
				</Box>
			) : null}
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
