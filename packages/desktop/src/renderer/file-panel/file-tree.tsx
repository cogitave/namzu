import { asyncDataLoaderFeature, hotkeysCoreFeature } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopApi, ProjectFileEntry } from '../../shared/protocol.js'
import { ChevronRightIcon, SearchIcon } from '../icons.js'
import { FileIcon } from './file-icons.js'
import { type FileHit, directoryOf, prepareIndex, searchFiles } from './file-search.js'
import { baseNameOf, isMarkdownPath, parentOf } from './project-refs.js'

const ROW_HEIGHT = 28
const INDENT = 14
const RESULTS_ID = 'file-filter-results'

/** Folders to open, outermost first, so a file deep in the project shows in the tree. */
export function ancestorsOf(path: string): string[] {
	const parts = path.split('/')
	parts.pop()
	return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

function FileBadge({ path }: { path: string }) {
	return isMarkdownPath(path) ? (
		<span className="file-tree-badge" aria-hidden="true">
			M↓
		</span>
	) : (
		<FileIcon className="file-tree-file-icon" />
	)
}

function Highlighted({ hit }: { hit: FileHit }) {
	let offset = 0
	return (
		<>
			{hit.segments.map((segment) => {
				const key = offset
				offset += segment.text.length
				return segment.match ? (
					<mark key={key}>{segment.text}</mark>
				) : (
					<span key={key}>{segment.text}</span>
				)
			})}
		</>
	)
}

/** Results of the filter: best match first, the folder dimmed beside the name. */
function FilterResults({
	hits,
	active,
	onOpen,
	selected,
}: {
	hits: FileHit[]
	active?: string
	selected: number
	onOpen: (path: string) => void
}) {
	if (hits.length === 0) return <p className="file-tree-empty">No files match.</p>
	return (
		// biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive lint/a11y/noNoninteractiveElementToInteractiveRole: the combobox keeps focus in the filter and points at options with aria-activedescendant.
		<ul id={RESULTS_ID} className="file-tree-results" role="listbox" aria-label="Matching files">
			{hits.map((hit, index) => (
				<li key={hit.path} role="presentation">
					<button
						type="button"
						id={`${RESULTS_ID}-${index}`}
						// biome-ignore lint/a11y/useSemanticElements: a button row cannot be a native option.
						role="option"
						aria-selected={index === selected}
						// Focus stays in the filter; the arrow keys move the selection.
						tabIndex={-1}
						className="file-tree-row"
						data-active={hit.path === active || undefined}
						data-selected={index === selected || undefined}
						title={hit.path}
						onClick={() => onOpen(hit.path)}
					>
						<FileBadge path={hit.path} />
						<span className="file-tree-name">
							<Highlighted hit={hit} />
						</span>
						<span className="file-tree-dir">{directoryOf(hit.path)}</span>
					</button>
				</li>
			))}
		</ul>
	)
}

/** Asks the tree to open the folders above `path` (and `path` itself for a folder). */
export interface TreeReveal {
	path: string
	folder: boolean
	/** A new token repeats a reveal of the same path. */
	token: string
}

function Tree({
	api,
	projectId,
	activePath,
	reveal,
	onOpen,
	refreshToken,
}: {
	api: DesktopApi
	projectId: string
	activePath?: string
	reveal?: TreeReveal
	onOpen: (path: string) => void
	refreshToken?: number
}) {
	const entries = useRef(new Map<string, ProjectFileEntry>())
	const scroller = useRef<HTMLDivElement>(null)
	const virtualizer = useRef<{ scrollToIndex(index: number): void } | null>(null)
	const [error, setError] = useState('')
	const open = useRef(onOpen)
	open.current = onOpen
	const tree = useTree<ProjectFileEntry>({
		rootItemId: '',
		indent: INDENT,
		getItemName: (item) => item.getItemData().name,
		isItemFolder: (item) => item.getItemData().kind === 'directory',
		onPrimaryAction: (item) => {
			const data = item.getItemData()
			if (data.kind === 'file') open.current(data.path)
		},
		scrollToItem: (item) => virtualizer.current?.scrollToIndex(item.getItemMeta().index),
		// A row needs its entry as soon as it exists, so each listing ships the entries with the ids.
		createLoadingItemData: () => ({ name: '', path: '', kind: 'file' as const }),
		dataLoader: {
			getItem: (id) =>
				entries.current.get(id) ?? { name: baseNameOf(id), path: id, kind: 'directory' as const },
			getChildrenWithData: async (id) => {
				try {
					const list = (await api.listProjectDirectory?.(projectId, id)) ?? []
					for (const entry of list) entries.current.set(entry.path, entry)
					setError('')
					return list.map((entry) => ({ id: entry.path, data: entry }))
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : 'This folder could not be read.')
					return []
				}
			},
		},
		features: [asyncDataLoaderFeature, hotkeysCoreFeature],
	})
	const items = tree.getItems()
	const rows = useVirtualizer({
		count: items.length,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 10,
	})
	virtualizer.current = rows

	// New files from the agent: every listing the tree holds is read again, open folders first.
	const refreshed = useRef(refreshToken)
	useEffect(() => {
		if (refreshed.current === refreshToken) return
		refreshed.current = refreshToken
		for (const item of tree.getItems())
			if (item.isFolder() && item.isExpanded()) item.invalidateChildrenIds(true)
		tree.getItemInstance('').invalidateChildrenIds(true)
	}, [refreshToken, tree])

	// Reveal: open each folder above the target, then bring it into view once its row exists.
	const revealed = useRef<string | undefined>(undefined)
	const [revealTick, setRevealTick] = useState(0)
	useEffect(() => {
		if (!reveal || revealed.current === reveal.token) return
		revealed.current = reveal.token
		let current = true
		void (async () => {
			const folders = [...ancestorsOf(reveal.path), ...(reveal.folder ? [reveal.path] : [])]
			for (const folder of folders) {
				if (!current) return
				await tree.loadChildrenIds(parentOf(folder))
				tree.getItemInstance(folder).expand()
			}
			await tree.loadChildrenIds(parentOf(reveal.path))
			if (current) setRevealTick((value) => value + 1)
		})()
		return () => {
			current = false
			// A reveal cut short by a newer one must not block the same token later.
			revealed.current = undefined
		}
	}, [reveal, tree])
	// biome-ignore lint/correctness/useExhaustiveDependencies: rows and items change as folders load.
	useEffect(() => {
		if (!reveal) return
		const index = items.findIndex((item) => item.getId() === reveal.path)
		if (index >= 0) rows.scrollToIndex(index, { align: 'auto' })
	}, [revealTick, reveal, items.length])

	return (
		<div ref={scroller} className="file-tree-scroll">
			{error && (
				<p className="file-tree-empty" role="alert">
					{error}
				</p>
			)}
			<div
				{...tree.getContainerProps('Project files')}
				className="file-tree"
				style={{ height: rows.getTotalSize() }}
			>
				{rows.getVirtualItems().map((row) => {
					const item = items[row.index]
					if (!item) return null
					const data = item.getItemData()
					const folder = item.isFolder()
					return (
						<button
							{...item.getProps()}
							key={item.getId()}
							type="button"
							className="file-tree-row"
							data-folder={folder || undefined}
							data-active={(!folder && item.getId() === activePath) || undefined}
							data-focused={item.isFocused() || undefined}
							title={data.path}
							style={{
								position: 'absolute',
								top: 0,
								left: 0,
								width: '100%',
								height: ROW_HEIGHT,
								transform: `translateY(${row.start}px)`,
								paddingInlineStart: 8 + item.getItemMeta().level * INDENT,
							}}
						>
							{folder ? (
								<ChevronRightIcon
									className="file-tree-chevron"
									data-open={item.isExpanded() || undefined}
								/>
							) : (
								<FileBadge path={data.path} />
							)}
							<span className="file-tree-name">{data.name}</span>
						</button>
					)
				})}
			</div>
		</div>
	)
}

