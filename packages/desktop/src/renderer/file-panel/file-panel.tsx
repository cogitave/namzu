import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi } from '../../shared/protocol.js'
import { FileTextIcon } from '../icons.js'
import { Button } from '../ui/button.js'
import { FolderTreeIcon } from './file-icons.js'
import type { FileTabsState } from './file-tabs.js'
import { FileTree, type TreeReveal } from './file-tree.js'
import { FileBreadcrumb, FileView } from './file-view.js'
import { type Editor, OpenInButton, type OpenTarget } from './open-in.js'
import { isMarkdownPath } from './project-refs.js'
import './file-panel.css'

/** The body under the tab strip for an open file, or for "+" before one is chosen. */
export function FilePanelBody({
	api,
	projectId,
	projectName,
	files,
	editors,
	dark,
	wide,
	browsing,
	onOpenPath,
	onNotice,
	refreshToken,
}: {
	/** Changes when a turn settles, so the open file and the tree read the disk again. */
	refreshToken?: number
	api: DesktopApi
	projectId: string
	projectName: string
	files: FileTabsState
	editors: readonly Editor[]
	dark: boolean
	/** Room for the tree beside the document; otherwise it opens over it. */
	wide: boolean
	browsing: boolean
	onOpenPath: (path: string, line?: number) => void
	onNotice: (text: string) => void
}) {
	const path = browsing ? undefined : files.active
	// Until the person chooses, the tree is open when there is room beside the document.
	const [treeChoice, setTreeChoice] = useState<boolean>()
	const treeOpen = treeChoice ?? wide
	const [showSource, setShowSource] = useState(false)
	const [reveal, setReveal] = useState<TreeReveal>()
	const [focusFilter, setFocusFilter] = useState(0)
	// A file's own source toggle never carries to the next file.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on every new file.
	useEffect(() => setShowSource(false), [path])
	// Opening a file shows where it lives; "+" opens the tree with the filter ready.
	const revealTick = useRef(0)
	useEffect(() => {
		if (path) setReveal({ path, folder: false, token: `${path}:${++revealTick.current}` })
	}, [path])
	useEffect(() => {
		if (!browsing) return
		setTreeChoice(true)
		setFocusFilter((value) => value + 1)
	}, [browsing])
	const open = useCallback(
		(target: string) => {
			// Over the document, the tree has done its job once a file is chosen.
			if (!wide) setTreeChoice(false)
			onOpenPath(target)
		},
		[onOpenPath, wide],
	)
	const openIn = (target: OpenTarget) => {
		if (!api.openProjectPath) return
		if (!path) return
		api.openProjectPath(projectId, path, target, files.line).catch((failure) => {
			onNotice(failure instanceof Error ? failure.message : 'This could not be opened.')
		})
	}
	const markdown = path ? isMarkdownPath(path) : false
	const [editor] = editors
	return (
		<div className="file-panel" data-tree={treeOpen || undefined} data-wide={wide || undefined}>
			<div className="file-toolbar">
				{path ? (
					<FileBreadcrumb
						projectName={projectName}
						path={path}
						onReveal={(folder) => {
							setTreeChoice(true)
							setReveal({ path: folder, folder: true, token: `${folder}:${++revealTick.current}` })
						}}
					/>
				) : (
					<span className="file-toolbar-hint">Choose a file</span>
				)}
				<div className="file-toolbar-actions">
					{markdown && (
						<Button
							type="button"
							size="xs"
							variant="ghost-muted"
							className="file-source-toggle"
							aria-pressed={showSource}
							onClick={() => setShowSource((value) => !value)}
						>
							{showSource ? 'View document' : 'View source'}
						</Button>
					)}
					<Button
						type="button"
						size="icon-xs"
						variant="ghost-muted"
						aria-label={treeOpen ? 'Hide file tree' : 'Show file tree'}
						aria-pressed={treeOpen}
						title={treeOpen ? 'Hide file tree' : 'Show file tree'}
						onClick={() => setTreeChoice(!treeOpen)}
					>
						<FolderTreeIcon className="size-4" />
					</Button>
					{path && <OpenInButton editors={editors} onOpen={openIn} />}
				</div>
			</div>
			<div className="file-panel-body">
				<div className="file-panel-main">
					{path ? (
						<FileView
							api={api}
							projectId={projectId}
							path={path}
							line={files.line}
							showSource={showSource}
							dark={dark}
							editorLabel={editor?.label}
							onOpenPath={open}
							onOpenInEditor={() => openIn('editor')}
							refreshToken={refreshToken}
						/>
					) : (
						<div className="file-view-note">
							<FileTextIcon className="size-5" />
							<p>Pick a file from the tree, or type in the filter to find one.</p>
						</div>
					)}
				</div>
				{treeOpen && (
					<FileTree
						api={api}
						projectId={projectId}
						activePath={path}
						reveal={reveal}
						focusFilter={focusFilter}
						onOpen={open}
						refreshToken={refreshToken}
					/>
				)}
			</div>
		</div>
	)
}
