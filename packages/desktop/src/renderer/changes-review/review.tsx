import { Menu } from '@base-ui/react/menu'
import type { AcpSessionUpdate } from '@namzu/sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ThreadState } from '../../shared/projection.js'
import type { ProjectChangesView, ProjectDiffView } from '../../shared/protocol.js'
import { formatLineCount } from '../changes-totals.js'
import {
	CheckIcon,
	ChevronDownIcon,
	CollapseAllIcon,
	Columns2Icon,
	CopyIcon,
	FilterIcon,
	Maximize2Icon,
	Minimize2Icon,
	RefreshIcon,
	Rows3Icon,
	SearchIcon,
	TextWrapIcon,
	XIcon,
} from '../icons.js'
import { type DiffBody, DiffPane } from './diff-pane.js'
import { FlatFileList } from './flat-list.js'
import {
	FLAT_LIST_LIMIT,
	type ReviewFile,
	type ReviewScope,
	buildTree,
	cutNoteFor,
	emptyMessageFor,
	filterFiles,
	keyStep,
	largestFile,
	receiptsOf,
	scopeFiles,
	stepFile,
	totalsOf,
} from './model.js'
import { ReviewTreeView } from './tree.js'
import '../conversation-actions-menu.css'
import './review.css'
import { plainErrorText } from '../plain-error.js'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>

/** What the working-tree scope reads; supplied only for a trusted, ready project. */
export interface WorkingTreeSource {
	projectId: string
	changes(): Promise<ProjectChangesView | null>
	diff(path: string): Promise<ProjectDiffView>
}

const SCOPE_LABEL: Record<ReviewScope, string> = {
	reply: 'This reply',
	conversation: 'All changes',
	uncommitted: 'Uncommitted changes',
}
const MAX_FILES_NOTE = 'Only the first files are listed.'

type Remote =
	| { state: 'loading' }
	| { state: 'error'; message: string }
	| { state: 'ready'; view: ProjectChangesView | null }

const failure = (error: unknown, context: string) => plainErrorText(error, context)

