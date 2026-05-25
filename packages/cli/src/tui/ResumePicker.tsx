/**
 * `/resume` picker — a list of recent conversations in this folder (from
 * the SDK session store). Presentational; App owns ↑/↓/enter/esc and the
 * selected index.
 */

import { Box, Text } from 'ink'

import type { RecentConversation } from '../integrations/sessions/store.js'
import { theme } from './theme.js'

export interface ResumePickerProps {
	readonly conversations: readonly RecentConversation[]
	readonly selected: number
}

export function ResumePicker({ conversations, selected }: ResumePickerProps) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.border.focus}
			paddingX={1}
		>
			<Text color={theme.accent.user} bold>
				Resume a conversation
			</Text>
			<Box flexDirection="column" paddingTop={1}>
				{conversations.map((c, i) => (
					<Box key={c.id}>
						<Box width={2} flexShrink={0}>
							<Text color={theme.accent.user}>{i === selected ? '›' : ' '}</Text>
						</Box>
						<Box flexGrow={1}>
							<Text
								color={i === selected ? theme.text.primary : theme.text.secondary}
								bold={i === selected}
								wrap="truncate-end"
							>
								{c.title}
							</Text>
						</Box>
						<Text color={theme.text.muted}> {relativeTime(c.updatedAt)}</Text>
					</Box>
				))}
			</Box>
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>↑↓ navigate · enter resume · esc cancel</Text>
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
