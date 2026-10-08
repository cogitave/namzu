import { Dialog } from '@base-ui/react/dialog'
import { type RefObject, useRef } from 'react'
import type { UpdateState } from '../shared/update-protocol.js'
import { Button } from './ui/button.js'
import {
	type UpdateDialogAction,
	type UpdateDialogModel,
	updateDialogModel,
} from './update-model.js'
import './update-dialog.css'

const actionLabel: Record<UpdateDialogAction, string> = {
	download: 'Download',
	restart: 'Restart now',
	retry: 'Try again',
	later: 'Later',
	close: 'Close',
}

/** The installing dialog. Escape and the backdrop are inert while the installer takes over. */
export function UpdateDialog({
	state,
	onAction,
	onClose,
	returnFocus,
}: {
	state: UpdateState
	onAction: (action: UpdateDialogAction) => void
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
	const model = updateDialogModel(state)
	const primary = useRef<HTMLButtonElement>(null)
	if (!model) return null
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && model.dismissible) onClose()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="update-dialog-backdrop" />
				<Dialog.Viewport className="update-dialog-viewport">
					<Dialog.Popup
						data-update-dialog=""
						className="update-dialog"
						initialFocus={model.actions.length ? primary : undefined}
						finalFocus={returnFocus}
					>
						<UpdateDialogContent model={model} primary={primary} onAction={onAction} />
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

/** Everything inside the popup, apart from the portal, so it renders without a document. */
export function UpdateDialogContent({
	model,
	primary,
	onAction,
}: {
	model: UpdateDialogModel
	primary?: RefObject<HTMLButtonElement | null>
	onAction: (action: UpdateDialogAction) => void
}) {
	const progress = model.progress
	return (
		<>
			<Dialog.Title className="update-dialog-title">{model.title}</Dialog.Title>
			<Dialog.Description className="update-dialog-body">{model.body}</Dialog.Description>
			{model.reasons.length > 0 && (
				<ul className="update-dialog-reasons">
					{model.reasons.map((reason) => (
						<li key={reason}>{reason}</li>
					))}
				</ul>
			)}
			{progress && (
				<div className="update-dialog-progress">
					<progress
						className="update-dialog-bar"
						aria-label="Update progress"
						aria-valuetext={progress.text}
						max={100}
						value={progress.value ?? undefined}
					/>
					<output className="update-dialog-status" aria-live="polite">
						{progress.text}
					</output>
				</div>
			)}
			{model.actions.length > 0 && (
				<div className="update-dialog-actions">
					{model.actions.map((action, index) => (
						<Button
							key={action}
							ref={index === 0 ? primary : undefined}
							variant={index === 0 ? 'default' : 'outline'}
							onClick={() => onAction(action)}
						>
							{actionLabel[action]}
						</Button>
					))}
				</div>
			)}
		</>
	)
}