/** "Filter files…" over the project index, above a lazy, virtualised folder tree. */
export function FileTree({
	api,
	projectId,
	activePath,
	focusFilter,
	reveal,
	onOpen,
	refreshToken,
}: {
	refreshToken?: number
	api: DesktopApi
	projectId: string
	activePath?: string
	reveal?: TreeReveal
	/** Changes when the filter should take focus, as when "+" opens quick open. */
	focusFilter?: number
	onOpen: (path: string) => void
}) {
	const [query, setQuery] = useState('')
	const [index, setIndex] = useState<{ paths: string[]; truncated: boolean } | 'failed'>()
	const [selected, setSelected] = useState(0)
	const input = useRef<HTMLInputElement>(null)
	// The whole-project listing is a walk of the repository, so it waits for the first query.
	const [wantIndex, setWantIndex] = useState(false)
	if (!wantIndex && query.trim().length > 0) setWantIndex(true)
	useEffect(() => {
		if (!wantIndex) return
		let current = true
		setIndex(undefined)
		const list = api.projectFileIndex
		if (!list) {
			setIndex('failed')
			return
		}
		list(projectId)
			.then((value) => current && setIndex(value))
			.catch(() => current && setIndex('failed'))
		return () => {
			current = false
		}
	}, [api, projectId, wantIndex])
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new token asks for focus.
	useEffect(() => {
		if (!focusFilter) return
		input.current?.focus()
		// Typing over what is there beats appending to an old query.
		input.current?.select()
	}, [focusFilter])
	const prepared = useMemo(
		() => (index && index !== 'failed' ? prepareIndex(index.paths) : null),
		[index],
	)
	const hits = useMemo(
		() => (prepared && query.trim() ? searchFiles(prepared, query) : []),
		[prepared, query],
	)
	const filtering = query.trim().length > 0
	// A file chosen from the results ends the search, so the tree comes back with it revealed.
	const openHit = (path: string) => {
		setQuery('')
		onOpen(path)
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the best match.
	useEffect(() => setSelected(0), [query])
	return (
		<div className="file-tree-column">
			<label className="file-tree-filter">
				<SearchIcon aria-hidden="true" />
				<input
					ref={input}
					type="text"
					value={query}
					placeholder="Filter files…"
					aria-label="Filter files"
					role="combobox"
					aria-expanded={filtering && hits.length > 0}
					aria-controls={RESULTS_ID}
					aria-autocomplete="list"
					aria-activedescendant={
						filtering && hits[selected] ? `${RESULTS_ID}-${selected}` : undefined
					}
					spellCheck={false}
					autoComplete="off"
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Escape') setQuery('')
						else if (event.key === 'ArrowDown') {
							event.preventDefault()
							setSelected((value) => Math.min(hits.length - 1, value + 1))
						} else if (event.key === 'ArrowUp') {
							event.preventDefault()
							setSelected((value) => Math.max(0, value - 1))
						} else if (event.key === 'Enter') {
							const hit = hits[selected]
							if (hit) openHit(hit.path)
						}
					}}
				/>
			</label>
			{filtering &&
				(index === undefined ? (
					<p className="file-tree-empty">Reading the project…</p>
				) : index === 'failed' ? (
					<p className="file-tree-empty" role="alert">
						The project files could not be listed.
					</p>
				) : (
					<>
						<FilterResults hits={hits} active={activePath} selected={selected} onOpen={openHit} />
						{index.truncated && (
							<p className="file-tree-note">Very large project: only part of it is searched.</p>
						)}
					</>
				))}
			{/* Kept mounted while filtering, so the folders a person opened stay open. */}
			<div className="file-tree-host" hidden={filtering}>
				<Tree
					api={api}
					projectId={projectId}
					activePath={activePath}
					reveal={reveal}
					onOpen={onOpen}
					refreshToken={refreshToken}
				/>
			</div>
		</div>
	)
}
