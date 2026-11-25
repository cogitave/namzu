import { Box, Text, useWindowSize } from 'ink'

import { fitHints } from './key-hints.js'
import { selectionWindow } from './selection-window.js'
import {
	MANAGER_HINTS,
	MANAGER_SEARCH_HINTS,
	type ManagerState,
	layoutRow,
	nameColumn,
	rowBudget,
	selectedIndex,
	subtitle,
	visibleRows,
} from './skills-manager.js'
import { truncateChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface SkillsManagerProps {
	readonly state: ManagerState
	/** Width left by the parent after its own margin. */
	readonly columns: number
}

/** `/skills`: one row per skill; App owns the keys and the save. */
export function SkillsManager({ state, columns }: SkillsManagerProps) {
	const terminal = useWindowSize()
	const width = Math.max(20, columns - 2)
	const rows = visibleRows(state)
	const selected = selectedIndex(state)
	const { start, items } = selectionWindow(rows, selected, rowBudget(terminal.rows))
	const nameWidth = nameColumn(rows, width)
	const row = rows[selected]
	const note = row?.note
	const hints = state.searching ? MANAGER_SEARCH_HINTS : MANAGER_HINTS
	const before = start
	const after = Math.max(0, rows.length - start - items.length)
	const searchText = state.query === '' && !state.searching ? 'Search skills…' : state.query
	return (
		<Box flexDirection="column" paddingX={1}>
			<Text color={theme.accent.assistant} bold>
				Skills
			</Text>
			<Text color={theme.text.muted}>{subtitle(state)}</Text>
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
			{rows.length === 0 ? <Text color={theme.text.muted}> No skills match</Text> : null}
			{before > 0 ? <Text color={theme.text.muted}>{`  ↑ ${before} more`}</Text> : null}
			{items.map((item, offset) => {
				const index = start + offset
				const active = index === selected
				const layout = layoutRow(item, active, nameWidth, width)
				return (
					<Text key={item.name} wrap="truncate-end">
						<Text color={active ? theme.accent.assistant : theme.text.muted}>{layout.lead}</Text>
						<Text
							color={
								item.state === 'off' || item.locked !== undefined
									? theme.text.muted
									: active
										? theme.text.primary
										: theme.text.secondary
							}
							bold={active}
						>
							{layout.name}
						</Text>
						<Text color={theme.text.muted}>{layout.meta}</Text>
					</Text>
				)
			})}
			{after > 0 ? <Text color={theme.text.muted}>{`  ↓ ${after} more`}</Text> : null}
			<Box height={1} marginTop={1}>
				<Text
					color={row?.locked !== undefined ? theme.status.warn : theme.text.muted}
					wrap="truncate-end"
				>
					{note ? truncateChoiceText(note, width) : ' '}
				</Text>
			</Box>
			<Text color={theme.text.muted}>{fitHints([...hints], Math.max(1, columns - 2))}</Text>
		</Box>
	)
}
