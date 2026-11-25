import { Box, Text, useWindowSize } from 'ink'

import { fitHints } from './key-hints.js'
import {
	PLUGIN_TABS,
	type PluginScreenState,
	TITLE,
	detailActions,
	detailItem,
	detailLines,
	errorEntries,
	layoutItem,
	lineBudget,
	listLines,
	nameColumn,
	screenHints,
	selectedItem,
	statsColumns,
	statsLine,
	statsNotes,
	statsRows,
	unusedInListing,
	visibleItems,
	wrappedDetail,
} from './plugin-screen.js'
import { selectionWindow } from './selection-window.js'
import { truncateChoiceText, wrapChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface PluginScreenProps {
	readonly state: PluginScreenState
	/** Width left by the parent after its own margin. */
	readonly columns: number
}

/** How many body lines Errors and Stats show at once, and so how far they scroll. */
export function bodyLines(terminalRows: number): number {
	return Math.max(4, terminalRows - 9)
}

/** Lines of text a scrolling tab shows: the body room less the two lines that say there is more. */
function textLines(terminalRows: number): number {
	return Math.max(2, bodyLines(terminalRows) - 2)
}

/** Every line the Errors tab would print at `width`, unscrolled. */
export function errorsBody(state: PluginScreenState, width: number): readonly string[] {
	const entries = errorEntries(state.inputs)
	if (entries.length === 0) return ['No plugin errors']
	const lines: string[] = []
	for (const entry of entries) {
		if (lines.length > 0) lines.push('')
		lines.push(entry.title)
		for (const part of wrapChoiceText(entry.message, Math.max(10, width - 2)))
			lines.push(`  ${part}`)
		for (const part of wrapChoiceText(entry.guidance, Math.max(10, width - 2)))
			lines.push(`  ${part}`)
	}
	return lines
}

/** Every line the Stats tab would print at `width`, unscrolled: heading, table, notes and the unused-skill line. */
export function statsBody(state: PluginScreenState, width: number): readonly string[] {
	const rows = statsRows(state.inputs)
	if (rows.length === 0) return ['No skills are installed.']
	const columns = statsColumns(rows, width)
	const lines = ['Skills loaded this session', '', statsLine(columns, undefined)]
	for (const row of rows) lines.push(statsLine(columns, row))
	lines.push('')
	for (const note of statsNotes(state.inputs)) lines.push(...wrapChoiceText(note, width))
	const unused = unusedInListing(state.inputs)
	if (unused > 0) {
		lines.push('')
		lines.push(
			...wrapChoiceText(
				`${unused} skill${unused === 1 ? '' : 's'} in the listing ${unused === 1 ? 'has' : 'have'} never been loaded. Each adds a line to the system prompt every turn. Turn some off in /skills.`,
				width,
			),
		)
	}
	return lines
}

/** How far Errors or Stats can scroll at this size. */
export function maxScroll(state: PluginScreenState, columns: number, terminalRows: number): number {
	const width = Math.max(20, columns - 2)
	const lines =
		state.tab === 'errors'
			? errorsBody(state, width)
			: state.tab === 'stats'
				? statsBody(state, width)
				: []
	return Math.max(0, lines.length - textLines(terminalRows))
}

/** `/plugin`: a tab row over Installed, Errors and Stats; App owns the keys and the session. */
export function PluginScreen({ state, columns }: PluginScreenProps) {
	const terminal = useWindowSize()
	const width = Math.max(20, columns - 2)
	const detail = detailItem(state)
	const hints = fitHints([...screenHints(state)], Math.max(1, columns - 2))
	return (
		<Box flexDirection="column" paddingX={1}>
			<Text wrap="truncate-end">
				<Text color={theme.accent.assistant} bold>
					{TITLE}
				</Text>
				{PLUGIN_TABS.map((tab) => (
					<Text key={tab.id}>
						{'  '}
						<Text
							color={tab.id === state.tab ? theme.text.primary : theme.text.muted}
							bold={tab.id === state.tab}
							underline={tab.id === state.tab}
						>
							{tab.label}
						</Text>
					</Text>
				))}
			</Text>
			<Box height={1} />
			{detail ? (
				<DetailView state={state} width={width} rows={terminal.rows} />
			) : state.tab === 'installed' ? (
				<InstalledView state={state} width={width} rows={terminal.rows} />
			) : (
				<ScrollView
					lines={state.tab === 'errors' ? errorsBody(state, width) : statsBody(state, width)}
					scroll={state.scroll}
					budget={textLines(terminal.rows)}
				/>
			)}
			<Box height={1} marginTop={1}>
				<Text color={theme.text.muted} wrap="truncate-end">
					{state.notice ? truncateChoiceText(state.notice, width) : ' '}
				</Text>
			</Box>
			<Text color={theme.text.muted}>{hints}</Text>
		</Box>
	)
}

function ScrollView({
	lines,
	scroll,
	budget,
}: {
	readonly lines: readonly string[]
	readonly scroll: number
	readonly budget: number
}) {
	const start = Math.max(0, Math.min(scroll, Math.max(0, lines.length - budget)))
	const shown = lines.slice(start, start + budget)
	const below = Math.max(0, lines.length - start - shown.length)
	return (
		<Box flexDirection="column">
			<Text color={theme.text.muted}>{start > 0 ? `  ↑ ${start} more` : ' '}</Text>
			{shown.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a window of printed lines, never reordered
				<Text
					key={start + index}
					wrap="truncate-end"
					color={line === '' ? undefined : theme.text.secondary}
				>
					{line === '' ? ' ' : line}
				</Text>
			))}
			<Text color={theme.text.muted}>{below > 0 ? `  ↓ ${below} more` : ' '}</Text>
		</Box>
	)
}

