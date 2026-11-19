import { useEffect, useRef, useState } from 'react'
import { AttachmentList } from './attachment-list.js'
import { Message, MessageContent } from './message.js'
import type { PendingMessages, PendingRow } from './pending-messages.js'
import { UNCONFIRMED_NOTE, WAITING_NOTE } from './pending-messages.js'
import { Button } from './ui/button.js'
import './pending-tail.css'

export interface PendingActions {
	onSendNow: (id: string) => void
	/** Resolves once the new text is kept, or the attempt failed and said so. */
	onSave: (id: string, text: string) => Promise<void>
	onRemove: (id: string) => void
	/** The shell cannot take a waiting message in now from here. */
	canSendNow: boolean
	disabled?: boolean
}

function Editor({
	row,
	onSave,
	onCancel,
}: {
	row: PendingRow
	onSave: (text: string) => void
	onCancel: () => void
}) {
	const [text, setText] = useState(row.text)
	const ref = useRef<HTMLTextAreaElement>(null)
	useEffect(() => {
		const node = ref.current
		if (!node) return
		node.focus()
		node.setSelectionRange(node.value.length, node.value.length)
	}, [])
	return (
		<div className="pending-editor-wrap">
			<textarea
				ref={ref}
				className="pending-editor"
				aria-label="Edit waiting message"
				value={text}
				maxLength={50000}
				rows={Math.min(6, Math.max(1, text.split('\n').length))}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault()
						event.stopPropagation()
						onCancel()
					} else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault()
						if (text.trim()) onSave(text)
					}
				}}
			/>
			<span className="pending-note">Enter saves · Shift+Enter adds a line · Esc cancels</span>
		</div>
	)
}

/** The note says something the person has to know only when delivery is unsure or the message is parked. */
function showsNote(row: PendingRow): boolean {
	return row.note === UNCONFIRMED_NOTE || row.note === WAITING_NOTE
}

/**
 * Messages typed while a reply runs, at the end of the conversation where they will be read: a bubble
 * like any other message, with its actions under it, in the order they will be used. The working row
 * stays below. A message the model already received is no longer here; it is an ordinary bubble.
 */
export function PendingTail({
	pending,
	actions,
	editing,
	onEditingChange,
}: {
	pending: PendingMessages
	actions: PendingActions
	editing: string | null
	onEditingChange: (id: string | null) => void
}) {
	const { rows, hold } = pending
	// A message that left while it was being edited leaves its editor with it.
	useEffect(() => {
		if (editing !== null && !rows.some((row) => row.id === editing && row.editable))
			onEditingChange(null)
	}, [rows, editing, onEditingChange])
	if (rows.length === 0) return null
	return (
		<section className="pending-tail" aria-label="Messages waiting to be read" data-pending-tail>
			{rows.map((row) => {
				const editingRow = editing === row.id && row.editable
				const sendNow = actions.canSendNow && row.kind !== 'steer'
				// A message already going into the reply has nothing to press: no empty row under it.
				const actionRow = showsNote(row) || sendNow || row.editable
				return (
					<Message
						key={row.id}
						from="user"
						className="message user pending-message"
						title={row.note}
						data-pending-message-id={row.id}
						data-pending-kind={row.kind}
						data-editing={editingRow || undefined}
					>
						{row.attachments && (
							<AttachmentList attachments={row.attachments} layout="cards" delivering />
						)}
						{editingRow ? (
							<Editor
								row={row}
								onCancel={() => onEditingChange(null)}
								onSave={(text) => {
									const unchanged = text === row.text
									onEditingChange(null)
									if (!unchanged) void actions.onSave(row.id, text)
								}}
							/>
						) : (
							row.text.trim() && (
								<MessageContent className="message-bubble pending-bubble" text={row.text} />
							)
						)}
						{!editingRow && !actionRow && <span className="sr-only">{row.note}</span>}
						{!editingRow && actionRow && (
							<div className="pending-actions">
								<span className={showsNote(row) ? 'pending-note' : 'sr-only'}>{row.note}</span>
								{sendNow && (
									<Button
										variant="ghost-muted"
										size="xs"
										aria-label={`Send now: ${row.text.slice(0, 40)}`}
										disabled={actions.disabled}
										onClick={() => actions.onSendNow(row.id)}
									>
										Send now
									</Button>
								)}
								{row.editable && (
									<>
										<Button
											variant="ghost-muted"
											size="xs"
											aria-label={`Edit: ${row.text.slice(0, 40)}`}
											disabled={actions.disabled}
											onClick={() => onEditingChange(row.id)}
										>
											Edit
										</Button>
										<Button
											variant="ghost-muted"
											size="xs"
											aria-label={`Remove: ${row.text.slice(0, 40)}`}
											disabled={actions.disabled}
											onClick={() => actions.onRemove(row.id)}
										>
											Remove
										</Button>
									</>
								)}
							</div>
						)}
					</Message>
				)
			})}
			{hold && <p className="pending-hold">{hold}</p>}
		</section>
	)
}
