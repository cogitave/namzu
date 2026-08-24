import { Box, Text } from 'ink'

import type { EditablePrompt } from './edit-prompts.js'
import { selectionWindow } from './selection-window.js'
import { theme } from './theme.js'

export interface EditPromptPickerProps {
	readonly prompts: readonly EditablePrompt[]
	readonly selected: number
}

/** Bounded preview for choosing the source-preserving prompt-edit boundary. */
export function EditPromptPicker({ prompts, selected }: EditPromptPickerProps) {
	const { start, items: visible } = selectionWindow(prompts, selected)
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.border.focus}
			paddingX={1}
		>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold>
					Edit a previous prompt in a new branch
				</Text>
				<Text color={theme.text.muted}>
					{selected + 1}/{prompts.length}
				</Text>
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				{visible.map((prompt, visibleIndex) => {
					const index = start + visibleIndex
					const attachmentCount = prompt.message.attachments?.length ?? 0
					return (
						<Box key={prompt.userOrdinal}>
							<Box width={2} flexShrink={0}>
								<Text color={theme.accent.user}>{index === selected ? '›' : ' '}</Text>
							</Box>
							<Box flexGrow={1}>
								<Text
									color={index === selected ? theme.text.primary : theme.text.secondary}
									bold={index === selected}
									wrap="truncate-end"
								>
									{oneLine(prompt.displayText)}
								</Text>
							</Box>
							{attachmentCount > 0 ? (
								<Text color={theme.text.muted}>
									 {'·'} {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
								</Text>
							) : null}
						</Box>
					)
				})}
			</Box>
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>
					Esc / ← older · → newer · PgUp/PgDn jump · Home/End boundary · enter fork and edit · q
					cancel
				</Text>
			</Box>
		</Box>
	)
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim() || '(empty text with attachments)'
}
