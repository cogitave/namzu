import { Box, Text, useWindowSize } from 'ink'

import { choicePickerWindowSize } from './choice-selection.js'
import { selectionWindow } from './selection-window.js'
import { choiceDisplayWidth, truncateChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface ChoicePickerOption {
	readonly label: string
	readonly description: string
	readonly current?: boolean
	readonly default?: boolean
	readonly disabledReason?: string
	readonly selectedDescription?: string
	readonly searchText?: string
}

export interface ChoicePickerProps {
	readonly title: string
	readonly notice?: string
	/** Already filtered; each row retains the caller's original option identity. */
	readonly options: readonly ChoicePickerOption[]
	readonly selected: number
	readonly windowSize?: number
	/** Width left by the parent after its own padding, when smaller than the terminal. */
	readonly columns?: number
	/** Present for a searchable chooser. App owns typing, filtering and selection. */
	readonly query?: string
	readonly searchPlaceholder?: string
}

/** Finite command chooser; App owns keys and applies the selected authority. */
export function ChoicePicker({
	title,
	notice,
	options,
	selected,
	windowSize,
	columns: availableColumns,
	query,
	searchPlaceholder = 'Type to filter',
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
	const pageSize = choicePickerWindowSize({
		rows: terminal.rows,
		columns,
		searchable: query !== undefined,
		notice: Boolean(notice),
		selectedDescription: hasDetail,
		windowSize,
	})
	const { start, items: visible } = selectionWindow(options, selected, pageSize)
	const count = `${selectedOption ? selected + 1 : 0}/${options.length}`
	const markerFor = (option: ChoicePickerOption) =>
		[option.current ? '[current]' : '', option.default ? '[default]' : ''].filter(Boolean).join(' ')
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
	const footer =
		columns >= 100
			? query !== undefined
				? 'Type to filter · ↑↓ navigate · PgUp/PgDn jump · enter apply · esc back'
				: '↑↓ navigate · PgUp/PgDn jump · Home/End · 1–9 select · enter apply · esc back'
			: query !== undefined
				? 'Type to filter · ↑↓ · enter · esc'
				: '↑↓ move · enter apply · esc back'
	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor={theme.border.default}
			paddingX={1}
		>
			<Box justifyContent="space-between">
				<Text color={theme.accent.assistant} bold>
					{truncateChoiceText(title, contentWidth - choiceDisplayWidth(count) - 1)}
				</Text>
				<Text color={theme.text.muted}>{count}</Text>
			</Box>
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
									<Text color={option.current ? theme.accent.assistant : theme.text.muted}>
										{markers}
									</Text>
								</Box>
							) : null}
							{!stacked ? (
								<Box paddingLeft={1} flexGrow={1} minWidth={0}>
									<Text color={theme.text.muted}>
										{truncateChoiceText(description, descriptionWidth)}
									</Text>
								</Box>
							) : null}
						</Box>
						{stacked ? (
							<Box paddingLeft={4}>
								<Text color={theme.text.muted}>{truncateChoiceText(description, rowWidth)}</Text>
							</Box>
						) : null}
					</Box>
				)
			})}
			{hasDetail ? (
				<Box height={1}>
					<Text color={selectedOption?.disabledReason ? theme.status.warn : theme.text.secondary}>
						{detail ? truncateChoiceText(detail, contentWidth) : ''}
					</Text>
				</Box>
			) : null}
			<Text color={theme.text.muted}>{truncateChoiceText(footer, contentWidth)}</Text>
		</Box>
	)
}
