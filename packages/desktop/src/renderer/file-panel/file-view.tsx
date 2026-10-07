import { getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs'
import { CodeView, File } from '@pierre/diffs/react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopApi, ProjectFileContent } from '../../shared/protocol.js'
import { CopyButton } from '../copy-button.js'
import { DIFF_VIEW_UNSAFE_CSS } from '../diff-theme.js'
import { ChevronRightIcon } from '../icons.js'
import { type DocumentOptions, MarkdownContent } from '../message.js'
import { Button } from '../ui/button.js'
import { baseNameOf, isMarkdownPath, relativeProjectPath } from './project-refs.js'

/** Past this many lines the source is virtualised. */
export const CODE_VIEW_LINES = 5000

export type FileLoad =
	| { path: string; status: 'loading' }
	| { path: string; status: 'error'; message: string }
	| { path: string; status: 'ready'; content: ProjectFileContent }

/** Reads one file; a slower answer for a file the person already left never replaces the current one. */
export function useProjectFile(
	api: DesktopApi,
	projectId: string,
	path: string,
	refreshToken = 0,
): FileLoad {
	const [state, setState] = useState<FileLoad>({ path, status: 'loading' })
	const shown = useRef<string | undefined>(undefined)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new token reads the file again.
	useEffect(() => {
		let current = true
		// A refresh of the file already on screen keeps it there until the new text arrives.
		if (shown.current !== path) setState({ path, status: 'loading' })
		shown.current = path
		const read = api.readProjectFile
		if (!read) {
			setState({ path, status: 'error', message: 'Files cannot be read in this version of Namzu.' })
			return
		}
		read(projectId, path).then(
			(content) => current && setState({ path, status: 'ready', content }),
			(failure) =>
				current &&
				setState({
					path,
					status: 'error',
					message: failure instanceof Error ? failure.message : 'This file could not be read.',
				}),
		)
		return () => {
			current = false
		}
	}, [api, projectId, path, refreshToken])
	return state.path === path ? state : { path, status: 'loading' }
}

function Metadata({ rows }: { rows: { key: string; value: string }[] }) {
	return (
		<section className="file-metadata" aria-label="Metadata">
			<h3>Metadata</h3>
			<dl>
				{rows.map((row, index) => (
					// Keys can repeat in hand-written YAML, so the position keeps rows apart.
					<div key={`${index}:${row.key}`}>
						<dt>{row.key}</dt>
						<dd>{row.value}</dd>
					</div>
				))}
			</dl>
		</section>
	)
}

function ProjectImage({
	api,
	projectId,
	path,
	alt,
}: { api: DesktopApi; projectId: string; path: string; alt?: string }) {
	const load = useProjectFile(api, projectId, path)
	if (load.status === 'ready' && load.content.kind === 'image' && load.content.image)
		return <img src={load.content.image} alt={alt ?? ''} className="document-image" />
	return (
		<span className="notice">
			{alt || baseNameOf(path)}
			{load.status === 'loading' ? '…' : ' (not available)'}
		</span>
	)
}

function DocumentView({
	api,
	projectId,
	path,
	content,
	onOpenPath,
}: {
	api: DesktopApi
	projectId: string
	path: string
	content: ProjectFileContent
	onOpenPath: (path: string) => void
}) {
	const options = useMemo<DocumentOptions>(
		() => ({
			link: (href, children): ReactNode => {
				// Web links keep the message behaviour: system browser behind a link card.
				if (!href || /^https?:/i.test(href)) return undefined
				const target = relativeProjectPath(path, href)
				if (!target) return <span className="document-inert-link">{children}</span>
				return (
					<button
						type="button"
						className="document-file-link"
						title={target}
						onClick={() => onOpenPath(target)}
					>
						{children}
					</button>
				)
			},
			image: (src, alt) => {
				const target = src ? relativeProjectPath(path, src) : undefined
				return target ? (
					<ProjectImage api={api} projectId={projectId} path={target} alt={alt} />
				) : (
					<span className="notice">{alt || 'Image'}</span>
				)
			},
		}),
		[api, projectId, path, onOpenPath],
	)
	const copyText = content.text ?? content.markdown ?? ''
	return (
		<article className="file-document">
			<CopyButton text={copyText} label="Copy file contents" className="file-document-copy" />
			{content.frontmatter && content.frontmatter.length > 0 && (
				<Metadata rows={content.frontmatter} />
			)}
			<MarkdownContent text={content.markdown ?? content.text ?? ''} document={options} />
		</article>
	)
}

/**
 * The File component starts its own highlighter lazily and, on a page that has not drawn a diff
 * yet, never paints; loading the shared one first (with the file's language) avoids that.
 */
function useHighlighterReady(path: string): boolean {
	const [ready, setReady] = useState(false)
	useEffect(() => {
		let current = true
		setReady(false)
		getSharedHighlighter({
			themes: ['pierre-light', 'pierre-dark'],
			langs: [getFiletypeFromFileName(path) ?? 'text'],
			preferredHighlighter: 'shiki-wasm',
		}).then(
			() => current && setReady(true),
			// A highlighter that cannot load still leaves the plain text readable.
			() => current && setReady(true),
		)
		return () => {
			current = false
		}
	}, [path])
	return ready
}

function SourceView({
	path,
	text,
	dark,
	line,
}: { path: string; text: string; dark: boolean; line?: number }) {
	const ready = useHighlighterReady(path)
	const lines = useMemo(() => text.split('\n').length, [text])
	const file = useMemo(() => ({ name: path, contents: text }), [path, text])
	// Stable objects: the highlighter restarts its work when its options change identity.
	const options = useMemo(
		() => ({
			theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
			themeType: dark ? ('dark' as const) : ('light' as const),
			preferredHighlighter: 'shiki-wasm' as const,
			overflow: 'scroll' as const,
			unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
		}),
		[dark],
	)
	const fileOptions = useMemo(() => ({ ...options, disableFileHeader: true }), [options])
	const viewOptions = useMemo(() => ({ ...options, stickyHeaders: false }), [options])
	const items = useMemo(() => [{ id: path, type: 'file' as const, file }], [path, file])
	const selected = useMemo(() => (line ? { start: line, end: line } : null), [line])
	return (
		<div className="file-source" data-virtual={lines > CODE_VIEW_LINES || undefined}>
			<div className="file-document-copy-row">
				<CopyButton text={text} label="Copy file contents" />
			</div>
			{!ready ? null : lines > CODE_VIEW_LINES ? (
				<CodeView className="file-code-view" items={items} options={viewOptions} />
			) : (
				<File
					className="diff-code-view"
					file={file}
					selectedLines={selected}
					options={fileOptions}
				/>
			)}
		</div>
	)
}

/** One open file: Markdown as a document, text as source, an image, or a plain reason. */
export function FileView({
	api,
	projectId,
	path,
	line,
	showSource,
	dark,
	editorLabel,
	onOpenPath,
	onOpenInEditor,
	refreshToken,
}: {
	/** Changes when the agent may have written files; the open file is read again. */
	refreshToken?: number
	api: DesktopApi
	projectId: string
	path: string
	line?: number
	showSource: boolean
	dark: boolean
	editorLabel?: string
	onOpenPath: (path: string) => void
	onOpenInEditor: () => void
}) {
	const load = useProjectFile(api, projectId, path, refreshToken)
	if (load.status === 'loading')
		return <p className="file-view-note">Opening {baseNameOf(path)}…</p>
	if (load.status === 'error')
		return (
			<p className="file-view-note" role="alert">
				{load.message}
			</p>
		)
	const { content } = load
	if (content.kind === 'image' && content.image)
		return (
			<div className="file-image">
				<img src={content.image} alt={baseNameOf(path)} />
			</div>
		)
	if (content.kind === 'text' && content.text !== undefined) {
		if (isMarkdownPath(path) && !showSource)
			return (
				<DocumentView
					api={api}
					projectId={projectId}
					path={path}
					content={content}
					onOpenPath={onOpenPath}
				/>
			)
		return <SourceView path={path} text={content.text} dark={dark} line={line} />
	}
	return (
		<div className="file-view-note">
			<p>
				{content.kind === 'too-large'
					? 'This file is too large to show here.'
					: 'This file is not text, so it cannot be shown here.'}
			</p>
			{editorLabel && (
				<Button type="button" size="xs" variant="outline" onClick={onOpenInEditor}>
					Open in {editorLabel}
				</Button>
			)}
		</div>
	)
}

/** project › folder › file: each folder shows itself in the tree. */
export function FileBreadcrumb({
	projectName,
	path,
	onReveal,
}: { projectName: string; path: string; onReveal: (folder: string) => void }) {
	const parts = path.split('/')
	return (
		<nav className="file-breadcrumb" aria-label="File location">
			<button type="button" className="file-crumb" onClick={() => onReveal('')}>
				{projectName}
			</button>
			{parts.length > 1 && (
				<span className="file-crumb-gap" aria-hidden="true">
					›…
				</span>
			)}
			{parts.map((part, index) => {
				const last = index === parts.length - 1
				const folder = parts.slice(0, index + 1).join('/')
				return (
					<span key={folder} className="file-crumb-item" data-middle={!last || undefined}>
						<ChevronRightIcon aria-hidden="true" />
						{last ? (
							<strong className="file-crumb-current" title={path}>
								{part}
							</strong>
						) : (
							<button type="button" className="file-crumb" onClick={() => onReveal(folder)}>
								{part}
							</button>
						)}
					</span>
				)
			})}
		</nav>
	)
}
