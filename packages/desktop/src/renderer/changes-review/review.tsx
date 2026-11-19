import type { AcpSessionUpdate } from '@namzu/sdk'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThreadState } from '../../shared/projection.js'
import type {
	ProjectChangesView,
	ProjectCompareReply,
	ProjectCompareRequest,
	ProjectDiffView,
} from '../../shared/protocol.js'
import { ListTreeIcon } from '../icons.js'
import { plainErrorText } from '../plain-error.js'
import { BaseMenu, type BranchesReply, type CommitsReply } from './base-menu.js'
import {
	type BaseContext,
	type BaseSource,
	type ChangesBase,
	DEFAULT_BASE,
	effectiveBase,
	sourceOf,
} from './base.js'
import { richDiffVerdict } from './diff-gate.js'
import type { DiffBody } from './diff-pane.js'
import { groupByKind } from './file-kind.js'
import { FileSection } from './file-section.js'
import { FlatFileList } from './flat-list.js'
import { GoToFile } from './go-to-file-popover.js'
import { ChangesHeaderSlot, publishChangesHeader } from './header-store.js'
import { createLimiter } from './limiter.js'
import {
	type ReviewFile,
	buildTree,
	conversationFiles,
	keyStep,
	receiptsOf,
	stepFile,
} from './model.js'
import {
	type ChangesDisplay,
	LIST_FIT_WIDTH,
	SPLIT_FIT_WIDTH,
	clampListWidth,
	listSide,
	loadDisplay,
	saveDisplay,
} from './settings.js'
import { ToolButton } from './tool-button.js'
import { ReviewTreeView } from './tree.js'
import { ViewMenu } from './view-menu.js'
import { type ViewedState, fingerprintOf, viewedState } from './viewed.js'
import './review.css'
import { viewState } from '../view-state.js'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>

/** What the Changes pane reads; supplied only for a trusted, ready project. */
export interface WorkingTreeSource {
	projectId: string
	/** The working tree against HEAD, through the host. */
	changes(): Promise<ProjectChangesView | null>
	diff(path: string): Promise<ProjectDiffView>
	/** Branches, commits, and changes against a branch's fork point or a commit. */
	compare?(request: ProjectCompareRequest): Promise<ProjectCompareReply | null>
}

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T }
type Remote =
	| { key: string; state: 'error'; message: string }
	| { key: string; state: 'ready'; view: ProjectChangesView | null }

const OPEN_ALL_UP_TO = 12
const OPEN_FIRST_OTHERWISE = 3
const LARGE_FILE_COUNT = 200
const READ_AT_ONCE = 3

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const SHORTCUT_GO = isMac ? '⌘P' : 'Ctrl+P'
const SHORTCUT_LIST = isMac ? '⌘⇧Y' : 'Ctrl+Shift+Y'

const keyOfBody = (viaKey: string, seq: string, path: string) => `${viaKey}:${seq}:${path}`
const failure = (error: unknown, context: string) => plainErrorText(error, context)
const storageKey = (scopeKey: string, base: string) => `namzu.changes.viewed.${scopeKey}.${base}`

function readMarks(key: string): Record<string, string> {
	try {
		const raw = viewState.getItem(key)
		const value = raw ? JSON.parse(raw) : {}
		if (!value || typeof value !== 'object') return {}
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string',
			),
		)
	} catch {
		return {}
	}
}
function writeMarks(key: string, marks: Record<string, string>) {
	try {
		viewState.setItem(key, JSON.stringify(marks))
	} catch {
		// A mark is a convenience; without storage it lasts for this window.
	}
}

