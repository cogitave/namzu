import { Menu } from '@base-ui/react/menu'
import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { mayOpenWithSystem } from '../shared/output-files.js'
import type { DesktopApi, ProjectFileContent } from '../shared/protocol.js'
import { CopyButton, copyPlainText } from './copy-button.js'
import { DocumentPage } from './document-page.js'
import { FileTypeIcon } from './file-panel/file-icons.js'
import { SourceView } from './file-panel/file-view.js'
import { AppWindowIcon, ChevronDownIcon, DownloadIcon, FolderOpenIcon, XIcon } from './icons.js'
import { MENU_OFFSET } from './menu-metrics.js'
import { cardKindLine } from './output-card-model.js'
import { OUTPUT_FRAME_SANDBOX, outputFrameDocument } from './output-frame.js'
import { type OutputFile, outputAddress } from './outputs-model.js'
import { plainErrorText } from './plain-error.js'
import { Button } from './ui/button.js'
import './conversation-actions-menu.css'
import './file-panel/file-panel.css'
import './outputs-panel.css'

type Load =
	| { path: string; status: 'loading' }
	| { path: string; status: 'error'; message: string }
	| { path: string; status: 'ready'; content: ProjectFileContent }

/**
 * Reads one output through the host. A newer version of the same file keeps the old picture on
 * screen until the new one arrives, and an answer for a file the person already left is dropped.
 */
export function useSessionOutput(
	api: Pick<DesktopApi, 'readSessionOutput'>,
	sessionId: string,
	path: string,
	version: number,
): Load {
	const [state, setState] = useState<Load>({ path, status: 'loading' })
	const shown = useRef<string | undefined>(undefined)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new version reads the file again.
	useEffect(() => {
		let current = true
		if (shown.current !== path) setState({ path, status: 'loading' })
		shown.current = path
		const read = api.readSessionOutput
		if (!read) {
			setState({
				path,
				status: 'error',
				message: 'Files cannot be shown in this version of Namzu.',
			})
			return
		}
		read(sessionId, path).then(
			(content) => current && setState({ path, status: 'ready', content }),
			(failure) =>
				current &&
				setState({ path, status: 'error', message: plainErrorText(failure, 'read the file') }),
		)
		return () => {
			current = false
		}
	}, [api, sessionId, path, version])
	return state.path === path ? state : { path, status: 'loading' }
}

/** The kinds a text file reads as in the pane. */
export function OutputPreview({
	file,
	content,
	dark,
	sessionId,
	read,
}: {
	file: OutputFile
	content: ProjectFileContent
	dark: boolean
	/** Lets a document read the pictures it holds. */
	sessionId?: string
	read?: NonNullable<DesktopApi['readSessionOutput']>
}) {
	if (content.kind === 'image' && content.image)
		return (
			<div className="file-image" data-output-preview="image">
				<img src={content.image} alt={file.name} />
			</div>
		)
	if (content.kind === 'text' && content.text !== undefined) {
		if (file.kind === 'html')
			return (
				<iframe
					className="output-frame"
					data-output-preview="html"
					title={`Preview of ${file.name}`}
					sandbox={OUTPUT_FRAME_SANDBOX}
					referrerPolicy="no-referrer"
					srcDoc={outputFrameDocument(content.text)}
				/>
			)
		if (file.kind === 'markdown')
			return (
				<DocumentPage
					text={content.markdown ?? content.text}
					path={file.path}
					sessionId={sessionId ?? ''}
					read={read}
				/>
			)
		return (
			<div data-output-preview="code">
				<SourceView path={file.path} text={content.text} dark={dark} />
			</div>
		)
	}
	return (
		<p className="file-view-note">
			{content.kind === 'too-large'
				? 'This file is too large to show here.'
				: 'This file is not text, so it cannot be shown here.'}
		</p>
	)
}

export function OutputRow({
	file,
	onOpen,
	onSave,
}: {
	file: OutputFile
	onOpen: (path: string) => void
	onSave?: (file: OutputFile) => void
}) {
	return (
		<li className="output-row-item">
			<button
				type="button"
				className="output-row"
				data-output-row={file.path}
				title={file.path}
				onClick={() => onOpen(file.path)}
			>
				<FileTypeIcon path={file.name} />
				<span className="output-row-name">{file.name}</span>
				{file.folder && <span className="output-row-folder">{file.folder}</span>}
				<span className="output-row-kind">{cardKindLine(file.path)}</span>
			</button>
			{onSave && (
				<button
					type="button"
					className="output-row-save"
					title="Save a copy…"
					aria-label={`Save a copy of ${file.name}`}
					onClick={() => onSave(file)}
				>
					<DownloadIcon aria-hidden="true" />
				</button>
			)}
		</li>
	)
}

export type OutputMenuAction = 'browser' | 'system' | 'folder' | 'save' | 'copy-path'

export const OUTPUT_ACTION_LABEL: Record<OutputMenuAction, string> = {
	browser: 'Open in browser',
	system: 'Open in app',
	folder: 'Show in folder',
	save: 'Save a copy',
	'copy-path': 'Copy path',
}

/** What the title's menu offers for a file, in order: a page also opens in the browser. */
export function outputMenuActions(file: OutputFile, can: { save: boolean }): OutputMenuAction[] {
	return [
		...(file.kind === 'html' ? (['browser'] as const) : []),
		...(mayOpenWithSystem(file.path) ? (['system'] as const) : []),
		'folder',
		...(can.save ? (['save'] as const) : []),
		'copy-path',
	]
}

