/**
 * The confirmation for `save_skill`: the whole `SKILL.md` as it would be
 * written, invisible characters shown, where each choice writes, and which
 * skill it would replace or be hidden by.
 *
 * It owns its keys while it is up (App steps aside, as for `TextPrompt`).
 * "Cancel" is selected when it opens, so a stray Enter writes nothing.
 */

import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import stringWidth from 'string-width'

import {
	type SaveSkillAnswer,
	type SaveSkillRequest,
	type SkillSaveTarget,
	describeCollision,
} from '../skills/save.js'
import { terminalDisplayText } from './terminal-display.js'
import { truncateChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface SaveSkillOverlayProps {
	readonly request: SaveSkillRequest
	/** The session's working directory, for `./…` paths. */
	readonly cwd: string
	readonly columns?: number
	readonly rows?: number
	readonly onAnswer: (answer: SaveSkillAnswer) => void
}

export const SAVE_SKILL_CHOICES: readonly {
	readonly answer: SaveSkillAnswer
	readonly label: string
}[] = [
	{ answer: 'user', label: 'Save to user' },
	{ answer: 'project', label: 'Save to project' },
	{ answer: 'cancel', label: 'Cancel' },
]

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Hard-wrap each line at `width` cells, keeping every character — indentation
 * and trailing spaces included. A reviewer is reading for what the file says,
 * so nothing the wrap invents may look like part of it: continuation rows are
 * marked by the gutter, not by the text.
 */
export function wrapExact(text: string, width: number): { text: string; continued: boolean }[] {
	const max = Math.max(1, width)
	const rows: { text: string; continued: boolean }[] = []
	for (const line of terminalDisplayText(text).split('\n')) {
		let current = ''
		let used = 0
		let continued = false
		for (const { segment } of graphemes.segment(line.replace(/\t/g, '    '))) {
			const cells = stringWidth(segment)
			if (used + cells > max && current !== '') {
				rows.push({ text: current, continued })
				current = ''
				used = 0
				continued = true
			}
			current += segment
			used += cells
		}
		rows.push({ text: current, continued })
	}
	return rows
}

function targetLines(target: SkillSaveTarget, cwd: string, suggested: boolean): string[] {
	const head = `${target.scope === 'user' ? 'User   ' : 'Project'}  ${target.displayPath}${suggested ? '  (suggested)' : ''}`
	return [head, ...target.collisions.map((c) => `         ${describeCollision(c, cwd)}`)]
}

export function SaveSkillOverlay({ request, cwd, columns, rows, onAnswer }: SaveSkillOverlayProps) {
	const width = Math.max(20, (columns ?? 80) - 4)
	const [selected, setSelected] = useState(SAVE_SKILL_CHOICES.length - 1)
	const [offset, setOffset] = useState(0)

	const header = [
		`✎ Save skill "${request.draft.name}"? PROPOSED BY THE MODEL — a skill is read by every later session that loads it.`,
		`Origin ${request.draft.origin}${request.sessionId ? ` · session ${request.sessionId}` : ''}`,
		...targetLines(request.targets.user, cwd, request.suggested === 'user'),
		...targetLines(request.targets.project, cwd, request.suggested === 'project'),
		...request.warnings.map((w) => `Warning  ${w}`),
	]
	const headerRows = header.flatMap((line) => wrapExact(line, width))
	const body = wrapExact(request.revealed.replace(/\n$/, ''), width - 2)
	// Border, header, the preview's title, the choices and the hint.
	const chrome = headerRows.length + 7
	const window = Math.max(4, (rows ?? 24) - chrome - 2)
	const maxOffset = Math.max(0, body.length - window)
	const top = Math.min(offset, maxOffset)
	const visible = body.slice(top, top + window)

	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			onAnswer('cancel')
			return
		}
		if (key.return) {
			onAnswer(SAVE_SKILL_CHOICES[selected]?.answer ?? 'cancel')
			return
		}
		if (input === '1' || input === '2' || input === '3') {
			setSelected(Number(input) - 1)
			return
		}
		if (key.leftArrow || (key.shift && key.tab)) {
			setSelected((i) => (i + SAVE_SKILL_CHOICES.length - 1) % SAVE_SKILL_CHOICES.length)
			return
		}
		if (key.rightArrow || key.tab) {
			setSelected((i) => (i + 1) % SAVE_SKILL_CHOICES.length)
			return
		}
		if (key.upArrow) setOffset(Math.max(0, top - 1))
		else if (key.downArrow) setOffset(Math.min(maxOffset, top + 1))
		else if (key.pageUp) setOffset(Math.max(0, top - window))
		else if (key.pageDown) setOffset(Math.min(maxOffset, top + window))
		else if (key.home) setOffset(0)
		else if (key.end) setOffset(maxOffset)
	})

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.status.warn} paddingX={1}>
			{headerRows.map((row, index) => (
				<Text
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
					key={`h${index}`}
					color={
						index === 0
							? theme.status.warn
							: row.text.startsWith('Warning')
								? theme.status.warn
								: theme.text.secondary
					}
					bold={index === 0}
				>
					{row.text}
				</Text>
			))}
			<Text color={theme.text.muted}>
				{truncateChoiceText(
					`SKILL.md, exactly as it will be written (lines ${body.length === 0 ? 0 : top + 1}–${Math.min(body.length, top + window)} of ${body.length})`,
					width,
				)}
			</Text>
			{visible.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
				<Text key={`b${top + index}`}>
					<Text color={theme.text.muted}>{row.continued ? '┆ ' : '│ '}</Text>
					{row.text}
				</Text>
			))}
			<Box paddingTop={1}>
				{SAVE_SKILL_CHOICES.map((choice, index) => (
					<Box key={choice.answer} marginRight={2}>
						<Text
							color={index === selected ? theme.accent.user : theme.text.secondary}
							inverse={index === selected}
						>
							{` ${index + 1} ${choice.label} `}
						</Text>
					</Box>
				))}
			</Box>
			<Text color={theme.text.muted}>
				{truncateChoiceText('←/→ choose · enter apply · ↑/↓ PgUp/PgDn scroll · esc cancel', width)}
			</Text>
		</Box>
	)
}
