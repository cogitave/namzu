import { Menu } from '@base-ui/react/menu'
import { useEffect, useRef, useState } from 'react'
import { formatLineCount } from '../changes-totals.js'
import { CodeIcon, ExternalLinkIcon, FileTypeIcon } from '../file-panel/file-icons.js'
import {
	ArrowUpRightIcon,
	ChevronDownIcon,
	CircleCheckIcon,
	CircleOutlineIcon,
	CopyIcon,
	FolderOpenIcon,
	MoreHorizontalIcon,
} from '../icons.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip.js'
import { type DiffBody, FileBody, patchOf } from './diff-pane.js'
import { filePathParts } from './file-path-parts.js'
import type { ReviewFile } from './model.js'
import { ToolButton } from './tool-button.js'
import type { ViewedState } from './viewed.js'

export interface FileActions {
	onOpenFile?: (path: string) => void
	onOpenInEditor?: (path: string) => void
	onShowInFolder?: (path: string) => void
	/** The project folder, for a path that starts at the filesystem root. */
	projectRoot?: string
	onCopy: (text: string, done: string) => void
}

/** The note after a file's name, and the tone it takes. */
export function fileNote(
	file: ReviewFile,
): { text: string; tone?: 'added' | 'removed' } | undefined {
	if (file.whitespaceOnly) return { text: 'Whitespace only' }
	if (file.status === 'added' || file.status === 'untracked')
		return { text: 'New file', tone: 'added' }
	if (file.status === 'deleted') return { text: 'Deleted file', tone: 'removed' }
	if (file.status === 'binary' || file.binary) return { text: 'Binary file' }
	if (file.status === 'renamed' && file.oldPath) return { text: `Renamed from ${file.oldPath}` }
	return undefined
}

const joinRoot = (root: string | undefined, path: string) => {
	if (!root) return path
	const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
	return `${root.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`
}

