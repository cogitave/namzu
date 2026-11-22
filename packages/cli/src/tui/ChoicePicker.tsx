import { Box, Text, useWindowSize } from 'ink'
import type { ReactNode } from 'react'

import { choicePickerWindowSize } from './choice-selection.js'
import { fitHints } from './key-hints.js'
import { selectionWindow } from './selection-window.js'
import {
	capChoiceLines,
	choiceDisplayWidth,
	truncateAtSeparator,
	truncateChoiceText,
	wrapChoiceText,
} from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface ChoicePickerOption {
	readonly label: string
	readonly description: string
	readonly current?: boolean
	readonly default?: boolean
	/** The asker's recommendation (`ask_user_question`'s `recommended`), drawn as `[recommended]`. */
	readonly recommended?: boolean
	readonly disabledReason?: string
	readonly selectedDescription?: string
	readonly searchText?: string
	/** Draw a horizontal rule above this row — a different KIND of setting, not a later item in the same list. */
	readonly ruleBefore?: boolean
}

export interface ChoicePickerProps {
	readonly busy?: boolean
	readonly title: string
	readonly notice?: string
	/** A quiet line under the title, e.g. `1 running, 2 finished`. */
	readonly subtitle?: string
	/**
	 * Plain lines drawn under the title, above the rows: what the list is about
	 * when one line of `notice` is not enough, e.g. the `/peers` roster. Each
	 * line is cut to the width, and the block is capped so the rows keep room.
	 */
	readonly body?: readonly string[]
	/** Replaces the standard key hints, e.g. a list whose Enter opens rather than applies. */
	readonly hints?: readonly { readonly text: string; readonly rank: number }[]
	/** Already filtered; each row retains the caller's original option identity. */
	readonly options: readonly ChoicePickerOption[]
	readonly selected: number
	readonly windowSize?: number
	/** Width left by the parent after its own padding, when smaller than the terminal. */
	readonly columns?: number
	/** Present for a searchable chooser. App owns typing, filtering and selection. */
	readonly query?: string
	readonly searchPlaceholder?: string
	/** Drawn under the rows, above the key hints (the theme picker's sample). */
	readonly extra?: ReactNode
	/**
	 * A question's options: the selected option's whole description is shown, wrapped, under
	 * its row, and the corner carries no `n/m` count (it would read as a question number).
	 */
	readonly describeSelected?: boolean
}

/** The body lines that fit: the first `max`, the last of them saying how many were left out. */
function capBody(lines: readonly string[], max: number): readonly string[] {
	if (lines.length <= max) return lines
	return [...lines.slice(0, max - 1), `… ${lines.length - (max - 1)} more lines`]
}

/** The most lines the selected option's description takes when it is shown whole. */
export const SELECTED_DESCRIPTION_LINES = 8

/** The most lines a description takes when it wraps under its label. */
const STACKED_DESCRIPTION_LINES = 2

