/**
 * Conversation transcript. Borderless and edge-to-edge: each message is a
 * two-column row — a fixed glyph gutter plus the content — so wrapped
 * lines hang-indent under the text and the role reads from the glyph +
 * color alone (no separate label line). A pending assistant message shows
 * a braille spinner in the gutter while the agent works.
 */

import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'

import { Markdown } from './Markdown.js'
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
					Type a message to begin · <Text color={theme.text.secondary}>/help</Text> for commands
				</Text>
			</Box>
		)
	}
	return (
		<Box flexDirection="column">
			{messages.map((m) => (
				<MessageRow key={m.id} message={m} spinner={spinner} />
			))}
		</Box>
	)
}

function MessageRow({
	message,
	spinner,
}: {
	readonly message: TranscriptMessage
	readonly spinner: string
}) {
	const glyph = message.pending ? spinner : (message.glyph ?? glyphForRole(message.role))
	return (
		<Box flexDirection="row" marginBottom={1}>
			<Box width={2} flexShrink={0}>
				<Text color={glyphColorForRole(message.role)} bold>
					{glyph}
				</Text>
			</Box>
			<Box flexGrow={1}>
				{message.role === 'assistant' && message.content.length > 0 ? (
					<Markdown text={message.content} color={contentColorForRole(message.role)} />
				) : (
					<Text color={contentColorForRole(message.role)} wrap="wrap">
						{message.content}
						{message.pending && message.content.length === 0 ? (
							<Text color={theme.text.muted}>…</Text>
						) : null}
					</Text>
				)}
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

function glyphForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return '>'
		case 'assistant':
			return '✦'
		case 'system':
			return '·'
		case 'tool':
			return '⚙'
	}
}

function glyphColorForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return theme.accent.user
		case 'assistant':
			return theme.accent.assistant
		case 'system':
			return theme.text.muted
		case 'tool':
			return theme.accent.tool
	}
}

function contentColorForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return theme.text.primary
		case 'assistant':
			return theme.text.primary
		case 'system':
			return theme.text.secondary
		case 'tool':
			return theme.text.secondary
	}
}
