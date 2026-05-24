/**
 * Conversation transcript. Each message renders as a single block with
 * a role glyph + colored label + content. A pending assistant message
 * shows a braille spinner that animates while `state === 'thinking'`.
 */

import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'

import { theme } from './theme.js'
import type { TranscriptMessage } from './types.js'

export interface TranscriptProps {
	readonly messages: readonly TranscriptMessage[]
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function Transcript({ messages, state }: TranscriptProps) {
	const spinner = useSpinner(state !== 'idle')

	if (messages.length === 0) {
		return (
			<Box flexDirection="column" paddingY={1}>
				<Text color={theme.text.muted}>
					Welcome to namzu. Type a message, or `/help` for commands.
				</Text>
			</Box>
		)
	}
	return (
		<Box flexDirection="column">
			{messages.map((m) => (
				<MessageBubble key={m.id} message={m} spinner={spinner} />
			))}
		</Box>
	)
}

function MessageBubble({
	message,
	spinner,
}: {
	readonly message: TranscriptMessage
	readonly spinner: string
}) {
	const glyph = glyphForRole(message.role)
	const color = colorForRole(message.role)
	const label = labelForRole(message.role)
	const prefix = message.pending ? `${spinner} ` : ''
	return (
		<Box flexDirection="column" paddingBottom={1}>
			<Box>
				<Text color={color} bold>
					{glyph} {label}
				</Text>
			</Box>
			<Box>
				<Text color={theme.text.primary}>
					{prefix}
					{message.content}
				</Text>
			</Box>
		</Box>
	)
}

function useSpinner(active: boolean): string {
	const [frame, setFrame] = useState<number>(0)
	useEffect(() => {
		if (!active) return
		const interval = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
		}, 80)
		return () => clearInterval(interval)
	}, [active])
	return SPINNER_FRAMES[frame] ?? '⠋'
}

function colorForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return theme.accent.user
		case 'assistant':
			return theme.accent.assistant
		case 'system':
			return theme.accent.system
		case 'tool':
			return theme.accent.tool
	}
}

function glyphForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return '▸'
		case 'assistant':
			return '◆'
		case 'system':
			return '⚠'
		case 'tool':
			return '⚙'
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
		case 'tool':
			return 'tool'
	}
}