/** Finite command chooser; App owns keys and applies the selected authority. */
export function ChoicePicker({
	busy = false,
	title,
	notice,
	subtitle,
	body,
	hints,
	options,
	selected,
	windowSize,
	columns: availableColumns,
	query,
	searchPlaceholder = 'Type to filter',
	extra,
	describeSelected = false,
}: ChoicePickerProps) {
	const terminal = useWindowSize()
	const columns = availableColumns ?? terminal.columns ?? 80
	const contentWidth = Math.max(1, columns - 4)
	const stacked = columns < 70
	const selectedOption = options[selected]
	const detail = selectedOption?.disabledReason ?? selectedOption?.selectedDescription
	const hasDetail = options.some((option) =>
		Boolean(option.selectedDescription || option.disabledReason),
	)
	const hasRule = options.some((option) => option.ruleBefore)
	// Below 70 columns a description sits under its label and wraps (two lines
	// at most) rather than being cut mid-sentence.
	const stackedDescription = (option: ChoicePickerOption, whole = false): readonly string[] =>
		capChoiceLines(
			wrapChoiceText(option.disabledReason ?? option.description, Math.max(1, columns - 4 - 4)),
			whole ? SELECTED_DESCRIPTION_LINES : STACKED_DESCRIPTION_LINES,
			Math.max(1, columns - 4 - 4),
		)
	// Under a row, the selected option's description in full; the height is the tallest any
	// option needs, so the box does not change height as the cursor moves.
	const wholeDescription = (option: ChoicePickerOption): readonly string[] =>
		option.description.length === 0
			? []
			: capChoiceLines(
					wrapChoiceText(option.description, Math.max(1, contentWidth - 4)),
					SELECTED_DESCRIPTION_LINES,
					Math.max(1, contentWidth - 4),
				)
	const detailRows = !describeSelected
		? 0
		: stacked
			? SELECTED_DESCRIPTION_LINES - STACKED_DESCRIPTION_LINES
			: Math.max(0, ...options.map((option) => wholeDescription(option).length))
	const bodyLines = capBody(body ?? [], Math.max(3, terminal.rows - 14))
	const pageSize = choicePickerWindowSize({
		bodyRows: bodyLines.length,
		rowHeight: stacked
			? 1 + Math.max(1, ...options.map((option) => stackedDescription(option).length))
			: 1,
		rows: terminal.rows,
		columns,
		searchable: query !== undefined,
		notice: Boolean(notice) || Boolean(subtitle),
		selectedDescription: hasDetail,
		rule: hasRule,
		windowSize,
		detailRows,
	})
	const { start, items: visible } = selectionWindow(options, selected, pageSize)
	const count = describeSelected ? '' : `${selectedOption ? selected + 1 : 0}/${options.length}`
	const markerFor = (option: ChoicePickerOption) =>
		[
			option.current ? '[current]' : '',
			option.default ? '[default]' : '',
			option.recommended ? '[recommended]' : '',
		]
			.filter(Boolean)
			.join(' ')
	const markerWidth = Math.max(0, ...visible.map((option) => choiceDisplayWidth(markerFor(option))))
	const rowWidth = Math.max(1, contentWidth - 4)
	const labelWidth = stacked
		? Math.max(1, rowWidth - (markerWidth > 0 ? markerWidth + 1 : 0))
		: Math.max(
				1,
				Math.min(
					42,
					rowWidth - markerWidth - 18,
					Math.max(18, ...visible.map((option) => choiceDisplayWidth(option.label))),
				),
			)
	const descriptionWidth = Math.max(
		1,
		rowWidth - labelWidth - markerWidth - (markerWidth > 0 ? 2 : 1),
	)
	const footer = busy
		? 'ctrl+c exit'
		: hints
			? fitHints([...hints], contentWidth)
			: fitHints(
					[
						...(query !== undefined ? [{ text: 'type to filter', rank: 3 }] : []),
						{ text: '↑↓ select', rank: 5 },
						...(columns >= 100 ? [{ text: 'PgUp/PgDn jump', rank: 1 }] : []),
						...(columns >= 100 && query === undefined
							? [
									{ text: 'Home/End', rank: 1 },
									{ text: '1–9 select', rank: 2 },
								]
							: []),
						{ text: 'enter apply', rank: 5 },
						{ text: 'esc back', rank: 4 },
					],
					contentWidth,
				)
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.default} paddingX={1}>
			<Box justifyContent="space-between">
				<Text color={theme.accent.assistant} bold>
					{truncateChoiceText(title, contentWidth - (count ? choiceDisplayWidth(count) + 1 : 0))}
				</Text>
				<Text color={theme.text.muted}>{count}</Text>
			</Box>
			{subtitle ? (
				<Text color={theme.text.muted}>{truncateChoiceText(subtitle, contentWidth)}</Text>
			) : null}
			{bodyLines.map((line, lineIndex) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a body line has no identity beyond its position.
				<Text key={`b-${lineIndex}`} color={theme.text.secondary}>
					{line.length === 0 ? ' ' : truncateChoiceText(line, contentWidth)}
				</Text>
			))}
			{query !== undefined ? (
				<Text color={query.length > 0 ? theme.text.primary : theme.text.muted}>
					{truncateChoiceText(`Search: ${query || searchPlaceholder}`, contentWidth)}
				</Text>
			) : null}
			{notice ? (
				<Text color={theme.status.warn}>{truncateChoiceText(notice, contentWidth)}</Text>
			) : null}
			{visible.length === 0 ? <Text color={theme.text.muted}>No matching options</Text> : null}
			{visible.map((option, visibleIndex) => {
				const index = start + visibleIndex
				const active = index === selected
				const markers = markerFor(option)
				const description = option.disabledReason ?? option.description
				return (
					<Box key={`${option.label}-${index}`} flexDirection="column">
						{option.ruleBefore ? (
							<Text color={theme.border.default}>{'─'.repeat(contentWidth)}</Text>
						) : null}
						<Box>
							<Box width={4} flexShrink={0}>
								<Text color={theme.accent.assistant}>
									{active ? '›' : ' '}
									{query === undefined && index < 9 ? `${index + 1}.` : '  '}
								</Text>
							</Box>
							<Box width={labelWidth} flexShrink={0}>
								<Text
									color={
										option.disabledReason
											? theme.text.muted
											: active
												? theme.text.primary
												: theme.text.secondary
									}
									bold={active}
								>
									{truncateChoiceText(option.label, labelWidth)}
								</Text>
							</Box>
							{markerWidth > 0 ? (
								<Box width={markerWidth + 1} flexShrink={0} paddingLeft={1}>
									<Text
										color={
											option.current || option.recommended
												? theme.accent.assistant
												: theme.text.muted
										}
									>
										{markers}
									</Text>
								</Box>
							) : null}
							{!stacked && !(describeSelected && active) ? (
								<Box paddingLeft={1} flexGrow={1} minWidth={0}>
									<Text color={theme.text.muted}>
										{truncateAtSeparator(description, descriptionWidth)}
									</Text>
								</Box>
							) : null}
						</Box>
						{stacked ? (
							<Box paddingLeft={4} flexDirection="column">
								{stackedDescription(option, describeSelected && active).map((line, lineIndex) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: a wrapped line has no identity beyond its position.
									<Text key={`l-${lineIndex}`} color={theme.text.muted}>
										{line}
									</Text>
								))}
							</Box>
						) : null}
					</Box>
				)
			})}
			{describeSelected && !stacked && detailRows > 0 ? (
				<Box height={detailRows} paddingLeft={4} flexDirection="column">
					{(selectedOption ? wholeDescription(selectedOption) : []).map((line, lineIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a wrapped line has no identity beyond its position.
						<Text key={`d-${lineIndex}`} color={theme.text.secondary}>
							{line}
						</Text>
					))}
				</Box>
			) : null}
			{hasDetail ? (
				<Box height={1}>
					<Text color={selectedOption?.disabledReason ? theme.status.warn : theme.text.secondary}>
						{detail ? truncateChoiceText(detail, contentWidth) : ''}
					</Text>
				</Box>
			) : null}
			{extra}
			<Text color={theme.text.muted}>{truncateChoiceText(footer, contentWidth)}</Text>
		</Box>
	)
}
