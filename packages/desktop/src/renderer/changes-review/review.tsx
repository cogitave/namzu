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
	MoreHorizontalIcon,
	RefreshIcon,
	Rows3Icon,
	SearchIcon,
	TextWrapIcon,
} from '../icons.js'
import { type DiffBody, DiffPane } from './diff-pane.js'
import {
	type ReviewFile,
	type ReviewScope,
	buildTree,
	emptyMessageFor,
	filterFiles,
	keyStep,
	receiptsOf,
	scopeFiles,
	stepFile,
	totalsOf,
} from './model.js'
import { ToolButton } from './tool-button.js'
import { ReviewTreeView } from './tree.js'
import '../conversation-actions-menu.css'
import './review.css'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>

/** What the working-tree scope reads; supplied only for a trusted, ready project. */
export interface WorkingTreeSource {
	projectId: string
	changes(): Promise<ProjectChangesView | null>
	diff(path: string): Promise<ProjectDiffView>
}

const SCOPE_LABEL: Record<ReviewScope, string> = {
	reply: 'Last reply',
	conversation: 'This conversation',
	uncommitted: 'Uncommitted changes',
}
const MAX_FILES_NOTE = 'Only the first files are listed.'

type Remote =
	| { state: 'loading' }
	| { state: 'error'; message: string }
	| { state: 'ready'; view: ProjectChangesView | null }

const failure = (error: unknown, fallback: string) =>
	error instanceof Error && error.message ? error.message : fallback

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
}) {
	const replyKey = receiptIds?.join('|')
	const [scope, setScope] = useState<ReviewScope>(receiptIds ? 'reply' : 'conversation')
	// Coming from a reply's View changes shows that reply, whatever was open before.
	const [seenReply, setSeenReply] = useState(replyKey)
	if (seenReply !== replyKey) {
		setSeenReply(replyKey)
		if (replyKey) setScope('reply')
	}
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
					message: failure(error, 'The changes could not be read.'),
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
	const current =
		selected && visible.some((file) => file.path === selected) ? selected : tree.order[0]
	const file = visible.find((item) => item.path === current)
	const totals = totalsOf(files)

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
						message: failure(error, 'This file could not be read.'),
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
		choose(stepFile(tree.order, current, step))
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
				<Menu.Root>
					<Menu.Trigger className="changes-scope" aria-label="Which changes to show">
						<span>{SCOPE_LABEL[activeScope]}</span>
						<ChevronDownIcon aria-hidden="true" />
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner
							className="conversation-actions-positioner"
							align="start"
							sideOffset={6}
						>
							<Menu.Popup className="conversation-actions-popup" aria-label="Changes scope">
								<Menu.RadioGroup
									value={activeScope}
									onValueChange={(value) => {
										setScope(value as ReviewScope)
										if (value !== 'reply') onShowAll?.()
									}}
								>
									{scopes.map((item) => (
										<Menu.RadioItem
											key={item}
											value={item}
											closeOnClick
											className="conversation-actions-item"
										>
											<span className="conversation-actions-label">{SCOPE_LABEL[item]}</span>
											<Menu.RadioItemIndicator>
												<CheckIcon aria-hidden="true" />
											</Menu.RadioItemIndicator>
										</Menu.RadioItem>
									))}
								</Menu.RadioGroup>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
				<span className="changes-totals" aria-label="Total lines changed">
					<span className="changes-added">+{formatLineCount(totals.added)}</span>
					<span className="changes-removed">−{formatLineCount(totals.removed)}</span>
				</span>
				<div className="changes-toolbar" role="toolbar" aria-label="Changes view">
					<ToolButton
						label={split ? 'Use unified diff' : 'Use split diff'}
						pressed={split}
						onClick={() => setSplit(!split)}
					>
						{split ? <Columns2Icon /> : <Rows3Icon />}
					</ToolButton>
					<ToolButton label="Wrap diff lines" pressed={wrap} onClick={() => setWrap(!wrap)}>
						<TextWrapIcon />
					</ToolButton>
					{activeScope === 'uncommitted' && (
						<ToolButton label="Refresh changes" onClick={() => setVersion(version + 1)}>
							<RefreshIcon />
						</ToolButton>
					)}
					<ToolButton
						label="Collapse folders"
						disabled={tree.folders.length === 0}
						onClick={() => setCollapsed(new Set(tree.folders))}
					>
						<CollapseAllIcon />
					</ToolButton>
					<Menu.Root>
						<Menu.Trigger className="changes-icon-button" aria-label="More changes actions">
							<MoreHorizontalIcon aria-hidden="true" />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner
								className="conversation-actions-positioner"
								align="end"
								sideOffset={6}
							>
								<Menu.Popup className="conversation-actions-popup" aria-label="Changes actions">
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
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
				</div>
			</div>
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