function FileMenu({
	file,
	body,
	actions,
}: { file: ReviewFile; body: DiffBody | undefined; actions: FileActions }) {
	const deleted = file.status === 'deleted'
	const { name } = filePathParts(file.path, actions.projectRoot)
	const copyDiff = () => {
		if (body?.state !== 'ready') return
		actions.onCopy(patchOf(file, body.before ?? '', body.after ?? ''), 'Diff copied.')
	}
	return (
		<Menu.Root>
			<Tooltip>
				<TooltipTrigger
					render={
						<Menu.Trigger className="changes-icon-button" aria-label={`More actions for ${name}`} />
					}
				>
					<MoreHorizontalIcon aria-hidden="true" />
				</TooltipTrigger>
				<TooltipPopup side="bottom">More actions</TooltipPopup>
			</Tooltip>
			<Menu.Portal>
				<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
					<Menu.Popup className="conversation-actions-popup" aria-label="File actions">
						{actions.onOpenInEditor && (
							<Menu.Item
								className="conversation-actions-item"
								disabled={deleted}
								onClick={() => actions.onOpenInEditor?.(file.path)}
							>
								<ExternalLinkIcon aria-hidden="true" />
								<span className="conversation-actions-label">Open in editor</span>
							</Menu.Item>
						)}
						{actions.onShowInFolder && (
							<Menu.Item
								className="conversation-actions-item"
								disabled={deleted}
								onClick={() => actions.onShowInFolder?.(file.path)}
							>
								<FolderOpenIcon aria-hidden="true" />
								<span className="conversation-actions-label">Show in file manager</span>
							</Menu.Item>
						)}
						{(actions.onOpenInEditor || actions.onShowInFolder) && (
							<Menu.Separator className="conversation-actions-separator" />
						)}
						<Menu.Item
							className="conversation-actions-item"
							onClick={() =>
								actions.onCopy(joinRoot(actions.projectRoot, file.path), 'Path copied.')
							}
						>
							<CopyIcon aria-hidden="true" />
							<span className="conversation-actions-label">Copy path</span>
						</Menu.Item>
						<Menu.Item
							className="conversation-actions-item"
							onClick={() => actions.onCopy(file.path, 'Relative path copied.')}
						>
							<CopyIcon aria-hidden="true" />
							<span className="conversation-actions-label">Copy relative path</span>
						</Menu.Item>
						<Menu.Item
							className="conversation-actions-item"
							onClick={() => actions.onCopy(name, 'File name copied.')}
						>
							<CopyIcon aria-hidden="true" />
							<span className="conversation-actions-label">Copy file name</span>
						</Menu.Item>
						<Menu.Item
							className="conversation-actions-item"
							disabled={body?.state !== 'ready' || body.binary}
							onClick={copyDiff}
						>
							<CodeIcon aria-hidden="true" />
							<span className="conversation-actions-label">Copy diff</span>
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

const VIEWED_TIP: Record<ViewedState, string> = {
	unviewed: 'Mark as viewed',
	viewed: 'Mark as not viewed',
	stale: 'Changed since you viewed it',
}

/** One changed file: its row, then its diff when the row is open. */
export function FileSection({
	file,
	body,
	open,
	viewed,
	display,
	dark,
	fullContext,
	actions,
	onToggle,
	onToggleViewed,
	onRead,
}: {
	file: ReviewFile
	body: DiffBody | undefined
	open: boolean
	viewed: ViewedState
	display: { split: boolean; wrap: boolean; highlight: boolean }
	dark: boolean
	fullContext: boolean
	actions: FileActions
	onToggle: () => void
	/** Absent where nothing is read from git, so there is nothing a later change could be told from. */
	onToggleViewed?: () => void
	/** The section is open and within reach of the scroll: its text may be read now. */
	onRead: () => void
}) {
	const ref = useRef<HTMLElement>(null)
	// The latest callback, so the observer is made once.
	const read = useRef(onRead)
	read.current = onRead
	const [reached, setReached] = useState(false)
	useEffect(() => {
		if (reached && open) read.current()
	}, [reached, open])
	useEffect(() => {
		const el = ref.current
		if (!el) return
		if (typeof IntersectionObserver === 'undefined') {
			setReached(true)
			return
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setReached(true)
					observer.disconnect()
				}
			},
			{ root: el.closest('.changes-stack'), rootMargin: '400px 0px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])
	const note = fileNote(file)
	const { name, folder } = filePathParts(file.path, actions.projectRoot)
	const counted = file.status !== 'binary' && !file.binary && (file.added > 0 || file.removed > 0)
	return (
		<section
			ref={ref}
			className="changes-file"
			data-file-section
			data-path={file.path}
			data-open={open || undefined}
			aria-label={`Changes to ${file.path}`}
		>
			<div className="changes-file-row">
				<button
					type="button"
					className="changes-file-toggle"
					aria-expanded={open}
					title={note ? `${file.path} (${note.text})` : file.path}
					onClick={onToggle}
				>
					<ChevronDownIcon
						className="changes-file-chevron"
						aria-hidden="true"
						data-open={open || undefined}
					/>
					<FileTypeIcon path={file.path} className="changes-file-icon" />
					{/* The tail of a path names the file, so the head is what gets cut. */}
					{folder && (
						<span className="changes-file-dir">
							<bdi>{folder}</bdi>
						</span>
					)}
					<span className="changes-file-name">{name}</span>
					{note && (
						<span className="changes-file-note" data-tone={note.tone}>
							{note.text}
						</span>
					)}
				</button>
				<span className="changes-file-actions">
					{counted && (
						<span className="changes-diff-counts">
							{file.added > 0 && (
								<span className="changes-added">+{formatLineCount(file.added)}</span>
							)}
							{file.removed > 0 && (
								<span className="changes-removed">−{formatLineCount(file.removed)}</span>
							)}
						</span>
					)}
					{onToggleViewed && (
						<ToolButton
							label={`${VIEWED_TIP[viewed]}: ${name}`}
							tooltip={VIEWED_TIP[viewed]}
							pressed={viewed === 'viewed'}
							className="changes-viewed"
							onClick={onToggleViewed}
						>
							{viewed === 'unviewed' ? (
								<CircleOutlineIcon data-state="unviewed" />
							) : (
								<CircleCheckIcon data-state={viewed} />
							)}
						</ToolButton>
					)}
					{actions.onOpenFile && (
						<ToolButton
							label={`Open file: ${name}`}
							tooltip={file.status === 'deleted' ? 'Deleted files can’t be opened.' : 'Open file'}
							disabled={file.status === 'deleted'}
							onClick={() => actions.onOpenFile?.(file.path)}
						>
							<ArrowUpRightIcon />
						</ToolButton>
					)}
					<FileMenu file={file} body={body} actions={actions} />
				</span>
			</div>
			{open && (
				<div className="changes-file-body">
					{body ? (
						<FileBody
							file={file}
							body={body}
							split={display.split}
							wrap={display.wrap}
							highlight={display.highlight}
							dark={dark}
							fullContext={fullContext}
						/>
					) : null}
				</div>
			)}
		</section>
	)
}