export function ChangesReview({
	tools,
	timeline,
	dark,
	receiptIds,
	focus,
	onShowAll,
	source,
	refreshToken,
	onOpenFile,
	onOpenInEditor,
	onOpenWorkingFile,
	onOpenWorkingInEditor,
	onCopy,
	onClose,
	expanded: paneExpanded,
	onToggleExpanded,
}: {
	tools: Record<string, Tool>
	timeline?: ThreadState['timeline']
	dark: boolean
	/** One reply's receipts, as when the person came from that reply's View changes. */
	receiptIds?: readonly string[]
	/** The file to select first; a new object selects it again. */
	focus?: { path: string }
	onShowAll?: () => void
	source?: WorkingTreeSource
	/** Changes when a turn settles, so the working tree is read again. */
	refreshToken?: number
	onOpenFile?: (path: string) => void
	onOpenInEditor?: (path: string) => void
	/** Open a working-tree path directly: the host already vouched for it. */
	onOpenWorkingFile?: (path: string) => void
	onOpenWorkingInEditor?: (path: string) => void
	onCopy?: (text: string, done: string) => void
	/** Closes the pane; the header's one close button. */
	onClose?: () => void
	/** The pane covers more of the window; the View menu offers the way back. */
	expanded?: boolean
	onToggleExpanded?: () => void
}) {
	const replyKey = receiptIds?.join('|')
	// All changes is where the pane opens; "This reply" is one click away, and a choice stays.
	const [scope, setScope] = useState<ReviewScope>('conversation')
	const [selected, setSelected] = useState<string | undefined>(focus?.path)
	const [seenFocus, setSeenFocus] = useState(focus)
	if (seenFocus !== focus) {
		setSeenFocus(focus)
		if (focus) setSelected(focus.path)
	}
	const [split, setSplit] = useState(false)
	const [wrap, setWrap] = useState(false)
	const [query, setQuery] = useState('')
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
	const [filesOpen, setFilesOpen] = useState(false)
	const [version, setVersion] = useState(0)

	// Working tree: read on mount to learn whether this is a repository, then on every refresh.
	const [remote, setRemote] = useState<Remote>({ state: 'loading' })
	const probed = useRef(false)
	const uncommittedOpen = scope === 'uncommitted'
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new token or version asks again.
	useEffect(() => {
		if (!source || (probed.current && !uncommittedOpen)) return
		probed.current = true
		let current = true
		source.changes().then(
			(view) => current && setRemote({ state: 'ready', view }),
			(error) =>
				current &&
				setRemote({
					state: 'error',
					message: failure(error, 'read the changes'),
				}),
		)
		return () => {
			current = false
		}
	}, [source, uncommittedOpen, version, refreshToken])
	const repository = !source || remote.state !== 'ready' || remote.view !== null
	const scopes: ReviewScope[] = [
		...(timeline || receiptIds ? (['reply'] as const) : []),
		'conversation',
		...(source && repository ? (['uncommitted'] as const) : []),
	]
	const activeScope = scopes.includes(scope) ? scope : 'conversation'

	// Receipts change on every streamed update; the merged files only when one finishes.
	const signature = receiptsOf(tools, timeline)
		.map((receipt) => receipt.id)
		.join('|')
	// biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the receipts.
	const receiptFiles = useMemo(
		() =>
			activeScope === 'uncommitted' ? [] : scopeFiles(activeScope, { tools, timeline, receiptIds }),
		[activeScope, signature, replyKey],
	)
	const files: ReviewFile[] = useMemo(() => {
		if (activeScope !== 'uncommitted') return receiptFiles
		return remote.state === 'ready' && remote.view
			? remote.view.files.map((file) => ({ ...file }))
			: []
	}, [activeScope, receiptFiles, remote])

	const visible = useMemo(() => filterFiles(files, query), [files, query])
	const tree = useMemo(() => buildTree(visible), [visible])
	const filtering = query.trim().length > 0
	const expanded = useMemo(
		() => (filtering ? tree.folders : tree.folders.filter((id) => !collapsed.has(id))),
		[filtering, tree, collapsed],
	)
	const flat = !filtering && visible.length <= FLAT_LIST_LIMIT
	const order = flat ? visible.map((item) => item.path) : tree.order
	// With nothing chosen the pane opens on the file that changed most, not the first one.
	const current =
		selected && visible.some((file) => file.path === selected)
			? selected
			: largestFile(visible)?.path
	const file = visible.find((item) => item.path === current)
	const totals = totalsOf(files)
	// The open file says its own cut beside its diff; the bar names only the others.
	const barCutNote = cutNoteFor(files, file?.path)

	const choose = (path: string | undefined) => {
		if (!path) return
		setSelected(path)
		setFilesOpen(false)
		// A folder closed earlier must not hide the file the keyboard just moved to.
		setCollapsed((all) => {
			const hidden = tree.folders.filter((id) => path.startsWith(`${id}/`) && all.has(id))
			if (hidden.length === 0) return all
			const next = new Set(all)
			for (const id of hidden) next.delete(id)
			return next
		})
	}

	// The text of the selected working-tree file, read when it is shown.
	const [loaded, setLoaded] = useState<{ key: string; body: DiffBody }>()
	const bodyKey = `${version}:${refreshToken ?? 0}:${file?.path}`
	// biome-ignore lint/correctness/useExhaustiveDependencies: bodyKey carries the refresh state.
	useEffect(() => {
		if (!source || activeScope !== 'uncommitted' || !file || file.status === 'binary') return
		let live = true
		source.diff(file.path).then(
			(view) => live && setLoaded({ key: bodyKey, body: { state: 'ready', ...view } }),
			(error) =>
				live &&
				setLoaded({
					key: bodyKey,
					body: {
						state: 'error',
						message: failure(error, 'read this file'),
					},
				}),
		)
		return () => {
			live = false
		}
	}, [source, activeScope, file?.path, bodyKey])
	const body: DiffBody | undefined = !file
		? undefined
		: activeScope !== 'uncommitted'
			? {
					state: 'ready',
					before: file.content?.before ?? '',
					after: file.content?.after ?? '',
					binary: false,
					truncated: false,
				}
			: file.status === 'binary'
				? {
						state: 'ready',
						before: null,
						after: null,
						binary: true,
						truncated: false,
					}
				: loaded?.key === bodyKey
					? loaded.body
					: { state: 'loading' }

	const copy = (text: string, done: string) => onCopy?.(text, done)
	const onKeyDown = (event: React.KeyboardEvent) => {
		const target = event.target as HTMLElement
		// Menus render in a portal but their key events still bubble here through React.
		if (!event.currentTarget.contains(target) || target.closest('input, textarea, [role="menu"]'))
			return
		const step = keyStep(event)
		if (!step) return
		event.preventDefault()
		choose(stepFile(order, current, step))
	}

	const empty = files.length === 0
	const remoteNote =
		activeScope === 'uncommitted' && remote.state === 'loading'
			? 'Reading the working tree…'
			: activeScope === 'uncommitted' && remote.state === 'error'
				? remote.message
				: undefined

	return (
		<div className="changes-review" onKeyDown={onKeyDown} data-scope={activeScope}>
			<div className="changes-bar">
				<h2 className="changes-title">Changes</h2>
				{/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own box and legend. */}
				<div className="changes-switch" role="group" aria-label="Which changes to show">
					{(['reply', 'conversation'] as const)
						.filter((item) => scopes.includes(item))
						.map((item) => (
							<button
								key={item}
								type="button"
								className="changes-switch-button"
								aria-pressed={activeScope === item}
								onClick={() => {
									setScope(item)
									if (item !== 'reply') onShowAll?.()
								}}
							>
								{SCOPE_LABEL[item]}
							</button>
						))}
				</div>
				<span className="changes-totals">
					<span className="changes-count-files">
						{formatLineCount(files.length)} {files.length === 1 ? 'file' : 'files'}
					</span>
					<span className="changes-added">
						<span className="sr-only">Added </span>+{formatLineCount(totals.added)}
					</span>
					<span className="changes-removed">
						<span className="sr-only">Removed </span>−{formatLineCount(totals.removed)}
					</span>
				</span>
				<div className="changes-controls">
					<Menu.Root>
						<Menu.Trigger className="changes-view" aria-label="View options">
							<span>View</span>
							<ChevronDownIcon aria-hidden="true" />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner
								className="conversation-actions-positioner"
								align="end"
								sideOffset={6}
							>
								<Menu.Popup className="conversation-actions-popup" aria-label="View">
									<Menu.RadioGroup
										value={split ? 'split' : 'unified'}
										onValueChange={(value) => setSplit(value === 'split')}
									>
										<Menu.RadioItem
											value="unified"
											className="conversation-actions-item"
											closeOnClick
										>
											<Rows3Icon aria-hidden="true" />
											<span className="conversation-actions-label">Unified diff</span>
											<Menu.RadioItemIndicator>
												<CheckIcon aria-hidden="true" />
											</Menu.RadioItemIndicator>
										</Menu.RadioItem>
										<Menu.RadioItem
											value="split"
											className="conversation-actions-item"
											closeOnClick
										>
											<Columns2Icon aria-hidden="true" />
											<span className="conversation-actions-label">Split diff</span>
											<Menu.RadioItemIndicator>
												<CheckIcon aria-hidden="true" />
											</Menu.RadioItemIndicator>
										</Menu.RadioItem>
									</Menu.RadioGroup>
									<Menu.CheckboxItem
										className="conversation-actions-item"
										checked={wrap}
										onCheckedChange={setWrap}
										closeOnClick
									>
										<TextWrapIcon aria-hidden="true" />
										<span className="conversation-actions-label">Wrap diff lines</span>
										<Menu.CheckboxItemIndicator>
											<CheckIcon aria-hidden="true" />
										</Menu.CheckboxItemIndicator>
									</Menu.CheckboxItem>
									<Menu.Item
										className="conversation-actions-item"
										disabled={tree.folders.length === 0}
										onClick={() => setCollapsed(new Set(tree.folders))}
									>
										<CollapseAllIcon aria-hidden="true" />
										<span className="conversation-actions-label">Collapse folders</span>
									</Menu.Item>
									<Menu.Separator className="conversation-actions-separator" />
									{scopes.includes('uncommitted') && (
										<Menu.CheckboxItem
											className="conversation-actions-item"
											checked={activeScope === 'uncommitted'}
											onCheckedChange={(on) => {
												setScope(on ? 'uncommitted' : 'conversation')
												onShowAll?.()
											}}
											closeOnClick
										>
											<span className="conversation-actions-label">Uncommitted changes (git)</span>
											<Menu.CheckboxItemIndicator>
												<CheckIcon aria-hidden="true" />
											</Menu.CheckboxItemIndicator>
										</Menu.CheckboxItem>
									)}
									{activeScope === 'uncommitted' && (
										<Menu.Item
											className="conversation-actions-item"
											onClick={() => setVersion(version + 1)}
										>
											<RefreshIcon aria-hidden="true" />
											<span className="conversation-actions-label">Refresh changes</span>
										</Menu.Item>
									)}
									<Menu.Item
										className="conversation-actions-item"
										disabled={empty}
										onClick={() =>
											copy(files.map((item) => item.path).join('\n'), 'Changed paths copied.')
										}
									>
										<CopyIcon aria-hidden="true" />
										<span className="conversation-actions-label">Copy changed paths</span>
									</Menu.Item>
									{onToggleExpanded && (
										<Menu.Item className="conversation-actions-item" onClick={onToggleExpanded}>
											{paneExpanded ? (
												<Minimize2Icon aria-hidden="true" />
											) : (
												<Maximize2Icon aria-hidden="true" />
											)}
											<span className="conversation-actions-label">
												{paneExpanded ? 'Restore pane size' : 'Expand pane'}
											</span>
										</Menu.Item>
									)}
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
					{onClose && (
						<button
							type="button"
							className="changes-icon-button changes-close"
							aria-label="Close changes"
							title="Close changes"
							onClick={onClose}
						>
							<XIcon aria-hidden="true" />
						</button>
					)}
				</div>
			</div>
			{!empty && barCutNote && <p className="changes-note changes-cut-note">{barCutNote}</p>}
			{empty ? (
				<p
					className="changes-message changes-empty"
					role={remote.state === 'error' ? 'alert' : undefined}
				>
					{remoteNote ?? emptyMessageFor(activeScope, repository)}
				</p>
			) : (
				<div className="changes-body" data-files-open={filesOpen}>
					<aside className="changes-files" aria-label="Changed files">
						{flat ? (
							<FlatFileList files={visible} selected={current} onSelect={choose} />
						) : (
							<>
								<label className="changes-filter">
									<SearchIcon aria-hidden="true" />
									<input
										type="text"
										value={query}
										placeholder="Filter files…"
										aria-label="Filter changed files"
										spellCheck={false}
										autoComplete="off"
										onChange={(event) => setQuery(event.target.value)}
										onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
									/>
									<FilterIcon aria-hidden="true" className="changes-filter-icon" />
								</label>
								{visible.length === 0 ? (
									<p className="changes-message">No changed files match.</p>
								) : (
									<ReviewTreeView
										tree={tree}
										expanded={expanded}
										onExpandedChange={(next) => {
											if (filtering) return
											setCollapsed(new Set(tree.folders.filter((id) => !next.includes(id))))
										}}
										selected={current}
										onSelect={choose}
									/>
								)}
							</>
						)}
						{activeScope === 'uncommitted' &&
							remote.state === 'ready' &&
							remote.view?.truncated && <p className="changes-note">{MAX_FILES_NOTE}</p>}
					</aside>
					<button
						type="button"
						className="changes-files-toggle"
						aria-expanded={filesOpen}
						onClick={() => setFilesOpen(!filesOpen)}
					>
						{filesOpen ? 'Hide files' : `Files (${formatLineCount(visible.length)})`}
					</button>
					{file && body ? (
						<DiffPane
							file={file}
							body={body}
							split={split}
							wrap={wrap}
							dark={dark}
							fullContext={activeScope === 'uncommitted'}
							actions={{
								onOpenFile:
									activeScope === 'uncommitted' && onOpenWorkingFile
										? onOpenWorkingFile
										: onOpenFile,
								onOpenInEditor:
									activeScope === 'uncommitted' && onOpenWorkingInEditor
										? onOpenWorkingInEditor
										: onOpenInEditor,
								onCopy: copy,
							}}
						/>
					) : (
						<p className="changes-message">Choose a file to see its changes.</p>
					)}
				</div>
			)}
		</div>
	)
}