export function ChangesReview({
	tools,
	timeline,
	dark,
	focus,
	source,
	refreshToken,
	scopeKey = 'default',
	projectRoot,
	onOpenFile,
	onOpenInEditor,
	onOpenWorkingFile,
	onOpenWorkingInEditor,
	onShowInFolder,
	onCopy,
}: {
	tools: Record<string, Tool>
	timeline?: ThreadState['timeline']
	dark: boolean
	/** The file to scroll to first; a new object scrolls to it again. */
	focus?: { path: string }
	source?: WorkingTreeSource
	/** Changes when a turn settles, so the working tree is read again. */
	refreshToken?: number
	/** What marks as viewed are kept under: the conversation. */
	scopeKey?: string
	projectRoot?: string
	onOpenFile?: (path: string) => void
	onOpenInEditor?: (path: string) => void
	/** Open a working-tree path directly: the host already vouched for it. */
	onOpenWorkingFile?: (path: string) => void
	onOpenWorkingInEditor?: (path: string) => void
	onShowInFolder?: (path: string) => void
	onCopy?: (text: string, done: string) => void
}) {
	const [display, setDisplayState] = useState<ChangesDisplay>(loadDisplay)
	const setDisplay = useCallback((patch: Partial<ChangesDisplay>) => {
		setDisplayState((value) => {
			const next = { ...value, ...patch }
			saveDisplay(next)
			return next
		})
	}, [])
	const [base, setBase] = useState<ChangesBase>(DEFAULT_BASE)
	const [version, setVersion] = useState(0)
	const [goOpen, setGoOpen] = useState(false)
	const root = useRef<HTMLDivElement>(null)
	const stack = useRef<HTMLDivElement>(null)

	// How much room the pane has decides what it can offer.
	const [width, setWidth] = useState(0)
	useEffect(() => {
		const el = root.current
		if (!el || typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect
			if (box) setWidth(Math.round(box.width))
		})
		observer.observe(el)
		return () => observer.disconnect()
	}, [])
	const listFits = width >= LIST_FIT_WIDTH
	const listShown = display.showFiles && listFits
	const stackWidth = width - (listShown ? display.listWidth : 0)
	const splitFits = stackWidth >= SPLIT_FIT_WIDTH

	// What the folder is: a repository, and which branch counts as the usual one.
	const [probe, setProbe] = useState<
		{ state: 'loading' } | { state: 'ready'; repository: boolean; branches: BranchesReply | null }
	>(source ? { state: 'loading' } : { state: 'ready', repository: false, branches: null })
	const [branches, setBranches] = useState<Load<BranchesReply>>({ state: 'loading' })
	const [commits, setCommits] = useState<Load<CommitsReply>>({ state: 'loading' })
	const loadBranches = useCallback(() => {
		if (!source?.compare) return Promise.resolve(null)
		return source.compare({ op: 'branches' }).then((reply) => {
			if (reply?.op === 'branches') {
				setBranches({ state: 'ready', value: reply })
				return reply
			}
			return null
		})
	}, [source])
	// biome-ignore lint/correctness/useExhaustiveDependencies: asked once per source.
	useEffect(() => {
		if (!source) {
			setProbe({ state: 'ready', repository: false, branches: null })
			return
		}
		let live = true
		const done = (repository: boolean, found: BranchesReply | null) =>
			live && setProbe({ state: 'ready', repository, branches: found })
		if (source.compare) {
			loadBranches().then(
				(reply) => done(reply !== null, reply),
				() => {
					setBranches({ state: 'error' })
					done(true, null)
				},
			)
		} else {
			source.changes().then(
				(view) => done(view !== null, null),
				() => done(true, null),
			)
		}
		return () => {
			live = false
		}
	}, [source])
	const context: BaseContext = {
		repository: probe.state === 'ready' ? probe.repository : true,
		defaultBranch: probe.state === 'ready' ? (probe.branches?.defaultBranch ?? null) : null,
	}
	const used = effectiveBase(base, context)
	const baseSource: BaseSource = sourceOf(base, context)
	// Hiding whitespace needs git's own comparison, so the host's read gives way to it.
	const canHideWhitespace = baseSource.via !== 'receipts' && Boolean(source?.compare)
	const via: BaseSource =
		baseSource.via === 'host' && display.hideWhitespace && source?.compare
			? { via: 'compare', base: { kind: 'head' } }
			: baseSource
	const hideWhitespace = display.hideWhitespace && canHideWhitespace
	const viaKey = `${JSON.stringify(via)}|${hideWhitespace}`

	// The changed files from git, for the base in effect.
	const [remote, setRemote] = useState<Remote>()
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new token or version asks again.
	useEffect(() => {
		if (!source || via.via === 'receipts' || probe.state !== 'ready') return
		let live = true
		const request =
			via.via === 'host'
				? source.changes()
				: (
						source.compare?.({ op: 'changes', base: via.base, hideWhitespace }) ??
						Promise.resolve(null)
					).then((reply) => (reply?.op === 'changes' ? reply : null))
		request.then(
			(view) => live && setRemote({ key: viaKey, state: 'ready', view }),
			(error) =>
				live &&
				setRemote({ key: viaKey, state: 'error', message: failure(error, 'read the changes') }),
		)
		return () => {
			live = false
		}
	}, [source, viaKey, probe.state, version, refreshToken])
	const remoteNow = remote?.key === viaKey ? remote : undefined

	// Receipts change on every streamed update; the merged files only when one finishes.
	const signature = receiptsOf(tools, timeline)
		.map((receipt) => receipt.id)
		.join('|')
	// biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the receipts.
	const receiptFiles = useMemo(
		() => (via.via === 'receipts' ? conversationFiles({ tools, timeline }) : []),
		[via.via, signature],
	)
	const files: ReviewFile[] = useMemo(() => {
		if (via.via === 'receipts') return receiptFiles
		return remoteNow?.state === 'ready' && remoteNow.view
			? remoteNow.view.files.map((file) => ({ ...file }))
			: []
	}, [via.via, receiptFiles, remoteNow])
	const loading = probe.state === 'loading' || (via.via !== 'receipts' && !remoteNow)
	const failed = remoteNow?.state === 'error' ? remoteNow.message : undefined

	// Display order: grouped by kind when asked; the stack and the list read the same order.
	const groups = useMemo(
		() => groupByKind(files, display.separateKinds),
		[files, display.separateKinds],
	)
	const ordered = useMemo(() => groups.flatMap((group) => group.files), [groups])
	const tree = useMemo(() => buildTree(ordered), [ordered])
	const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set())
	const expandedFolders = useMemo(
		() => tree.folders.filter((id) => !collapsedFolders.has(id)),
		[tree, collapsedFolders],
	)
	const [selected, setSelected] = useState<string>()

	// Which sections are open: the person's own choices over the default rule.
	const [overrides, setOverrides] = useState<{ key: string; open: Record<string, boolean> }>({
		key: viaKey,
		open: {},
	})
	const openMap = overrides.key === viaKey ? overrides.open : {}
	const defaultOpen = (index: number) =>
		ordered.length <= OPEN_ALL_UP_TO || index < OPEN_FIRST_OTHERWISE
	const isOpen = (file: ReviewFile, index: number) => openMap[file.path] ?? defaultOpen(index)
	const setOpen = (path: string, open: boolean) =>
		setOverrides({ key: viaKey, open: { ...openMap, [path]: open } })

	// The text of each file, read when its section comes near and is open.
	const [bodies, setBodies] = useState<Record<string, DiffBody>>({})
	const requested = useRef(new Set<string>())
	const limit = useMemo(() => createLimiter(READ_AT_ONCE), [])
	const seq = `${version}:${refreshToken ?? 0}`
	const bodyKey = (path: string) => keyOfBody(viaKey, seq, path)
	const request = useCallback(
		(file: ReviewFile) => {
			if (!source || via.via === 'receipts' || file.status === 'binary') return
			const key = keyOfBody(viaKey, seq, file.path)
			if (requested.current.has(key)) return
			requested.current.add(key)
			limit(() =>
				via.via === 'host'
					? source.diff(file.path)
					: (
							source.compare?.({ op: 'diff', base: via.base, path: file.path }) ??
							Promise.reject(new Error('Unavailable.'))
						).then((reply) => {
							if (reply?.op !== 'diff') throw new Error('Unavailable.')
							return reply
						}),
			).then(
				(view) => setBodies((all) => ({ ...all, [key]: { state: 'ready', ...view } })),
				(error) =>
					setBodies((all) => ({
						...all,
						[key]: { state: 'error', message: failure(error, 'read this file') },
					})),
			)
		},
		[source, via, viaKey, seq, limit],
	)
	const bodyOf = (file: ReviewFile): DiffBody => {
		if (via.via === 'receipts')
			return {
				state: 'ready',
				before: file.content?.before ?? '',
				after: file.content?.after ?? '',
				binary: false,
				truncated: false,
			}
		if (file.status === 'binary')
			return { state: 'ready', before: null, after: null, binary: true, truncated: false }
		return bodies[bodyKey(file.path)] ?? { state: 'loading' }
	}
	// A diff is too large to open all at once when any loaded file trips the rich-diff gate.
	const tooLargeToExpand =
		ordered.length > LARGE_FILE_COUNT ||
		ordered.some((file) => {
			const body = bodies[bodyKey(file.path)]
			return (
				body?.state === 'ready' &&
				!body.binary &&
				!richDiffVerdict({
					before: body.before,
					after: body.after,
					added: file.added,
					removed: file.removed,
				}).rich
			)
		})

	// Marks as viewed, kept on this machine by conversation and base.
	const marksKey = storageKey(scopeKey, viaKey)
	const [marksState, setMarksState] = useState<{ key: string; marks: Record<string, string> }>(
		() => ({
			key: marksKey,
			marks: readMarks(marksKey),
		}),
	)
	if (marksState.key !== marksKey) setMarksState({ key: marksKey, marks: readMarks(marksKey) })
	const marks = marksState.key === marksKey ? marksState.marks : {}
	const fingerprint = (file: ReviewFile) => {
		const body = bodyOf(file)
		return fingerprintOf(file, body.state === 'ready' ? body.after : undefined)
	}
	const viewedOf = (file: ReviewFile): ViewedState =>
		viewedState(marks[file.path], fingerprint(file))
	const toggleViewed = (file: ReviewFile) => {
		const next = { ...marks }
		if (viewedOf(file) === 'viewed') delete next[file.path]
		else next[file.path] = fingerprint(file)
		setMarksState({ key: marksKey, marks: next })
		writeMarks(marksKey, next)
	}

	// Jumping: open the section and bring it to the top of the stack.
	const [jump, setJump] = useState<{ path: string; n: number }>()
	const jumpTo = useCallback(
		(path: string) => {
			setSelected(path)
			setOverrides((all) => ({
				...all,
				open: { ...(all.key === viaKey ? all.open : {}), [path]: true },
				key: viaKey,
			}))
			setJump((previous) => ({ path, n: (previous?.n ?? 0) + 1 }))
		},
		[viaKey],
	)
	useLayoutEffect(() => {
		if (!jump) return
		const el = [
			...(stack.current?.querySelectorAll<HTMLElement>('[data-file-section]') ?? []),
		].find((node) => node.dataset.path === jump.path)
		if (!el || !stack.current) return
		stack.current.scrollTo({ top: el.offsetTop })
	}, [jump])

	// A click on a reply's change row names one file: open the pane there. The file may only be
	// in the wider list, so the base widens once before giving up.
	const [pending, setPending] = useState<string>()
	const [seenFocus, setSeenFocus] = useState(focus)
	if (seenFocus !== focus) {
		setSeenFocus(focus)
		if (focus) setPending(focus.path)
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list settles.
	useEffect(() => {
		if (!pending || loading) return
		if (files.some((file) => file.path === pending)) {
			jumpTo(pending)
			setPending(undefined)
		} else if (used !== 'conversation' && used.kind === 'uncommitted' && context.defaultBranch) {
			setBase({ kind: 'all' })
		} else {
			setPending(undefined)
		}
	}, [pending, loading, files, used, context.defaultBranch])

	const copy = (text: string, done: string) => onCopy?.(text, done)
	const fromWorking = via.via !== 'receipts'
	const actions = {
		onOpenFile: fromWorking && onOpenWorkingFile ? onOpenWorkingFile : onOpenFile,
		onOpenInEditor: fromWorking && onOpenWorkingInEditor ? onOpenWorkingInEditor : onOpenInEditor,
		onShowInFolder: fromWorking ? onShowInFolder : undefined,
		projectRoot,
		onCopy: copy,
	}

	const order = display.groupByFolder ? tree.order : ordered.map((file) => file.path)
	const onKeyDown = (event: React.KeyboardEvent) => {
		const target = event.target as HTMLElement
		const key = event.key.toLowerCase()
		if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'p') {
			event.preventDefault()
			setGoOpen(true)
			return
		}
		if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'y' && listFits) {
			event.preventDefault()
			setDisplay({ showFiles: !display.showFiles })
			return
		}
		// Menus render in a portal but their key events still bubble here through React.
		if (!event.currentTarget.contains(target) || target.closest('input, textarea, [role="menu"]'))
			return
		const step = keyStep(event)
		if (!step) return
		event.preventDefault()
		const next = stepFile(order, selected, step)
		if (next) jumpTo(next)
	}

	// Go to file opens from anywhere in this pane (a click on the diff's text leaves focus on the page
	// itself, so the pane's own handler never hears the chord) and from the conversation beside it,
	// unless the message box has a selection. A terminal keeps its own Ctrl+P.
	useEffect(() => {
		const onChord = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.shiftKey || event.altKey) return
			if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'p') return
			const target = event.target as HTMLElement | null
			if (!target || target.closest('.changes-review')) return // the pane's handler has it
			if (target.closest('.xterm, [role="menu"], [role="dialog"]')) return
			const inPage = target === document.body || target === document.documentElement
			if (!inPage && !target.closest('.chat-stage')) return
			if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
				if (target.selectionStart !== target.selectionEnd) return
			}
			event.preventDefault()
			setGoOpen(true)
		}
		document.addEventListener('keydown', onChord)
		return () => document.removeEventListener('keydown', onChord)
	}, [])

	// The header the pane draws: the base chip, then search, the file list and the "..." menu.
	const hasFiles = ordered.length > 0
	useLayoutEffect(() => {
		publishChangesHeader({
			title: (
				<BaseMenu
					base={base}
					context={context}
					branches={branches}
					commits={commits}
					onChoose={(next) => setBase(next)}
					onOpenCompare={() => {
						void loadBranches()?.catch(() => setBranches({ state: 'error' }))
						if (source?.compare)
							source.compare({ op: 'commits' }).then(
								(reply) =>
									setCommits(
										reply?.op === 'commits' ? { state: 'ready', value: reply } : { state: 'error' },
									),
								() => setCommits({ state: 'error' }),
							)
					}}
				/>
			),
			actions: (
				<>
					{hasFiles && (
						<GoToFile
							files={ordered}
							open={goOpen}
							onOpenChange={setGoOpen}
							onPick={jumpTo}
							shortcut={SHORTCUT_GO}
						/>
					)}
					{hasFiles && listFits && (
						<ToolButton
							label={display.showFiles ? 'Hide files' : 'Show files'}
							tooltip={`${display.showFiles ? 'Hide files' : 'Show files'} (${SHORTCUT_LIST})`}
							pressed={display.showFiles}
							className="pane-control"
							onClick={() => setDisplay({ showFiles: !display.showFiles })}
						>
							<ListTreeIcon />
						</ToolButton>
					)}
					<ViewMenu
						display={display}
						onDisplay={setDisplay}
						listFits={listFits}
						splitFits={splitFits}
						canHideWhitespace={canHideWhitespace}
						hasFiles={hasFiles}
						tooLargeToExpand={tooLargeToExpand}
						shortcut={SHORTCUT_LIST}
						onCollapseAll={() =>
							setOverrides({
								key: viaKey,
								open: Object.fromEntries(ordered.map((file) => [file.path, false])),
							})
						}
						onExpandAll={() =>
							setOverrides({
								key: viaKey,
								open: Object.fromEntries(ordered.map((file) => [file.path, true])),
							})
						}
						onRefresh={() => {
							requested.current.clear()
							setBodies({})
							setVersion((value) => value + 1)
						}}
					/>
				</>
			),
		})
	})
	useEffect(() => () => publishChangesHeader({ title: null, actions: null }), [])

	const dragList = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault()
		const el = event.currentTarget
		el.setPointerCapture(event.pointerId)
		const side = listSide(display.listPosition)
		const bounds = root.current?.getBoundingClientRect()
		if (!bounds) return
		const move = (e: PointerEvent) =>
			setDisplay({
				listWidth: clampListWidth(
					side === 'right' ? bounds.right - e.clientX : e.clientX - bounds.left,
				),
			})
		const stop = () => {
			el.removeEventListener('pointermove', move)
			el.removeEventListener('pointerup', stop)
			el.removeEventListener('pointercancel', stop)
		}
		el.addEventListener('pointermove', move)
		el.addEventListener('pointerup', stop)
		el.addEventListener('pointercancel', stop)
	}

	const empty = ordered.length === 0
	const emptyText = loading
		? 'Loading changes'
		: failed
			? 'Couldn’t load the changes'
			: used !== 'conversation' && used.kind === 'uncommitted'
				? 'No uncommitted changes'
				: 'No changes to show'
	const side = listSide(display.listPosition)
	return (
		<div
			ref={root}
			className="changes-review"
			data-list={listShown ? side : undefined}
			style={{ '--changes-list-width': `min(${display.listWidth}px, 38%)` } as React.CSSProperties}
			onKeyDown={onKeyDown}
		>
			{empty ? (
				<div className="changes-state" role={failed ? 'alert' : 'status'}>
					<p className="changes-state-title">{emptyText}</p>
					{failed && (
						<>
							<p className="changes-state-body">{failed}</p>
							<button
								type="button"
								className="changes-gate-button"
								onClick={() => setVersion((value) => value + 1)}
							>
								Try again
							</button>
						</>
					)}
				</div>
			) : (
				<>
					{remoteNow?.state === 'ready' && remoteNow.view?.truncated && (
						<p className="changes-note changes-cut-note">Only the first changed files are shown.</p>
					)}
					<div className="changes-body">
						<div className="changes-stack" ref={stack}>
							{groups.map((group) => (
								<div key={group.kind} className="changes-group">
									{group.heading && <h3 className="changes-group-heading">{group.heading}</h3>}
									{group.files.map((file) => {
										const index = ordered.indexOf(file)
										const open = isOpen(file, index)
										return (
											<FileSection
												key={file.path}
												file={file}
												body={open ? bodyOf(file) : undefined}
												open={open}
												viewed={viewedOf(file)}
												display={{
													split: display.sideBySide && splitFits,
													wrap: display.wordWrap,
													highlight: display.highlightWords,
												}}
												dark={dark}
												fullContext={via.via !== 'receipts'}
												actions={actions}
												onToggle={() => setOpen(file.path, !open)}
												onToggleViewed={
													via.via === 'receipts' ? undefined : () => toggleViewed(file)
												}
												onRead={() => request(file)}
											/>
										)
									})}
								</div>
							))}
						</div>
						{listShown && (
							<>
								<div
									className="changes-list-handle"
									role="separator"
									aria-orientation="vertical"
									aria-label="Resize file list"
									tabIndex={0}
									onPointerDown={dragList}
									onKeyDown={(event) => {
										const step =
											event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
										if (!step) return
										event.preventDefault()
										setDisplay({
											listWidth: clampListWidth(
												display.listWidth + (side === 'right' ? -step : step),
											),
										})
									}}
								/>
								<aside className="changes-files" aria-label="Changed files">
									{display.groupByFolder ? (
										<ReviewTreeView
											tree={tree}
											expanded={expandedFolders}
											onExpandedChange={(next) =>
												setCollapsedFolders(
													new Set(tree.folders.filter((id) => !next.includes(id))),
												)
											}
											selected={selected}
											onSelect={jumpTo}
										/>
									) : (
										<FlatFileList files={ordered} selected={selected} onSelect={jumpTo} />
									)}
								</aside>
							</>
						)}
					</div>
				</>
			)}
		</div>
	)
}

export { ChangesHeaderSlot }
