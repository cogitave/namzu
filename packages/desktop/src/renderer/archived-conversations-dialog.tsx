import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import type { ConversationView, DesktopApi } from '../shared/protocol.js'
import { ArchiveRestoreIcon } from './file-panel/file-icons.js'
import { Button } from './ui/button.js'

type Load =
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ready'; rows: ConversationView[]; unreadable: number }

const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

// An unparseable date is the oldest, so one bad row cannot make the order undefined.
const stamp = (value: string) => Date.parse(value) || 0

/** A conversation's last-updated day, or nothing when the host sent a date that does not parse. */
export function archivedDate(updatedAt: string): string {
	const at = Date.parse(updatedAt)
	return Number.isFinite(at) ? dateLabel.format(at) : ''
}

/** Archived rows grouped by project, in the order the projects are given; newest first inside each. */
export function groupArchived(
	rows: readonly ConversationView[],
	projects: readonly { id: string; name: string }[],
): { projectId: string; name: string; rows: ConversationView[] }[] {
	return projects
		.map((project) => ({
			projectId: project.id,
			name: project.name,
			rows: rows
				.filter((row) => row.projectId === project.id)
				.sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt)),
		}))
		.filter((group) => group.rows.length > 0)
}

/** Every archived conversation of every project, grouped by project, each with a Restore button. */
export function ArchivedConversationsDialog({
	api,
	projects: shownProjects,
	onRestored,
	onClose,
	returnFocus,
}: {
	api: DesktopApi
	projects: readonly { id: string; name: string }[]
	onRestored: (view: ConversationView) => void
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
	// The list is read once, for the projects there were when the window opened.
	const [projects] = useState(shownProjects)
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
		Promise.allSettled(
			projects.map((project) =>
				list(project.id).then((rows) => rows.map((row) => ({ ...row, projectId: project.id }))),
			),
		).then((results) => {
			if (!current) return
			const rows = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
			const unreadable = results.filter((result) => result.status === 'rejected').length
			if (unreadable === results.length && results.length > 0) {
				const first = results.find((result) => result.status === 'rejected')
				const reason = first?.status === 'rejected' ? first.reason : undefined
				setLoad({
					status: 'error',
					message:
						reason instanceof Error ? reason.message : 'Archived conversations could not be read.',
				})
				return
			}
			setLoad({ status: 'ready', rows, unreadable })
		})
		return () => {
			current = false
		}
	}, [api, projects])
	const restore = async (row: ConversationView) => {
		if (restoring || !api.restoreConversation) return
		setRestoring(row.id)
		setError('')
		try {
			const view = await api.restoreConversation(row.id)
			onRestored(view)
			setLoad((value) =>
				value.status === 'ready'
					? { ...value, rows: value.rows.filter((item) => item.id !== row.id) }
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
							From every project. Restore one to bring it back.
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
								<p className="text-sm text-muted-foreground">Nothing is archived.</p>
							)}
							{load.status === 'ready' && load.unreadable > 0 && (
								<output className="mb-2 block text-sm text-muted-foreground">
									{load.unreadable === 1
										? 'One project could not be read, so its archive is missing here.'
										: `${load.unreadable} projects could not be read, so their archives are missing here.`}
								</output>
							)}
							{load.status === 'ready' &&
								groupArchived(load.rows, projects).map((group) => (
									<section
										key={group.projectId}
										aria-label={`${group.name} archive`}
										className="mb-3"
									>
										<h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
											{group.name}
										</h3>
										<ul className="grid gap-1" aria-label={`Archived in ${group.name}`}>
											{group.rows.map((row) => (
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
									</section>
								))}
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
