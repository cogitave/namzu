/**
 * The card for an `ask_user_question` call that carries several questions,
 * or one question that takes several answers.
 *
 * Laid out like the reference terminal's: a tab for each question with a mark
 * on the ones answered, then a review tab that lists the answers and submits
 * them together. A single choice moves on to the next question as soon as it
 * is chosen; a multiple choice is toggled and moved on from by its last row.
 * "Something else…" is typed in place. Esc skips the whole call (nothing is
 * answered, nothing is assumed), Ctrl+C stops the turn.
 *
 * It owns its keys while it is up, as the other overlays do.
 */

import { Box, Text, useInput, useWindowSize } from 'ink'
import { useRef, useState } from 'react'

import type { QuestionAnswer, UserQuestion } from './agent.js'
import { fitHints } from './key-hints.js'
import {
	type DialogQuestion,
	type QuestionPicks,
	answerLabel,
	buildAnswer,
	dialogQuestions,
	isAnswered,
	summaryLines,
} from './question-dialog.js'
import {
	choiceDisplayText,
	choiceDisplayWidth,
	eraseLastChoiceGrapheme,
	truncateChoiceText,
	wrapChoiceText,
} from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface QuestionDialogProps {
	readonly question: UserQuestion
	readonly columns?: number
	/** Called once, with the transcript lines for what was answered. */
	readonly onAnswer: (answer: QuestionAnswer, summary: readonly string[]) => void
}

type Row =
	| { readonly kind: 'option'; readonly index: number }
	| { readonly kind: 'other' }
	| { readonly kind: 'next' }

function rowsOf(item: DialogQuestion): readonly Row[] {
	return [
		...item.options.map((_, index): Row => ({ kind: 'option', index })),
		...(item.allowFreeText ? [{ kind: 'other' } as const] : []),
		...(item.multiSelect ? [{ kind: 'next' } as const] : []),
	]
}

interface State {
	/** 0..n-1 is a question; n is the review tab. */
	tab: number
	cursors: number[]
	picked: string[][]
	text: string[]
	/** The text a "Something else…" edit started from, while one is open. */
	typing: { readonly from: string } | null
	reviewCursor: number
}

const PREVIEW_LINES = 6

