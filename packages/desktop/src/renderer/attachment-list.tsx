import { Dialog } from '@base-ui/react/dialog'
import type { AttachmentView } from '../shared/protocol.js'
import { FileTextIcon, XIcon } from './icons.js'
import { Button } from './ui/button.js'
import './attachment-list.css'

export function AttachmentList({
	attachments,
	onRemove,
	disabled = false,
}: {
	attachments: AttachmentView[]
	onRemove?: (id: string) => void
	disabled?: boolean
}) {
	if (attachments.length === 0) return null
	return (
		<ul
			className="attachment-list"
			aria-label={onRemove ? 'Attached files' : 'Message attachments'}
		>
			{attachments.map((attachment) => (
				<li key={attachment.id} className="attachment-item" data-attachment-id={attachment.id}>
					{attachment.kind === 'image' && attachment.preview ? (
						<Dialog.Root>
							<Dialog.Trigger
								className="attachment-image"
								aria-label={`Preview ${attachment.name}`}
							>
								<img src={attachment.preview} alt={attachment.name} />
							</Dialog.Trigger>
							<Dialog.Portal>
								<Dialog.Backdrop className="attachment-preview-backdrop" />
								<Dialog.Popup className="attachment-preview">
									<header>
										<Dialog.Title>{attachment.name}</Dialog.Title>
										<Dialog.Close
											render={<Button size="icon-sm" variant="ghost-muted" />}
											aria-label="Close image preview"
										>
											<XIcon />
										</Dialog.Close>
									</header>
									<img src={attachment.preview} alt={attachment.name} />
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
			))}
		</ul>
	)
}