/**
 * The files the conversation wrote, and a preview of the one chosen. A page shows in a frame with
 * no permissions, a document as formatted text, code with line numbers, an image as itself. The
 * list is the Changes panel's own receipts, so what is listed here can also be reviewed and undone
 * there.
 */
export function OutputsPanel({
	api,
	sessionId,
	outputs,
	selected,
	onSelect,
	dark,
	onNotice,
	workFolder,
}: {
	api: Pick<DesktopApi, 'readSessionOutput' | 'openSessionOutput' | 'saveSessionOutput'>
	sessionId: string
	outputs: readonly OutputFile[]
	selected?: string
	onSelect: (path: string | undefined) => void
	dark: boolean
	onNotice: (text: string) => void
	/** The conversation's work folder: a file inside it shows its path from there. */
	workFolder?: string
}) {
	const file = selected ? outputs.find((item) => item.path === selected) : undefined
	const load = useSessionOutput(api, sessionId, file?.path ?? '', file?.version ?? 0)
	if (!file)
		return (
			<div className="outputs-panel" data-outputs-list>
				<h3 className="outputs-heading">Outputs</h3>
				{outputs.length === 0 ? (
					<p className="outputs-empty">
						Nothing has been written in this conversation yet. Pages, documents and images it writes
						show up here.
					</p>
				) : (
					<ul className="outputs-list" aria-label="Files written in this conversation">
						{outputs.map((item) => (
							<OutputRow
								key={item.path}
								file={item}
								onOpen={onSelect}
								onSave={
									api.saveSessionOutput
										? (target) =>
												void api
													.saveSessionOutput?.(sessionId, target.path)
													.catch((failure) => onNotice(plainErrorText(failure, 'save a copy')))
										: undefined
								}
							/>
						))}
					</ul>
				)}
			</div>
		)
	const open = (target: 'browser' | 'file-manager' | 'system') =>
		void (
			api.openSessionOutput
				? api.openSessionOutput(sessionId, file.path, target)
				: Promise.reject(new Error('Opening is not available.'))
		).catch((failure) =>
			onNotice(
				plainErrorText(
					failure,
					target === 'browser'
						? 'open the page'
						: target === 'system'
							? 'open the file'
							: 'show the file',
				),
			),
		)
	const copyPath = () =>
		void copyPlainText(file.path).then(
			() => onNotice('Path copied.'),
			() => onNotice('Could not copy the path.'),
		)
	const actions = outputMenuActions(file, { save: Boolean(api.saveSessionOutput) })
	const run = (id: OutputMenuAction) => {
		if (id === 'browser') open('browser')
		else if (id === 'system') open('system')
		else if (id === 'folder') open('file-manager')
		else if (id === 'copy-path') copyPath()
		else
			void api
				.saveSessionOutput?.(sessionId, file.path)
				.catch((failure) => onNotice(plainErrorText(failure, 'save a copy')))
	}
	return (
		<div className="outputs-panel" data-outputs-preview={file.path} data-outputs-viewing>
			<div className="outputs-preview-bar" data-output-header>
				<Menu.Root>
					<Menu.Trigger className="outputs-title-button" aria-label={`${file.name}, file actions`}>
						<span className="outputs-preview-name" title={file.path}>
							{file.name}
						</span>
						<ChevronDownIcon aria-hidden="true" />
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner
							className="conversation-actions-positioner"
							align="start"
							sideOffset={MENU_OFFSET}
						>
							<Menu.Popup className="conversation-actions-popup" aria-label="File actions">
								<div className="outputs-menu-path" data-output-address title={file.path}>
									{outputAddress(file.path, workFolder)}
								</div>
								<Menu.Separator className="conversation-actions-separator" />
								{actions.map((id) => (
									<Menu.Item
										key={id}
										className="conversation-actions-item"
										data-output-action={id}
										onClick={() => run(id)}
									>
										{id === 'browser' ? (
											<AppWindowIcon aria-hidden="true" />
										) : id === 'system' ? (
											<ExternalLink aria-hidden="true" />
										) : id === 'save' ? (
											<DownloadIcon aria-hidden="true" />
										) : (
											<FolderOpenIcon aria-hidden="true" />
										)}
										<span className="conversation-actions-label">{OUTPUT_ACTION_LABEL[id]}</span>
									</Menu.Item>
								))}
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
				<div className="outputs-preview-actions">
					{load.status === 'ready' && load.content.text !== undefined && (
						<CopyButton text={load.content.text} label="Copy file contents" />
					)}
					<Button
						type="button"
						size="icon-xs"
						variant="ghost-muted"
						aria-label="Close file"
						title="Close file"
						onClick={() => onSelect(undefined)}
					>
						<XIcon aria-hidden="true" />
					</Button>
				</div>
			</div>
			<div className="outputs-preview-body">
				{load.status === 'loading' ? (
					<p className="file-view-note">Opening {file.name}…</p>
				) : load.status === 'error' ? (
					<p className="file-view-note" role="alert">
						{load.message}
					</p>
				) : (
					<OutputPreview
						file={file}
						content={load.content}
						dark={dark}
						sessionId={sessionId}
						read={api.readSessionOutput}
					/>
				)}
			</div>
		</div>
	)
}
