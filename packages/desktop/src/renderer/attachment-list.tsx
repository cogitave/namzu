import { Dialog } from '@base-ui/react/dialog'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AttachmentView } from '../shared/protocol.js'
import { FileTextIcon, XIcon } from './icons.js'
import { Button } from './ui/button.js'
import './attachment-list.css'

/**
 * Removing a chip unmounts the focused button, which would drop focus to the
 * body. Focus goes to the next chip, else the previous one, else the composer.
 */
export function neighbourAfterRemoval(
	attachments: readonly { id: string }[],
	id: string,
): string | undefined {
	const index = attachments.findIndex((attachment) => attachment.id === id)
	if (index < 0) return undefined
	return (attachments[index + 1] ?? attachments[index - 1])?.id
}

function AttachmentItem({
	attachment,
	onRemove,
	disabled,
}: {
	attachment: AttachmentView
	onRemove?: (id: string) => void
	disabled: boolean
}) {
	const row = useRef<HTMLLIElement>(null)
	const [open, setOpen] = useState(false)
	const unavailable = attachment.kind === 'image' && !attachment.preview
	useLayoutEffect(() => {
		if (!attachment.preview) setOpen(false)
	}, [attachment.preview])
	return (
		<li
			ref={row}
			className="attachment-item"
			data-attachment-id={attachment.id}
			tabIndex={unavailable ? -1 : undefined}
			aria-label={unavailable ? `${attachment.name}: Preview unavailable` : undefined}
		>
			{attachment.kind === 'image' ? (
				<Dialog.Root open={open && Boolean(attachment.preview)} onOpenChange={setOpen}>
					{attachment.preview ? (
						<Dialog.Trigger className="attachment-image" aria-label={`Preview ${attachment.name}`}>
							<img src={attachment.preview} alt={attachment.name} />
						</Dialog.Trigger>
					) : (
						<span className="attachment-file-icon">
							<FileTextIcon aria-hidden="true" />
						</span>
					)}
					<Dialog.Portal>
						<Dialog.Backdrop className="attachment-preview-backdrop" />
						<Dialog.Popup
							className="attachment-preview"
							finalFocus={() => {
								if (!row.current?.isConnected) return false
								return attachment.preview ? true : row.current
							}}
						>
							<header>
								<Dialog.Title>{attachment.name}</Dialog.Title>
								<Dialog.Close
									render={<Button size="icon-sm" variant="ghost-muted" />}
									aria-label="Close image preview"
								>
									<XIcon />
								</Dialog.Close>
							</header>
							{attachment.preview && <img src={attachment.preview} alt={attachment.name} />}
						</Dialog.Popup>
					</Dialog.Portal>
				</Dialog.Root>
			) : (
				<span className="attachment-file-icon">
					<FileTextIcon aria-hidden="true" />
				</span>
			)}
			<span className="attachment-name" title={attachment.name}>
				<span>{attachment.name}</span>
				<small>
					{attachment.kind === 'image' ? 'Image' : 'Text file'} ·{' '}
					{Math.max(1, Math.ceil(attachment.size / 1024))} KB
					{unavailable && ' · Preview unavailable'}
				</small>
			</span>
			{onRemove && (
				<Button
					variant="ghost-muted"
					size="icon-xs"
					className="attachment-remove"
					disabled={disabled}
					aria-label={`Remove ${attachment.name}`}
					onClick={() => onRemove(attachment.id)}
				>
					<XIcon />
				</Button>
			)}
		</li>
	)
}

export function AttachmentList({
	attachments,
	onRemove,
	disabled = false,
	fallbackFocus,
}: {
	attachments: AttachmentView[]
	onRemove?: (id: string) => void
	disabled?: boolean
	/** Where focus goes when the last chip is removed. */
	fallbackFocus?: RefObject<HTMLElement | null>
}) {
	const list = useRef<HTMLUListElement>(null)
	const pending = useRef<{
		removed: string
		target?: string
		sawDisabled: boolean
		waited: boolean
	}>(null)
	// Removal may disable every chip while it runs, which also drops focus; so the
	// handoff is asserted again once the list settles.
	useEffect(() => {
		const current = pending.current
		if (!current) return
		if (disabled) {
			current.sawDisabled = true
			return
		}
		if (!current.sawDisabled && attachments.some((item) => item.id === current.removed)) {
			// One render of grace; a removal that never lands must not steal focus later.
			if (current.waited) pending.current = null
			current.waited = true
			return
		}
		pending.current = null
		if (attachments.some((item) => item.id === current.removed)) return
		const next = current.target
			? list.current?.querySelector<HTMLElement>(
					`[data-attachment-id="${CSS.escape(current.target)}"] .attachment-remove`,
				)
			: undefined
		;(next ?? fallbackFocus?.current)?.focus()
	})
	if (attachments.length === 0) return null
	return (
		<ul
			ref={list}
			className="attachment-list"
			aria-label={onRemove ? 'Attached files' : 'Message attachments'}
		>
			{attachments.map((attachment) => (
				<AttachmentItem
					key={attachment.id}
					attachment={attachment}
					onRemove={
						onRemove &&
						((id) => {
							const target = neighbourAfterRemoval(attachments, id)
							pending.current = { removed: id, target, sawDisabled: false, waited: false }
							// Before removal, so focus never falls to the page while the chip unmounts.
							;(target
								? list.current?.querySelector<HTMLElement>(
										`[data-attachment-id="${CSS.escape(target)}"] .attachment-remove`,
									)
								: fallbackFocus?.current
							)?.focus()
							onRemove(id)
						})
					}
					disabled={disabled}
				/>
			))}
		</ul>
	)
}
