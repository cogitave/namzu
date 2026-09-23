/**
 * The reasoning-effort chooser drawn as a left-to-right slider:
 *
 *                Faster                                      Smarter
 *                ──────────────▲───────────────────────┆────────────
 *                default   low   medium   high   xhigh   max   ┆ orchestrate
 *                                                               max + delegate by default
 *
 * Stops are `default`, then the model's published levels in the order the
 * provider publishes them (low to high), then `orchestrate` after a `┆`: a
 * session mode, not one more level, drawn in its own colour. The `▲` caret
 * marks the stop Enter would apply; the current setting's label is the
 * accent colour.
 *
 * Layout is computed from the labels' widths, never from a fixed grid, and a
 * terminal the stops do not fit on gets the vertical list instead — see
 * {@link effortSliderLayout}. App owns the keys and applies the choice.
 */

import { Box, Text } from 'ink'
import stringWidth from 'string-width'

import type { ChoicePickerOption } from './ChoicePicker.js'
import { truncateChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

/** Narrower than this and the slider is not attempted. */
export const EFFORT_SLIDER_MIN_COLUMNS = 60

const SIDE_MARGIN = 2
const SEPARATOR = '┆'

export interface EffortSliderLayout {
	/** Column each stop's label starts at, relative to the slider's left edge. */
	readonly starts: readonly number[]
	/** Column of each stop's centre, where the caret sits. */
	readonly centres: readonly number[]
	/** Column of the `┆` between the last level and `orchestrate`, when there is a mode stop. */
	readonly separator: number | undefined
	/** Total width of the label row. */
	readonly width: number
	/** Blank columns before the label row, to centre it. */
	readonly indent: number
}

/**
 * Where every stop goes on a terminal `columns` wide, or `undefined` when the
 * labels do not fit even with the narrowest gap — the caller then draws the
 * vertical list, which wraps where this cannot.
 *
 * `modeStop` says the last label is a mode (orchestrate) and gets the `┆`
 * before it.
 */
export function effortSliderLayout(
	labels: readonly string[],
	columns: number,
	modeStop = true,
): EffortSliderLayout | undefined {
	if (labels.length === 0 || columns < EFFORT_SLIDER_MIN_COLUMNS) return undefined
	const available = columns - SIDE_MARGIN * 2
	const widths = labels.map((label) => stringWidth(label))
	for (const gap of [3, 2]) {
		const starts: number[] = []
		let column = 0
		let separator: number | undefined
		for (const [index, width] of widths.entries()) {
			if (index > 0) column += gap
			if (modeStop && index === labels.length - 1 && labels.length > 1) {
				separator = column
				column += stringWidth(SEPARATOR) + 1
			}
			starts.push(column)
			column += width
		}
		if (column > available) continue
		const centres = starts.map((start, index) => start + Math.floor(((widths[index] ?? 1) - 1) / 2))
		return {
			starts,
			centres,
			separator,
			width: column,
			indent: SIDE_MARGIN + Math.max(0, Math.floor((available - column) / 2)),
		}
	}
	return undefined
}

export interface EffortSliderProps {
	readonly title: string
	readonly notice?: string
	readonly options: readonly ChoicePickerOption[]
	readonly selected: number
	readonly layout: EffortSliderLayout
	readonly columns: number
	/** The highest published level's label, for the orchestrate stop's sub-label; absent when the model publishes none. */
	readonly highest?: string
}

export function EffortSlider({
	title,
	notice,
	options,
	selected,
	layout,
	columns,
	highest,
}: EffortSliderProps) {
	const last = options.length - 1
	const pad = ' '.repeat(layout.indent)
	const ends = { left: 'Faster', right: 'Smarter' }
	const endsGap = Math.max(1, layout.width - stringWidth(ends.left) - stringWidth(ends.right))
	const caret = layout.centres[selected] ?? 0
	const ruler = Array.from({ length: layout.width }, (_, column) =>
		column === caret ? '▲' : column === layout.separator ? SEPARATOR : '─',
	)
	const modeStart = layout.starts[last] ?? 0
	const subLabel = `${highest ? `${highest} + ` : ''}delegate by default`
	const warn = options.length > 2 && (selected === last || selected === last - 1)
	return (
		<Box flexDirection="column" paddingX={1}>
			<Text color={theme.accent.assistant} bold>
				{truncateChoiceText(title, Math.max(1, columns - 2))}
			</Text>
			{notice ? (
				<Text color={theme.status.warn}>{truncateChoiceText(notice, Math.max(1, columns - 2))}</Text>
			) : null}
			<Text> </Text>
			<Text color={theme.text.muted}>
				{pad}
				{ends.left}
				{' '.repeat(endsGap)}
				{ends.right}
			</Text>
			<Text>
				{pad}
				{ruler.map((cell, column) => (
					<Text
						// biome-ignore lint/suspicious/noArrayIndexKey: one cell per column; the ruler has no reorderable items.
						key={column}
						color={
							cell === '▲'
								? selected === last
									? theme.accent.orchestrate
									: theme.accent.assistant
								: cell === SEPARATOR
									? theme.accent.orchestrate
									: theme.border.default
						}
					>
						{cell}
					</Text>
				))}
			</Text>
			<Text>
				{pad}
				{options.map((option, index) => {
					const start = layout.starts[index] ?? 0
					const previousEnd =
						index === 0 ? 0 : (layout.starts[index - 1] ?? 0) + stringWidth(options[index - 1]?.label ?? '')
					const separatorHere = layout.separator !== undefined && index === last
					const lead = separatorHere
						? `${' '.repeat(Math.max(0, (layout.separator ?? 0) - previousEnd))}${SEPARATOR} `
						: ' '.repeat(Math.max(0, start - previousEnd))
					const isMode = index === last && layout.separator !== undefined
					return (
						<Text key={option.label}>
							<Text color={separatorHere ? theme.accent.orchestrate : undefined}>{lead}</Text>
							<Text
								color={
									isMode
										? theme.accent.orchestrate
										: option.current
											? theme.accent.assistant
											: index === selected
												? theme.text.primary
												: theme.text.muted
								}
								bold={index === selected}
							>
								{option.label}
							</Text>
						</Text>
					)
				})}
			</Text>
			{layout.separator !== undefined ? (
				<Text color={theme.text.muted}>
					{truncateChoiceText(
						`${' '.repeat(layout.indent + modeStart)}${subLabel}`,
						Math.max(1, columns - 2),
					)}
				</Text>
			) : null}
			<Text color={theme.text.muted}>
				{warn
					? truncateChoiceText(
							`${' '.repeat(SIDE_MARGIN)}Spends the most tokens and time; use it for work that splits into independent parts.`,
							Math.max(1, columns - 2),
						)
					: ' '}
			</Text>
			<Text color={theme.text.muted}>
				{truncateChoiceText('←/→ adjust · 1–9 select · enter apply · esc back', Math.max(1, columns - 2))}
			</Text>
		</Box>
	)
}
