import { Box, Text, useWindowSize } from 'ink'

import { boxedHintWidth, fitHints } from './key-hints.js'
import {
	NOTHING_TO_REWIND,
	REWIND_CODE_WARNING,
	REWIND_CONTEXT_PLACEHOLDER,
	REWIND_OPTION_LABELS,
	type RewindOption,
	type RewindRow,
	type RewindState,
	ageText,
	canRestoreCodeAt,
	codeLine,
	confirmHeader,
	conversationLine,
	isSummarize,
	listHeader,
	rewindRowDetail,
} from './rewind.js'
import { selectionWindow } from './selection-window.js'
import { theme } from './theme.js'

export interface RewindPickerProps {
	readonly rows: readonly RewindRow[]
	readonly state: RewindState
	readonly options: readonly RewindOption[]
	/** False when this conversation keeps no file history. */
	readonly checkpointing: boolean
	readonly now: number
	/** Words shown beside the options while a choice is carried out. */
	readonly working?: string
}

/** Visible list rows: three lines each with the files line, two without. */
const LIST_WINDOW = 5

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim() || '((empty message))'
}

/** Both stages of the rewind picker. */
export function RewindPicker(props: RewindPickerProps) {
	const { rows, state } = props
	const terminal = useWindowSize()
	const hints = fitHints(
		[
			// On the list Enter goes on to the options; on the options it does the thing.
			state.stage === 'list'
				? { text: 'enter continue', short: 'enter', rank: 5 }
				: { text: 'enter choose', short: 'enter', rank: 5 },
			state.stage === 'list'
				? { text: 'esc cancel', short: 'esc', rank: 5 }
				: { text: 'esc back', short: 'esc', rank: 5 },
		],
		boxedHintWidth(terminal.columns),
	)
	const promptRows = rows.filter((row) => row.kind === 'prompt')
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Text color={theme.accent.user} bold>
				Rewind
			</Text>
			{state.error ? (
				<Box paddingTop={1}>
					<Text color={theme.status.error}>{state.error}</Text>
				</Box>
			) : null}
			{promptRows.length === 0 ? (
				<Box paddingTop={1}>
					<Text color={theme.text.muted}>{NOTHING_TO_REWIND}</Text>
				</Box>
			) : state.stage === 'list' ? (
				<RewindList {...props} />
			) : (
				<RewindConfirm {...props} />
			)}
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>{state.busy ? (props.working ?? 'Working…') : hints}</Text>
			</Box>
		</Box>
	)
}

function RewindList({ rows, state, checkpointing }: RewindPickerProps) {
	const { start, items } = selectionWindow(rows, state.selected, LIST_WINDOW)
	return (
		<Box flexDirection="column" paddingTop={1}>
			<Text color={theme.text.primary}>{listHeader(checkpointing)}</Text>
			<Box flexDirection="column" paddingTop={1}>
				{items.map((row, offset) => {
					const index = start + offset
					const selected = index === state.selected
					const detail = rewindRowDetail(row.files)
					return (
						<Box key={row.prompt?.userOrdinal ?? 'current'} flexDirection="column">
							<Box>
								<Box width={2} flexShrink={0}>
									<Text color={theme.accent.user}>{selected ? '›' : ' '}</Text>
								</Box>
								<Box flexGrow={1} paddingRight={10}>
									{row.kind === 'current' ? (
										<Text
											italic
											color={selected ? theme.text.primary : theme.text.secondary}
											bold={selected}
										>
											(current)
										</Text>
									) : (
										<Text
											color={selected ? theme.text.primary : theme.text.secondary}
											bold={selected}
											wrap="truncate-end"
										>
											{oneLine(row.prompt?.displayText ?? '')}
										</Text>
									)}
								</Box>
							</Box>
							{detail ? (
								<Box paddingLeft={2}>
									<Text color={theme.text.muted} wrap="truncate-end">
										{detail}
									</Text>
								</Box>
							) : null}
						</Box>
					)
				})}
			</Box>
		</Box>
	)
}

function RewindConfirm({ rows, state, options, now }: RewindPickerProps) {
	const row = state.target === undefined ? undefined : rows[state.target]
	if (!row?.prompt) return null
	const canRestoreCode = canRestoreCodeAt(row)
	const age = ageText(row.prompt.message.timestamp, now)
	const code = codeLine(state.option, row.files)
	return (
		<Box flexDirection="column" paddingTop={1}>
			<Text color={theme.text.primary}>{confirmHeader(canRestoreCode)}</Text>
			<Box
				flexDirection="column"
				paddingLeft={1}
				borderStyle="single"
				borderRight={false}
				borderTop={false}
				borderBottom={false}
				borderColor={theme.text.muted}
			>
				<Text color={theme.text.primary} wrap="truncate-end">
					{oneLine(row.prompt.displayText)}
				</Text>
				{age ? <Text color={theme.text.muted}>({age})</Text> : null}
			</Box>
			<Box flexDirection="column">
				<Text color={theme.text.muted}>{conversationLine(state.option)}</Text>
				{code ? <Text color={theme.text.muted}>{code}</Text> : null}
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				{options.map((option) => {
					const focused = option === state.option
					const summarize = isSummarize(option)
					const typed = summarize ? state.texts[option as 'summarize' | 'summarize_up_to'] : ''
					return (
						<Box key={option}>
							<Box width={2} flexShrink={0}>
								<Text color={theme.accent.user}>{focused ? '›' : ' '}</Text>
							</Box>
							<Text color={focused ? theme.text.primary : theme.text.secondary} bold={focused}>
								{REWIND_OPTION_LABELS[option]}
							</Text>
							{summarize && (typed || focused) ? (
								<Text color={theme.text.muted}>
									{': '}
									{typed || REWIND_CONTEXT_PLACEHOLDER}
									{focused && typed ? '▏' : ''}
								</Text>
							) : null}
						</Box>
					)
				})}
			</Box>
			{canRestoreCode ? (
				<Box paddingTop={1}>
					<Text color={theme.text.muted}>{REWIND_CODE_WARNING}</Text>
				</Box>
			) : null}
		</Box>
	)
}
