/**
 * `/resume` picker — a list of recent conversations in this folder (from
 * the SDK session store). Presentational; App owns ↑/↓/enter/esc and the
 * selected index.
 */

import { Box, Text } from 'ink'

import type { RecentConversation } from '../integrations/sessions/store.js'
import { selectionWindow } from './selection-window.js'
import { theme } from './theme.js'

export interface ResumePickerProps {
	readonly conversations: readonly RecentConversation[]
	readonly selected: number
}

export function ResumePicker({ conversations, selected }: ResumePickerProps) {
	const { start, items: visible } = selectionWindow(conversations, selected)
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.border.focus}
			paddingX={1}
		>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold>
					Resume a conversation
				</Text>
				<Text color={theme.text.muted}>
					{selected + 1}/{conversations.length}
				</Text>
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				{visible.map((c, visibleIndex) => {
					const index = start + visibleIndex
					return (
						<Box key={c.id}>
							<Box width={2} flexShrink={0}>
								<Text color={theme.accent.user}>{index === selected ? '›' : ' '}</Text>
							</Box>
							<Box flexGrow={1}>
								<Text
									color={index === selected ? theme.text.primary : theme.text.secondary}
									bold={index === selected}
									wrap="truncate-end"
								>
									{/*
									 * A named row is quoted; a derived one is not. The two
									 * carry different promises — a name keeps meaning what
									 * it meant, and an opening message stops describing a
									 * conversation as soon as the work moves on from it —
									 * and without the mark they are one column of text
									 * that reads as if every row were chosen.
									 */}
									{c.named ? `"${c.title}"` : c.title}
								</Text>
							</Box>
							<Text color={theme.text.muted}> {relativeTime(c.updatedAt)}</Text>
						</Box>
					)
				})}
			</Box>
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>
					↑↓ navigate · PgUp/PgDn jump · Home/End boundary · enter resume · esc cancel
				</Text>
			</Box>
		</Box>
	)
}

function relativeTime(iso: string): string {
	const then = Date.parse(iso)
	if (Number.isNaN(then)) return ''
	const mins = Math.round((Date.now() - then) / 60000)
	if (mins < 1) return 'just now'
	if (mins < 60) return `${mins}m ago`
	const hours = Math.round(mins / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.round(hours / 24)}d ago`
}