export function QuestionDialog({ question, columns, onAnswer }: QuestionDialogProps) {
	const terminal = useWindowSize()
	const items = dialogQuestions(question)
	const count = items.length
	const lone = count === 1
	const width = Math.max(10, (columns ?? terminal.columns ?? 80) - 4)
	const state = useRef<State>({
		tab: 0,
		cursors: items.map(() => 0),
		picked: items.map(() => []),
		text: items.map(() => ''),
		typing: null,
		reviewCursor: 0,
	})
	const [, redraw] = useState(0)
	const done = useRef(false)
	const s = state.current

	const picks = (): QuestionPicks => ({ picked: s.picked, text: s.text })
	const finish = (answer: QuestionAnswer, summary: readonly string[] = []) => {
		if (done.current) return
		done.current = true
		onAnswer(answer, summary)
	}
	const submit = () => {
		const answer = buildAnswer(question, picks())
		finish(answer, answer.kind === 'answer' ? summaryLines(question, picks()) : [])
	}
	const advance = () => {
		if (lone) submit()
		else s.tab = Math.min(count, s.tab + 1)
	}

	const activate = (item: DialogQuestion, row: Row) => {
		const at = s.tab
		if (row.kind === 'next') {
			advance()
			return
		}
		if (row.kind === 'other') {
			s.typing = { from: s.text[at] ?? '' }
			return
		}
		const option = item.options[row.index]
		if (!option) return
		if (item.multiSelect) {
			const current = s.picked[at] ?? []
			s.picked[at] = current.includes(option.id)
				? current.filter((id) => id !== option.id)
				: [...current, option.id]
			return
		}
		s.picked[at] = [option.id]
		s.text[at] = ''
		advance()
	}

	useInput((input, key) => {
		if (done.current) return
		if (key.ctrl && input === 'c') {
			finish({ kind: 'abort' })
			return
		}
		if (s.typing) {
			const at = s.tab
			if (key.escape) {
				s.text[at] = s.typing.from
				s.typing = null
			} else if (key.return) {
				s.typing = null
				const typed = (s.text[at] ?? '').trim()
				s.text[at] = typed
				if (typed !== '' && !items[at]?.multiSelect) {
					s.picked[at] = []
					advance()
				}
			} else if (key.backspace || key.delete) {
				s.text[at] = eraseLastChoiceGrapheme(s.text[at] ?? '')
			} else if (input && !key.ctrl && !key.meta) {
				s.text[at] = `${s.text[at] ?? ''}${input.replace(/[\r\n]+/g, ' ')}`
			}
			redraw((n) => n + 1)
			return
		}
		if (key.escape) {
			finish({ kind: 'skip' })
			return
		}
		if (s.tab === count) {
			const choose = (index: number) => {
				if (index === 0) submit()
				else finish({ kind: 'skip' })
			}
			if (key.upArrow) s.reviewCursor = 0
			else if (key.downArrow) s.reviewCursor = 1
			else if (key.leftArrow || (key.shift && key.tab)) s.tab = count - 1
			else if (input === '1' || input === '2') choose(Number(input) - 1)
			else if (key.return) choose(s.reviewCursor)
			redraw((n) => n + 1)
			return
		}
		const item = items[s.tab] as DialogQuestion
		const rows = rowsOf(item)
		const at = s.tab
		const cursor = s.cursors[at] ?? 0
		if (!lone && (key.leftArrow || (key.shift && key.tab))) {
			s.tab = Math.max(0, at - 1)
		} else if (!lone && (key.rightArrow || key.tab)) {
			s.tab = Math.min(count, at + 1)
		} else if (key.upArrow) {
			s.cursors[at] = Math.max(0, cursor - 1)
		} else if (key.downArrow) {
			s.cursors[at] = Math.min(rows.length - 1, cursor + 1)
		} else if (key.return || (input === ' ' && item.multiSelect)) {
			const row = rows[cursor]
			if (row) activate(item, row)
		} else if (/^[1-9]$/.test(input) && Number(input) <= rows.length) {
			s.cursors[at] = Number(input) - 1
			const row = rows[Number(input) - 1]
			if (row) activate(item, row)
		}
		redraw((n) => n + 1)
	})

	const hints = fitHints(
		s.typing
			? [
					{ text: 'enter confirm', rank: 5 },
					{ text: 'esc back', rank: 4 },
				]
			: [
					{ text: '↑↓ select', rank: 5 },
					{ text: 'enter confirm', rank: 5 },
					...(!lone ? [{ text: '←→ questions', rank: 3 }] : []),
					...(items[s.tab]?.multiSelect ? [{ text: 'space toggle', rank: 4 }] : []),
					{ text: 'esc cancel', rank: 4 },
				],
		width,
	)

	const tabBar = !lone ? (
		<Box>
			<Text color={theme.text.muted}>{s.tab === 0 ? '  ' : '← '}</Text>
			{items.map((item, index) => {
				const active = s.tab === index
				const label = choiceDisplayText(item.header ?? `Q${index + 1}`)
				return (
					<Box key={item.id} marginRight={2}>
						<Text
							color={active ? theme.accent.assistant : theme.text.secondary}
							bold={active}
							inverse={active}
						>
							{` ${isAnswered(picks(), index) ? '☒' : '☐'} ${truncateChoiceText(label, 16)} `}
						</Text>
					</Box>
				)
			})}
			<Text
				color={s.tab === count ? theme.accent.assistant : theme.text.secondary}
				bold={s.tab === count}
				inverse={s.tab === count}
			>
				{' ✓ Submit '}
			</Text>
			<Text color={theme.text.muted}>{s.tab === count ? '' : ' →'}</Text>
		</Box>
	) : null

	let body: React.ReactNode
	if (s.tab === count) {
		const unanswered = items.some((_, index) => !isAnswered(picks(), index))
		const answeredAny = items.some((_, index) => isAnswered(picks(), index))
		body = (
			<Box flexDirection="column">
				<Text color={theme.accent.assistant} bold>
					Review your answers
				</Text>
				{unanswered ? (
					<Text color={theme.status.warn}>You have not answered all questions</Text>
				) : null}
				{items.map((item, index) =>
					isAnswered(picks(), index) ? (
						<Box key={item.id} flexDirection="column">
							<Text color={theme.text.secondary}>
								{truncateChoiceText(item.question, width - 2)}
							</Text>
							<Text color={theme.status.ok}>
								{'  → '}
								{truncateChoiceText(answerLabel(item, picks(), index), width - 6)}
							</Text>
						</Box>
					) : null,
				)}
				<Text color={theme.text.muted}>
					{answeredAny ? 'Ready to submit your answers?' : 'Nothing is answered yet.'}
				</Text>
				{['Submit answers', 'Cancel'].map((label, index) => (
					<Text
						key={label}
						color={s.reviewCursor === index ? theme.text.primary : theme.text.secondary}
						bold={s.reviewCursor === index}
					>
						{s.reviewCursor === index ? '› ' : '  '}
						{index + 1}. {label}
					</Text>
				))}
			</Box>
		)
	} else {
		const item = items[s.tab] as DialogQuestion
		const rows = rowsOf(item)
		const cursor = s.cursors[s.tab] ?? 0
		const picked = s.picked[s.tab] ?? []
		const focused = rows[cursor]
		const preview = focused?.kind === 'option' ? item.options[focused.index]?.preview : undefined
		const lastRow = lone ? 'Submit' : s.tab === count - 1 ? 'Review' : 'Next'
		body = (
			<Box flexDirection="column">
				<Text color={theme.accent.assistant} bold>
					{truncateChoiceText(item.question, width)}
				</Text>
				{lone && item.header ? (
					<Text color={theme.text.muted}>{truncateChoiceText(item.header, width)}</Text>
				) : null}
				{rows.map((row, rowIndex) => {
					const active = rowIndex === cursor
					const lead = `${active ? '›' : ' '}${rowIndex < 9 ? `${rowIndex + 1}.` : '  '} `
					const tone = active ? theme.text.primary : theme.text.secondary
					if (row.kind === 'next') {
						return (
							<Text key="next" color={tone} bold={active}>
								{lead}
								{lastRow}
							</Text>
						)
					}
					if (row.kind === 'other') {
						const typed = s.text[s.tab] ?? ''
						const editing = s.typing !== null && active
						return (
							<Text key="other" color={tone} bold={active}>
								{lead}
								{item.multiSelect ? (typed.trim() !== '' ? '[x] ' : '[ ] ') : ''}
								{editing
									? `Something else: ${truncateChoiceText(typed, width - 24)}▌`
									: typed.trim() !== ''
										? `Something else: ${truncateChoiceText(typed, width - 24)}`
										: 'Something else…'}
							</Text>
						)
					}
					const option = item.options[row.index]
					if (!option) return null
					const mark = item.multiSelect ? (picked.includes(option.id) ? '[x] ' : '[ ] ') : ''
					const chosen = !item.multiSelect && picked.includes(option.id)
					const badge = option.recommended ? ' [recommended]' : ''
					const room = Math.max(1, width - choiceDisplayWidth(`${lead}${mark}${badge}`))
					const label = truncateChoiceText(option.label, Math.min(room, 40))
					const description = option.description
						? truncateChoiceText(
								option.description,
								Math.max(0, room - choiceDisplayWidth(label) - 2),
							)
						: ''
					return (
						<Box key={option.id}>
							<Text color={chosen ? theme.status.ok : tone} bold={active}>
								{lead}
								{mark}
								{label}
							</Text>
							{badge ? <Text color={theme.accent.assistant}>{badge}</Text> : null}
							{description ? <Text color={theme.text.muted}>{`  ${description}`}</Text> : null}
						</Box>
					)
				})}
				{preview ? (
					<Box flexDirection="column" marginTop={1} paddingLeft={2}>
						{wrapChoiceText(preview, width - 4)
							.slice(0, PREVIEW_LINES)
							.map((line, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
								<Text key={index} color={theme.text.muted}>
									{line}
								</Text>
							))}
					</Box>
				) : null}
			</Box>
		)
	}

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor={theme.border.default}
			paddingX={1}
		>
			{tabBar}
			{body}
			<Text color={theme.text.muted}>{truncateChoiceText(hints, width)}</Text>
		</Box>
	)
}
