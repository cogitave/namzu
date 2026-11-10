import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import { plainErrorText } from './plain-error.js'
import { Button } from './ui/button.js'

/** The words of the dialog, apart from the component so they can be tested as data. */
export const RETRUST_OFF_COPY = {
	title: 'Stop asking when a project’s automatic settings change?',
	description:
		'Hooks, servers and plugins a project adds later will run without asking. Changes made while this is off are accepted when you turn it back on.',
	confirm: 'Turn off',
	cancel: 'Cancel',
} as const

/**
 * The in-app confirmation for lowering a safeguard. Cancel has focus when it opens; Turn off
 * resends the change with main's token and stays open, showing the reason, if main refuses.
 */
export function SettingsConfirmDialog({
	onConfirm,
	onCancel,
	returnFocus,
	copy = RETRUST_OFF_COPY,
}: {
	onConfirm: () => Promise<void>
	onCancel: () => void
	returnFocus?: () => HTMLElement | null
	/** The words of the dialog; the default is the one for turning off project re-trust. */
	copy?: { title: string; description: string; confirm: string; cancel: string }
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
		} catch (failure) {
			if (mounted.current) setError(plainErrorText(failure, 'save the setting'))
		} finally {
			inFlight.current = false
			if (mounted.current) setPending(false)
		}
	}
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !inFlight.current) onCancel()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-(--z-scrim) bg-black/50" />
				<Dialog.Viewport className="fixed inset-0 z-(--z-dialog) grid place-items-center overflow-y-auto p-4">
					<Dialog.Popup
						data-settings-confirm-dialog={copy === RETRUST_OFF_COPY ? 'retrust-off' : 'setting'}
						initialFocus={cancel}
						finalFocus={returnFocus}
						className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-[var(--shadow-dialog)] outline-none"
					>
						<Dialog.Title className="text-lg font-semibold">{copy.title}</Dialog.Title>
						<Dialog.Description className="mt-3 text-sm text-muted-foreground">
							{copy.description}
						</Dialog.Description>
						{error && (
							<p role="alert" className="mt-3 text-sm text-destructive-foreground">
								{error}
							</p>
						)}
						<div className="mt-5 flex justify-end gap-2">
							<Button
								ref={cancel}
								className="focus-visible:[box-shadow:var(--focus-ring)]!"
								variant="outline"
								disabled={pending}
								onClick={onCancel}
							>
								{copy.cancel}
							</Button>
							<Button
								variant="destructive"
								className="focus-visible:[box-shadow:var(--focus-ring)]!"
								disabled={pending}
								onClick={() => void confirm()}
							>
								{copy.confirm}
							</Button>
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
