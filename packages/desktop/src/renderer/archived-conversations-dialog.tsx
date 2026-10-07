import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import type { ConversationView, DesktopApi } from '../shared/protocol.js'
import { ArchiveRestoreIcon } from './file-panel/file-icons.js'
import { Button } from './ui/button.js'

type Load =
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ready'; rows: ConversationView[] }

const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

// An unparseable date is the oldest, so one bad row cannot make the order undefined.
const stamp = (value: string) => Date.parse(value) || 0

/** A conversation's last-updated day, or nothing when the host sent a date that does not parse. */
export function archivedDate(updatedAt: string): string {
	const at = Date.parse(updatedAt)
	return Number.isFinite(at) ? dateLabel.format(at) : ''
}

/** The project's archived conversations, newest first, each with a Restore button. */
export function ArchivedConversationsDialog({
	api,
	projectId,
	projectName,
	onRestored,
	onClose,
	returnFocus,
}: {
	api: DesktopApi
	projectId: string
	projectName: string
	onRestored: (view: ConversationView) => void
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
	const [load, setLoad] = useState<Load>({ status: 'loading' })
	const [restoring, setRestoring] = useState('')
	const [error, setError] = useState('')
	const close = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		let current = true
		const list = api.archivedConversations
		if (!list) {
			setLoad({ status: 'error', message: 'Archived conversations are not available here.' })
			return
		}
		list(projectId).then(
			(rows) =>
				current &&
				setLoad({
					status: 'ready',
					rows: [...rows].sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt)),
				}),
			(failure) =>
				current &&
				setLoad({
					status: 'error',
					message:
						failure instanceof Error
							? failure.message
							: 'Archived conversations could not be read.',
				}),
		)
		return () => {
			current = false
		}
	}, [api, projectId])
	const restore = async (row: ConversationView) => {
		if (restoring || !api.restoreConversation) return
		setRestoring(row.id)
		setError('')
		try {
			const view = await api.restoreConversation(row.id)
			onRestored(view)
			setLoad((value) =>
				value.status === 'ready'
					? { status: 'ready', rows: value.rows.filter((item) => item.id !== row.id) }
					: value,
			)
		} catch (failure) {
			setError(
				failure instanceof Error ? failure.message : 'This conversation could not be restored.',
			)
		} finally {
			setRestoring('')
		}
	}
	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-[160] bg-black/50" />
				<Dialog.Viewport className="fixed inset-0 z-[161] grid place-items-center overflow-y-auto p-4">
					<Dialog.Popup
						initialFocus={close}
						finalFocus={returnFocus}
						className="flex max-h-[min(34rem,90vh)] w-full max-w-md flex-col rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none"
					>
						<Dialog.Title className="text-lg font-semibold">Archived conversations</Dialog.Title>
						<Dialog.Description className="mt-1 text-sm text-muted-foreground">
							{projectName}
						</Dialog.Description>
						<div className="mt-4 min-h-0 flex-1 overflow-y-auto" aria-live="polite">
							{load.status === 'loading' && (
								<p className="text-sm text-muted-foreground">Looking for archived conversations…</p>
							)}
							{load.status === 'error' && (
								<p role="alert" className="text-sm text-destructive-foreground">
									{load.message}
								</p>
							)}
							{load.status === 'ready' && load.rows.length === 0 && (
								<p className="text-sm text-muted-foreground">
									Nothing is archived in this project.
								</p>
							)}
							{load.status === 'ready' && load.rows.length > 0 && (
								<ul className="grid gap-1" aria-label="Archived conversations">
									{load.rows.map((row) => (
										<li
											key={row.id}
											className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent"
										>
											<span className="min-w-0 flex-1">
												<span className="block truncate text-sm" title={row.title}>
													{row.title}
												</span>
												<span className="block text-xs text-muted-foreground">
													{archivedDate(row.updatedAt)}
												</span>
											</span>
											<Button
												type="button"
												size="xs"
												variant="outline"
												aria-label={`Restore ${row.title}`}
												disabled={restoring !== ''}
												onClick={() => void restore(row)}
											>
												<ArchiveRestoreIcon className="size-3.5" />
												{restoring === row.id ? 'Restoring…' : 'Restore'}
											</Button>
										</li>
									))}
								</ul>
							)}
						</div>
						{error && (
							<p role="alert" className="mt-3 text-sm text-destructive-foreground">
								{error}
							</p>
						)}
						<div className="mt-5 flex justify-end">
							<Button ref={close} type="button" variant="outline" onClick={onClose}>
								Close
							</Button>
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
