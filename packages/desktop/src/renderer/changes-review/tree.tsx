import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { formatLineCount } from '../changes-totals.js'
import { FileIcon } from '../file-panel/file-icons.js'
import { isMarkdownPath } from '../file-panel/project-refs.js'
import { ChevronRightIcon } from '../icons.js'
import { type ReviewTree, TREE_ROOT, type TreeNode } from './model.js'

const ROW_HEIGHT = 28
const INDENT = 14

function Counts({ file }: { file: NonNullable<TreeNode['file']> }) {
	if (file.status === 'binary' || file.binary)
		return <span className="changes-tree-note">binary</span>
	return (
		<span className="changes-tree-counts">
			{file.status === 'untracked' && <span className="changes-tree-note">new</span>}
			{file.added > 0 && <span className="changes-added">+{formatLineCount(file.added)}</span>}
			{file.removed > 0 && (
				<span className="changes-removed">−{formatLineCount(file.removed)}</span>
			)}
		</span>
	)
}

function rowTitle(node: TreeNode): string {
	const file = node.file
	if (!file) return node.id
	return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
}

/** The changed files as a keyboard-driven, virtualised tree; Enter or a click shows a file. */
export function ReviewTreeView({
	tree: model,
	expanded,
	onExpandedChange,
	selected,
	onSelect,
}: {
	tree: ReviewTree
	expanded: string[]
	onExpandedChange: (next: string[]) => void
	selected?: string
	onSelect: (path: string) => void
}) {
	const scroller = useRef<HTMLDivElement>(null)
	const virtualizer = useRef<{ scrollToIndex(index: number): void } | null>(null)
	const select = useRef(onSelect)
	select.current = onSelect
	const tree = useTree<TreeNode>({
		rootItemId: TREE_ROOT,
		indent: INDENT,
		getItemName: (item) => item.getItemData().name,
		isItemFolder: (item) => item.getItemData().kind === 'dir',
		onPrimaryAction: (item) => {
			const data = item.getItemData()
			if (data.kind === 'file') select.current(data.id)
		},
		scrollToItem: (item) => virtualizer.current?.scrollToIndex(item.getItemMeta().index),
		dataLoader: {
			getItem: (id) =>
				model.nodes.get(id) ?? {
					id,
					name: id,
					kind: 'file' as const,
					children: [],
				},
			getChildren: (id) => model.nodes.get(id)?.children ?? [],
		},
		state: { expandedItems: expanded },
		setExpandedItems: (next) =>
			onExpandedChange(typeof next === 'function' ? next(expanded) : next),
		features: [syncDataLoaderFeature, hotkeysCoreFeature],
	})
	// A new set of files replaces the data the tree already read.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the model is the trigger.
	useEffect(() => {
		tree.rebuildTree()
	}, [model, tree])
	const items = tree.getItems()
	const rows = useVirtualizer({
		count: items.length,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 10,
	})
	virtualizer.current = rows
	return (
		<div ref={scroller} className="changes-tree-scroll">
			<div
				{...tree.getContainerProps('Changed files')}
				className="changes-tree"
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
							className="changes-tree-row"
							data-folder={folder || undefined}
							aria-selected={folder ? undefined : item.getId() === selected}
							aria-current={(!folder && item.getId() === selected) || undefined}
							data-active={(!folder && item.getId() === selected) || undefined}
							data-focused={item.isFocused() || undefined}
							data-status={data.file?.status}
							title={rowTitle(data)}
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
									className="changes-tree-chevron"
									data-open={item.isExpanded() || undefined}
								/>
							) : isMarkdownPath(data.id) ? (
								<span className="changes-tree-badge" aria-hidden="true">
									M↓
								</span>
							) : (
								<FileIcon className="changes-tree-file-icon" />
							)}
							<span className="changes-tree-name">{data.name}</span>
							{data.file && <Counts file={data.file} />}
						</button>
					)
				})}
			</div>
		</div>
	)
}
