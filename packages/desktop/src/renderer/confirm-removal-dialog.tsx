import { AlertDialog } from '@base-ui/react/alert-dialog'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button.js'

interface SideAction {
	label: string
	run: () => Promise<void>
}

/** The caller performs one confirmed operation; failure leaves the choice visible. */
export function ConfirmRemovalDialog({
	title,
	description,
	details,
	actionLabel,
	pendingLabel = 'Removing…',
	onConfirm,
	onClose,
	returnFocus,
	sideAction,
}: {
	title: string
	description: string
	/** One consequence per line, for a removal whose effects the person should read one by one. */
	details?: readonly (string | { text: string; title?: string })[]
	actionLabel: string
	pendingLabel?: string
	onConfirm: () => Promise<void>
	onClose: () => void
	returnFocus: () => HTMLElement | null
	/**
	 * An action that leaves the dialog open, for looking before deciding. A failure is shown in the
	 * dialog's own error line.
	 */
	sideAction?: SideAction | readonly SideAction[]
}) {
	const sideActions =
		sideAction === undefined ? [] : 'label' in sideAction ? [sideAction] : sideAction
	const [pending, setPending] = useState(false)
	const [error, setError] = useState('')
	const cancel = useRef<HTMLButtonElement>(null)
	const inFlight = useRef(false)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const confirm = async () => {
		if (inFlight.current) return
		inFlight.current = true
		setPending(true)
		setError('')
		try {
			await onConfirm()
			if (mounted.current) onClose()
		} catch (failure) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
		} finally {
			inFlight.current = false
			if (mounted.current) setPending(false)
		}
	}
	return (
		<AlertDialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !inFlight.current) onClose()
			}}
		>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop className="fixed inset-0 z-[160] bg-black/50" />
				<AlertDialog.Viewport className="fixed inset-0 z-[161] grid place-items-center overflow-y-auto p-4">
					<AlertDialog.Popup
						initialFocus={cancel}
						finalFocus={returnFocus}
						className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none"
					>
						<AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
						<AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
							{description}
						</AlertDialog.Description>
						{details && details.length > 0 && (
							<ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-foreground">
								{details.map((line) => {
									const { text, title } = typeof line === 'string' ? { text: line } : line
									return (
										<li key={text} title={title}>
											{text}
										</li>
									)
								})}
							</ul>
						)}
						{error && (
							<p role="alert" className="mt-3 text-sm text-destructive-foreground">
								{error}
							</p>
						)}
						<div className="mt-5 flex justify-end gap-2">
							{sideActions.map((action, index) => (
								<Button
									key={action.label}
									className={index === 0 ? 'mr-auto' : undefined}
									variant="ghost"
									disabled={pending}
									onClick={() => {
										setError('')
										action.run().catch((failure: unknown) => {
											if (mounted.current)
												setError(failure instanceof Error ? failure.message : String(failure))
										})
									}}
								>
									{action.label}
								</Button>
							))}
							<Button
								ref={cancel}
								className="focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background"
								variant="outline"
								disabled={pending}
								onClick={onClose}
							>
								Cancel
							</Button>
							<Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
								{pending ? pendingLabel : actionLabel}
							</Button>
						</div>
					</AlertDialog.Popup>
				</AlertDialog.Viewport>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	)
}
