import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button.js'

/** The words of the dialog, apart from the component so they can be tested as data. */
export const RETRUST_OFF_COPY = {
	title: 'Stop asking when a folder’s automatic settings change?',
	description:
		'A project can run hooks, MCP servers and plugins from its own files. With this off, Namzu will not ask again when they change, and changes made meanwhile are accepted as they are when you turn it back on.',
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
}: {
	onConfirm: () => Promise<void>
	onCancel: () => void
	returnFocus?: () => HTMLElement | null
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
			if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
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
				<Dialog.Backdrop className="fixed inset-0 z-[160] bg-black/50" />
				<Dialog.Viewport className="fixed inset-0 z-[161] grid place-items-center overflow-y-auto p-4">
					<Dialog.Popup
						data-settings-confirm-dialog="retrust-off"
						initialFocus={cancel}
						finalFocus={returnFocus}
						className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none"
					>
						<Dialog.Title className="text-lg font-semibold">{RETRUST_OFF_COPY.title}</Dialog.Title>
						<Dialog.Description className="mt-3 text-sm text-muted-foreground">
							{RETRUST_OFF_COPY.description}
						</Dialog.Description>
						{error && (
							<p role="alert" className="mt-3 text-sm text-destructive-foreground">
								{error}
							</p>
						)}
						<div className="mt-5 flex justify-end gap-2">
							<Button
								ref={cancel}
								className="focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background"
								variant="outline"
								disabled={pending}
								onClick={onCancel}
							>
								{RETRUST_OFF_COPY.cancel}
							</Button>
							<Button
								variant="destructive"
								className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
								disabled={pending}
								onClick={() => void confirm()}
							>
								{RETRUST_OFF_COPY.confirm}
							</Button>
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
