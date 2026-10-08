import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import type { BroadFolderKind } from '../shared/protocol.js'
import { Button } from './ui/button.js'

export interface FolderAccessCopy {
	title: string
	description: string
	/** What was found or what changed, one entry each, shown as a list under the description. */
	items?: string[]
	/** The closing caution, below the list. */
	note?: string
	confirm: string
	cancel: string
}

const BROAD_SUBJECT: Record<BroadFolderKind, string> = {
	drive: 'your whole drive',
	home: 'your whole home folder',
	system: 'a system folder',
}

/** The words of both variants, apart from the component so they can be tested as data. */
export function folderAccessCopy(
	name: string,
	broad?: BroadFolderKind,
	/** What main found in the folder that can run code on its own. */
	risky?: readonly string[],
	/** What changed in a folder this app had already trusted. */
	changed?: readonly string[],
): FolderAccessCopy {
	if (broad)
		return {
			title: `Allow access to ${BROAD_SUBJECT[broad]}?`,
			description: `This is ${BROAD_SUBJECT[broad]}. Namzu and the conversation engine could read every file under it and run commands there. Prefer a project folder.`,
			confirm: 'Allow anyway',
			cancel: 'Choose another folder',
		}
	if (changed && changed.length > 0)
		return {
			title: 'Trust this folder?',
			description: `These automatic settings of ${name} changed since you last trusted it:`,
			items: [...changed],
			note: 'Folder settings can run code automatically, even without a model request. Continue only if you trust these changes.',
			confirm: 'Trust folder',
			cancel: 'Cancel',
		}
	if (risky && risky.length > 0)
		return {
			title: 'Trust this folder?',
			description: `Namzu and your selected conversation engine can read, edit and run files in ${name}. Folder settings can also run code automatically, even without a model request. This folder has:`,
			items: [...risky],
			note: 'Continue only if you trust these files.',
			confirm: 'Trust folder',
			cancel: 'Cancel',
		}
	return {
		title: `Work in ${name}?`,
		description:
			'Allow Namzu and your selected conversation engine to read files and run commands in this folder. Each conversation keeps its own tool permissions. Only allow access to a folder you trust.',
		confirm: 'Allow folder access',
		cancel: 'Cancel',
	}
}

/**
 * The in-app folder consent. The caller owns what happens next: it resolves `onConfirm`
 * after trusting (or after learning the folder is broad and swapping the variant), and
 * `onCancel` for the secondary button. Failure leaves the choice visible.
 */
export function FolderAccessDialog({
	name,
	path,
	broad,
	risky,
	changed,
	onConfirm,
	onCancel,
	onClose,
	returnFocus,
}: {
	name: string
	path: string
	broad?: BroadFolderKind
	risky?: readonly string[]
	changed?: readonly string[]
	onConfirm: () => Promise<void>
	onCancel: () => void
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
	const copy = folderAccessCopy(name, broad, risky, changed)
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
				if (!open && !inFlight.current) onClose()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-[160] bg-black/50" />
				<Dialog.Viewport className="fixed inset-0 z-[161] grid place-items-center overflow-y-auto p-4">
					<Dialog.Popup
						data-folder-access-dialog={
							broad ?? (changed?.length ? 'changed' : risky?.length ? 'risky' : 'review')
						}
						initialFocus={cancel}
						finalFocus={returnFocus}
						className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none"
					>
						<Dialog.Title className="text-lg font-semibold">{copy.title}</Dialog.Title>
						<p className="mt-2 break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
							{path}
						</p>
						<Dialog.Description className="mt-3 text-sm text-muted-foreground">
							{copy.description}
						</Dialog.Description>
						{copy.items && (
							<ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
								{copy.items.map((item) => (
									<li key={item} className="break-words">
										{item}
									</li>
								))}
							</ul>
						)}
						{copy.note && <p className="mt-3 text-sm text-muted-foreground">{copy.note}</p>}
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
								{copy.cancel}
							</Button>
							<Button
								variant={broad ? 'destructive' : 'default'}
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
