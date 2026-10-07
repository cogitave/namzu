import type { ReactNode } from 'react'
import { type ThreadState, threadPhase } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { AttachmentList } from './attachment-list.js'
import { Message, MessageContent, MessageFooter } from './message.js'
import { terminalNotice, transcriptTurns } from './transcript-layout.js'
import './pal-chat-transcript.css'

export interface PalChatRow {
	index: number
	message: ChatMessage
}

/** Delivery uses admitted event boundaries; private work stays in the unchanged projection. */
export function palChatRows(thread: ThreadState): PalChatRow[] {
	return transcriptTurns(thread).flatMap((turn) => {
		const finalMessageIds = new Set(
			[...turn.activity, ...turn.answer].flatMap((entry) => {
				const message = entry.kind === 'message' ? thread.messages[entry.index] : undefined
				return message?.role === 'assistant' &&
					message.phase === 'final_answer' &&
					message.messageId
					? [message.messageId]
					: []
			}),
		)
		const answer = turn.answer.flatMap((entry) => {
			if (entry.kind !== 'message') return []
			const message = thread.messages[entry.index]
			return message?.role === 'assistant' &&
				message.phase !== 'commentary' &&
				(message.phase === 'final_answer' ||
					!message.messageId ||
					!finalMessageIds.has(message.messageId)) &&
				message.stopReason !== 'tool_use' &&
				message.stopReason !== 'cancelled'
				? [{ index: entry.index, message }]
				: []
		})
		const result = thread.turns[turn.turn]?.result
		const settled =
			result !== undefined && answer.map((row) => row.message.text).join('\n\n') === result
		return [
			...turn.user.flatMap((entry) => {
				if (entry.kind !== 'message') return []
				const message = thread.messages[entry.index]
				return message ? [{ index: entry.index, message }] : []
			}),
			...answer.filter(
				({ message }) =>
					message.status === 'completed' ||
					settled ||
					(message.status === undefined && (turn.turn < thread.turn || !thread.running)),
			),
		].filter(
			({ message }) => message.text.trim().length > 0 || Boolean(message.attachments?.length),
		)
	})
}

export function palChatStatus(thread: ThreadState): string | undefined {
	const phase = threadPhase(thread)
	if (phase === 'idle') return undefined
	if (phase === 'waiting') return 'Waiting for your decision'
	return phase === 'thinking' || phase === 'responding' ? 'Typing…' : 'Working…'
}

/** Pal conversation messages are delivered chat bubbles, with concise live activity. */
export function PalChatTranscript({
	thread,
	name,
	intro,
	renderMessageAction,
}: {
	thread: ThreadState
	name: string
	intro?: { id: string; text: string }
	renderMessageAction?: (message: ChatMessage, key: string) => ReactNode
}) {
	const status = palChatStatus(thread)
	const notice = !thread.running
		? terminalNotice(thread.turns[thread.turn]?.reason ?? thread.stopReason)
		: undefined
	return (
		<div
			className="pal-chat-transcript"
			role="log"
			aria-label={`${name} messages`}
			aria-relevant="additions"
		>
			{intro && (
				<Message
					key={intro.id}
					from="assistant"
					className="pal-chat-message assistant"
					data-pal-chat-intro={intro.id}
				>
					<MessageContent className="pal-chat-bubble" text={intro.text} />
				</Message>
			)}
			{palChatRows(thread).map(({ message, index }) => (
				<Message
					key={`${index}:${message.messageId ?? ''}:${message.textPartId ?? ''}`}
					from={message.role}
					className={`pal-chat-message ${message.role}`}
					data-message-phase={message.phase}
				>
					<MessageContent
						className="pal-chat-bubble"
						text={message.text}
						markdown={message.role === 'assistant'}
					/>
					{message.attachments && message.attachments.length > 0 && (
						<div className="pal-chat-attachments">
							<AttachmentList attachments={message.attachments} />
						</div>
					)}
					<MessageFooter time={message.time} focusable>
						{message.role === 'assistant' &&
							(!thread.running ||
								thread.timeline.some(
									(entry) =>
										entry.kind === 'message' &&
										entry.index === index &&
										(entry.turn !== thread.turn ||
											thread.turns[entry.turn]?.stopReason !== undefined),
								)) &&
							renderMessageAction?.(
								message,
								`${index}:${message.messageId ?? ''}:${message.textPartId ?? ''}`,
							)}
					</MessageFooter>
				</Message>
			))}
			{status && (
				<output
					className="pal-chat-status"
					aria-live="polite"
					data-pal-chat-phase={threadPhase(thread)}
				>
					{status === 'Typing…' && (
						<span className="pal-chat-typing" aria-hidden="true">
							<span />
							<span />
							<span />
						</span>
					)}
					<span>{status}</span>
				</output>
			)}
			{notice && <p className="pal-chat-notice">{notice}</p>}
		</div>
	)
}
