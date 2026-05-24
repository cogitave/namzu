/**
 * Conversation transcript: scrolling log of user / assistant / system messages.
 *
 * M3 uses a flat <Box>; long sessions paginate via the terminal's own
 * scrollback. Virtualization (<Static> + pending split, à la gemini-cli)
 * lands when streaming becomes a real flicker problem — currently the SDK
 * emits coarser events than per-token deltas, so frame churn is low.
 */

import { Box, Text } from 'ink'

import { theme } from './theme.js'
import type { TranscriptMessage } from './types.js'

export interface TranscriptProps {
	readonly messages: readonly TranscriptMessage[]
}

export function Transcript({ messages }: TranscriptProps) {
	if (messages.length === 0) {
		return (
			<Box flexDirection="column" paddingBottom={1}>
				<Text color={theme.text.muted}>
					Welcome to namzu. Type a message, or `/help` for commands.
				</Text>
			</Box>
		)
	}
	return (
		<Box flexDirection="column">
			{messages.map((m) => (
				<MessageBubble key={m.id} message={m} />
			))}
		</Box>
	)
}

function MessageBubble({ message }: { message: TranscriptMessage }) {
	const color = colorForRole(message.role)
	const label = labelForRole(message.role)
	return (
		<Box flexDirection="column" paddingBottom={1}>
			<Text color={color} bold>
				{label}
			</Text>
			<Text color={theme.text.primary}>
				{message.content}
				{message.pending ? <Text color={theme.text.muted}> ▏</Text> : null}
			</Text>
		</Box>
	)
}

function colorForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return theme.accent.user
		case 'assistant':
			return theme.accent.assistant
		case 'system':
			return theme.accent.system
	}
}

function labelForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return 'you'
		case 'assistant':
			return 'namzu'
		case 'system':
			return 'system'
	}
}
