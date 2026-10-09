import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button.js'

/** Longest title the field accepts; longer ones would not fit a tab or a sidebar row anyway. */
export const MAX_TITLE_LENGTH = 200

/** An empty title is allowed and asks the host to restore the automatic one. */
export function RenameConversationDialog({
	initialTitle,
	onSave,
	onClose,
	returnFocus,
	heading = 'Rename conversation',
	description = 'Leave the name empty to use the automatic title.',
	fieldLabel = 'Conversation name',
	maxLength = MAX_TITLE_LENGTH,
}: {
	/** Words for another kind of rename (a project); the defaults are the conversation's. */
	heading?: string
	description?: string
	fieldLabel?: string
	maxLength?: number
	initialTitle: string
	onSave: (title: string) => Promise<void>
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
	const [value, setValue] = useState(initialTitle)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState('')
	const field = useRef<HTMLInputElement>(null)
	const inFlight = useRef(false)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const save = async () => {
		if (inFlight.current) return
		inFlight.current = true
		setPending(true)
		setError('')
		try {
			await onSave(value.trim())
			if (mounted.current) onClose()
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
				if (!open && !inFlight.current) onClose()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-[160] bg-black/50" />
				<Dialog.Viewport className="fixed inset-0 z-[161] grid place-items-center overflow-y-auto p-4">
					<Dialog.Popup
						initialFocus={field}
						finalFocus={returnFocus}
						className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none"
					>
						<form
							onSubmit={(event) => {
								event.preventDefault()
								void save()
							}}
						>
							<Dialog.Title className="text-lg font-semibold">{heading}</Dialog.Title>
							<Dialog.Description className="mt-2 text-sm text-muted-foreground">
								{description}
							</Dialog.Description>
							<input
								ref={field}
								type="text"
								aria-label={fieldLabel}
								className="mt-4 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
								value={value}
								maxLength={maxLength}
								disabled={pending}
								autoComplete="off"
								spellCheck={false}
								onFocus={(event) => event.currentTarget.select()}
								onChange={(event) => setValue(event.target.value)}
							/>
							{error && (
								<p role="alert" className="mt-3 text-sm text-destructive-foreground">
									{error}
								</p>
							)}
							<div className="mt-5 flex justify-end gap-2">
								<Button type="button" variant="outline" disabled={pending} onClick={onClose}>
									Cancel
								</Button>
								<Button type="submit" disabled={pending}>
									{pending ? 'Saving…' : 'Save'}
								</Button>
							</div>
						</form>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