function InstalledView({
	state,
	width,
	rows,
}: {
	readonly state: PluginScreenState
	readonly width: number
	readonly rows: number
}) {
	const items = visibleItems(state)
	const lines = listLines(state)
	const current = selectedItem(state)
	const selectedLine = Math.max(
		0,
		lines.findIndex((line) => line.kind === 'item' && line.item.id === current?.id),
	)
	const { start, items: shown } = selectionWindow(lines, selectedLine, lineBudget(rows))
	const after = Math.max(0, lines.length - start - shown.length)
	const nameWidth = nameColumn(items, width)
	const searchText =
		state.query === '' && !state.searching ? 'Search installed items…' : state.query
	return (
		<Box flexDirection="column">
			<Box
				borderStyle="round"
				borderColor={state.searching ? theme.border.focus : theme.border.default}
				paddingX={1}
			>
				<Text
					color={state.query === '' && !state.searching ? theme.text.muted : theme.text.primary}
					wrap="truncate-end"
				>
					{`⌕ ${searchText}${state.searching ? '▏' : ''}`}
				</Text>
			</Box>
			{items.length === 0 && state.query.trim() !== '' ? (
				<Text color={theme.text.muted}> Nothing matches</Text>
			) : null}
			{start > 0 ? <Text color={theme.text.muted}>{`  ↑ ${start} more`}</Text> : null}
			{shown.map((line, offset) => {
				const key = start + offset
				if (line.kind === 'gap') return <Text key={key}> </Text>
				if (line.kind === 'heading') {
					return (
						<Text key={key} color={theme.text.muted} wrap="truncate-end">
							{`  ${line.text}`}
						</Text>
					)
				}
				if (line.kind === 'note') {
					return (
						<Text key={key} color={theme.text.muted} wrap="truncate-end">
							{`    ${line.text}`}
						</Text>
					)
				}
				const active = line.item.id === current?.id
				const layout = layoutItem(line.item, active, nameWidth, width, state.inputs.now)
				const dim =
					(line.item.kind === 'skill' &&
						(line.item.state === 'off' || line.item.problem !== undefined)) ||
					(line.item.kind === 'plugin' && line.item.plugin.status !== 'enabled')
				return (
					<Text key={line.item.id} wrap="truncate-end">
						<Text color={active ? theme.accent.assistant : theme.text.muted}>{layout.lead}</Text>
						<Text
							color={dim ? theme.text.muted : active ? theme.text.primary : theme.text.secondary}
							bold={active}
						>
							{layout.name}
						</Text>
						<Text color={theme.text.muted}>{layout.kind}</Text>
						<Text color={theme.text.muted}>{layout.meta}</Text>
					</Text>
				)
			})}
			{after > 0 ? <Text color={theme.text.muted}>{`  ↓ ${after} more`}</Text> : null}
		</Box>
	)
}

function DetailView({
	state,
	width,
	rows,
}: {
	readonly state: PluginScreenState
	readonly width: number
	readonly rows: number
}) {
	const item = detailItem(state)
	if (!item) return null
	const actions = detailActions(item, state.toolsOpen)
	// What is left of the terminal once the tab row, the actions, the notice and the footer are counted.
	const room = Math.max(3, rows - 8 - actions.length)
	const all = wrappedDetail(detailLines(item, state.toolsOpen, state.inputs.now), width)
	const lines =
		all.length > room ? [...all.slice(0, room - 1), `  … ${all.length - room + 1} more lines`] : all
	const at = Math.min(state.action, actions.length - 1)
	return (
		<Box flexDirection="column">
			{lines.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: printed lines, never reordered
				<Text
					key={index}
					wrap="truncate-end"
					color={index === 0 ? theme.text.primary : theme.text.secondary}
					bold={index === 0}
				>
					{line === '' ? ' ' : line}
				</Text>
			))}
			<Text> </Text>
			{actions.map((action, index) => (
				<Text key={action.id} wrap="truncate-end">
					<Text color={index === at ? theme.accent.assistant : theme.text.muted}>
						{index === at ? '❯ ' : '  '}
					</Text>
					<Text
						color={
							action.disabled !== undefined
								? theme.text.muted
								: index === at
									? theme.text.primary
									: theme.text.secondary
						}
						bold={index === at}
					>
						{action.label}
					</Text>
				</Text>
			))}
		</Box>
	)
}
