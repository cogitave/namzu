import { useEffect, useRef, useState } from 'react'
import type { DesktopApi, ProjectFileContent } from '../shared/protocol.js'
import { CopyButton } from './copy-button.js'
import { FileTypeIcon } from './file-panel/file-icons.js'
import { SourceView } from './file-panel/file-view.js'
import { AppWindowIcon, ArrowLeftIcon, FolderOpenIcon } from './icons.js'
import { MarkdownContent } from './message.js'
import { OUTPUT_FRAME_SANDBOX, outputFrameDocument } from './output-frame.js'
import { type OutputFile, outputAddress } from './outputs-model.js'
import { plainErrorText } from './plain-error.js'
import { Button } from './ui/button.js'
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

const KIND_WORDS: Record<OutputFile['kind'], string> = {
	html: 'Page',
	markdown: 'Document',
	image: 'Image',
	code: 'File',
}

/** The kinds a text file reads as in the pane. */
export function OutputPreview({
	file,
	content,
	dark,
}: { file: OutputFile; content: ProjectFileContent; dark: boolean }) {
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
				<article className="file-document" data-output-preview="markdown">
					<MarkdownContent
						text={content.markdown ?? content.text}
						document={{
							// A page of a document that points at another file or a web address does not leave the pane.
							link: (href, children) =>
								href && /^https?:/i.test(href) ? undefined : (
									<span className="document-inert-link">{children}</span>
								),
							image: (_src, alt) => <span className="notice">{alt || 'Image'}</span>,
						}}
					/>
				</article>
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

function OutputRow({
	file,
	onOpen,
}: {
	file: OutputFile
	onOpen: (path: string) => void
}) {
	return (
		<li>
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
				<span className="output-row-kind">{KIND_WORDS[file.kind]}</span>
			</button>
		</li>
	)
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
	api: Pick<DesktopApi, 'readSessionOutput' | 'openSessionOutput'>
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
							<OutputRow key={item.path} file={item} onOpen={onSelect} />
						))}
					</ul>
				)}
			</div>
		)
	const open = (target: 'browser' | 'file-manager') =>
		void (
			api.openSessionOutput
				? api.openSessionOutput(sessionId, file.path, target)
				: Promise.reject(new Error('Opening is not available.'))
		).catch((failure) =>
			onNotice(plainErrorText(failure, target === 'browser' ? 'open the page' : 'show the file')),
		)
	return (
		<div className="outputs-panel" data-outputs-preview={file.path}>
			<div className="outputs-preview-bar">
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label="All outputs"
					title="All outputs"
					onClick={() => onSelect(undefined)}
				>
					<ArrowLeftIcon aria-hidden="true" />
				</Button>
				<span className="outputs-preview-name" title={file.path}>
					{file.name}
				</span>
				<div className="outputs-preview-actions">
					{file.kind === 'html' && (
						<Button type="button" size="xs" variant="ghost-muted" onClick={() => open('browser')}>
							<AppWindowIcon aria-hidden="true" />
							Open in browser
						</Button>
					)}
					<Button
						type="button"
						size="xs"
						variant="ghost-muted"
						onClick={() => open('file-manager')}
					>
						<FolderOpenIcon aria-hidden="true" />
						Show in folder
					</Button>
					{load.status === 'ready' && load.content.text !== undefined && (
						<CopyButton text={load.content.text} label="Copy file contents" />
					)}
				</div>
			</div>
			<div className="outputs-address" data-output-address>
				<input
					className="outputs-address-input"
					type="text"
					readOnly
					spellCheck={false}
					aria-label="Location"
					value={outputAddress(file.path, workFolder)}
					title={file.path}
					onFocus={(event) => event.currentTarget.select()}
				/>
			</div>
			<div className="outputs-preview-body">
				{load.status === 'loading' ? (
					<p className="file-view-note">Opening {file.name}…</p>
				) : load.status === 'error' ? (
					<p className="file-view-note" role="alert">
						{load.message}
					</p>
				) : (
					<OutputPreview file={file} content={load.content} dark={dark} />
				)}
			</div>
		</div>
	)
}
