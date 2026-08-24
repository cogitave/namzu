import { Box, Text } from 'ink'

import { selectionWindow } from './selection-window.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export interface ChoicePickerOption {
	readonly label: string
	readonly description: string
	readonly current?: boolean
}

export interface ChoicePickerProps {
	readonly title: string
	readonly notice?: string
	readonly options: readonly ChoicePickerOption[]
	readonly selected: number
}

/** Finite command chooser; App owns keys and applies the selected authority. */
export function ChoicePicker({ title, notice, options, selected }: ChoicePickerProps) {
	const { start, items: visible } = selectionWindow(options, selected)
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold>
					{terminalDisplayText(title)}
				</Text>
				<Text color={theme.text.muted}>
					{selected + 1}/{options.length}
				</Text>
			</Box>
			{notice ? (
				<Box paddingTop={1}>
					<Text color={theme.status.warn}>{terminalDisplayText(notice)}</Text>
				</Box>
			) : null}
			<Box flexDirection="column" paddingTop={1}>
				{visible.map((option, visibleIndex) => {
					const index = start + visibleIndex
					return (
						<Box key={`${option.label}-${index}`}>
							<Box width={4} flexShrink={0}>
								<Text color={theme.accent.user}>
									{index === selected ? '›' : ' '}
									{index < 9 ? `${index + 1}.` : '  '}
								</Text>
							</Box>
							<Box width={18} flexShrink={0}>
								<Text
									color={index === selected ? theme.text.primary : theme.text.secondary}
									bold={index === selected}
									wrap="truncate-end"
								>
									{terminalDisplayText(option.label)}
								</Text>
							</Box>
							<Box flexGrow={1}>
								<Text color={theme.text.muted} wrap="truncate-end">
									{terminalDisplayText(option.description)}
									{option.current ? ' (current)' : ''}
								</Text>
							</Box>
						</Box>
					)
				})}
			</Box>
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>↑↓ navigate · 1–9 select · enter apply · esc cancel</Text>
			</Box>
		</Box>
	)
}
