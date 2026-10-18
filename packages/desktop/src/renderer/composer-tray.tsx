import { useEffect, useRef, useState } from 'react'
import { AttachmentList } from './attachment-list.js'
import type { PendingMessages, PendingRow } from './pending-messages.js'
import { TRAY_VISIBLE_ROWS } from './pending-messages.js'
import { Button } from './ui/button.js'
import './composer-tray.css'

export interface ComposerTrayActions {
	onSendNow: (id: string) => void
	/** Resolves once the new text is kept, or the attempt failed and said so. */
	onSave: (id: string, text: string) => Promise<void>
	onRemove: (id: string) => void
	/** The shell cannot stop a reply from here. */
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
		<textarea
			ref={ref}
			className="composer-tray-editor"
			aria-label="Edit waiting message"
			value={text}
			maxLength={50000}
			rows={Math.min(4, Math.max(1, text.split('\n').length))}
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
	)
}

/**
 * Messages typed while a reply runs, in a tray fused to the top of the composer. One row per message in
 * the order it will be used; a message the model already received is no longer here.
 */
export function ComposerTray({
	pending,
	actions,
	editing,
	onEditingChange,
}: {
	pending: PendingMessages
	actions: ComposerTrayActions
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
		<section className="composer-tray" aria-label="Messages waiting to be read" data-composer-tray>
			<p className="composer-tray-head" aria-live="polite">
				<span>{rows.length} waiting</span>
				{hold && <span className="composer-tray-hold">{hold}</span>}
			</p>
			<ol
				className="composer-tray-list"
				style={{ '--tray-rows': TRAY_VISIBLE_ROWS } as React.CSSProperties}
			>
				{rows.map((row, index) => (
					<li
						key={row.id}
						className="composer-tray-row"
						data-pending-message-id={row.id}
						data-pending-kind={row.kind}
						data-editing={editing === row.id || undefined}
					>
						<span className="composer-tray-order" aria-hidden="true">
							{index + 1}
						</span>
						<div className="composer-tray-body">
							{editing === row.id && row.editable ? (
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
								<p className="composer-tray-text">{row.text}</p>
							)}
							{row.attachments && <AttachmentList attachments={row.attachments} />}
							<span className="composer-tray-note">
								{editing === row.id
									? 'Enter saves · Shift+Enter adds a line · Esc cancels'
									: row.note}
							</span>
						</div>
						{!(editing === row.id && row.editable) && (
							<span className="composer-tray-actions">
								{actions.canSendNow && (
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
							</span>
						)}
					</li>
				))}
			</ol>
		</section>
	)
}
