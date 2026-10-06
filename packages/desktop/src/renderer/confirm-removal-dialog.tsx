import { AlertDialog } from '@base-ui/react/alert-dialog'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button.js'

/** The caller performs one confirmed operation; failure leaves the choice visible. */
export function ConfirmRemovalDialog({
	title,
	description,
	actionLabel,
	onConfirm,
	onClose,
	returnFocus,
}: {
	title: string
	description: string
	actionLabel: string
	onConfirm: () => Promise<void>
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
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
						{error && (
							<p role="alert" className="mt-3 text-sm text-destructive-foreground">
								{error}
							</p>
						)}
						<div className="mt-5 flex justify-end gap-2">
							<Button ref={cancel} variant="outline" disabled={pending} onClick={onClose}>
								Cancel
							</Button>
							<Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
								{pending ? 'Removing…' : actionLabel}
							</Button>
						</div>
					</AlertDialog.Popup>
				</AlertDialog.Viewport>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	)
}
