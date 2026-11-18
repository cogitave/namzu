import { List } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopApi, ProjectFileContent } from '../shared/protocol.js'
import { documentOutline, drawnHeadingIndex, outlineDepths } from './document-outline.js'
import { relativeProjectPath } from './file-panel/project-refs.js'
import { MarkdownContent } from './message.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import './document-page.css'

type ReadOutput = NonNullable<DesktopApi['readSessionOutput']>

/** A picture the document names by a relative path, read through the host like the document itself. */
function DocumentImage({
	read,
	sessionId,
	path,
	alt,
}: { read: ReadOutput | undefined; sessionId: string; path: string; alt?: string }) {
	const [state, setState] = useState<
		{ status: 'loading' } | { status: 'failed' } | { status: 'ready'; src: string }
	>({ status: 'loading' })
	useEffect(() => {
		let current = true
		setState({ status: 'loading' })
		if (!read) {
			setState({ status: 'failed' })
			return
		}
		read(sessionId, path).then(
			(content: ProjectFileContent) => {
				if (!current) return
				setState(
					content.kind === 'image' && content.image
						? { status: 'ready', src: content.image }
						: { status: 'failed' },
				)
			},
			() => current && setState({ status: 'failed' }),
		)
		return () => {
			current = false
		}
	}, [read, sessionId, path])
	if (state.status === 'ready')
		return <img className="document-image" src={state.src} alt={alt ?? ''} />
	const name = alt || path.split('/').pop() || 'Picture'
	return (
		<span className="notice" data-document-image={state.status}>
			{state.status === 'loading' ? `${name}…` : `${name} (not available)`}
		</span>
	)
}

const HEADINGS = 'h1, h2, h3, h4'

function Outline({ text, page }: { text: string; page: React.RefObject<HTMLElement | null> }) {
	const entries = useMemo(() => documentOutline(text), [text])
	const [open, setOpen] = useState(false)
	if (entries.length === 0) return null
	const depths = outlineDepths(entries)
	const jump = (index: number) => {
		const drawn = [...(page.current?.querySelectorAll<HTMLElement>(HEADINGS) ?? [])]
		const at = drawnHeadingIndex(
			entries,
			index,
			drawn.map((element) => element.textContent ?? ''),
		)
		const target = at === undefined ? undefined : drawn[at]
		setOpen(false)
		if (!target) return
		const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
		target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						size="icon-sm"
						variant="outline"
						className="document-outline-trigger"
						aria-label="Outline"
						title="Outline"
						data-document-outline-button
					/>
				}
			>
				<List aria-hidden="true" />
			</PopoverTrigger>
			<PopoverPopup
				side="bottom"
				align="start"
				padding="compact"
				className="document-outline-popup"
			>
				<nav className="document-outline" aria-label="Outline of this document">
					<ol>
						{entries.map((entry, index) => (
							<li key={`${entry.level}:${entry.text}:${entry.occurrence}`}>
								<button
									type="button"
									className="document-outline-item"
									data-depth={depths[index]}
									style={{ paddingInlineStart: `calc(0.5rem + ${depths[index]} * 0.9rem)` }}
									onClick={() => jump(index)}
								>
									{entry.text}
								</button>
							</li>
						))}
					</ol>
				</nav>
			</PopoverPopup>
		</Popover>
	)
}

/**
 * A Markdown document drawn as a page: serif headings, a readable line length, tables that scroll
 * sideways, pictures the document holds, and an outline of its headings. The page is the file as
 * it is now: when the file is written again the text changes and the page follows, in the same
 * scroll place. Links to other files and the web stay inert here, as in the rest of the pane.
 */
export function DocumentPage({
	text,
	path,
	sessionId,
	read,
}: {
	text: string
	path: string
	sessionId: string
	read: ReadOutput | undefined
}) {
	const page = useRef<HTMLElement | null>(null)
	const options = useMemo(
		() => ({
			link: (href: string | undefined, children: ReactNode) =>
				href && /^https?:/i.test(href) ? undefined : (
					<span className="document-inert-link">{children}</span>
				),
			image: (src: string | undefined, alt: string | undefined) => {
				const target = src ? relativeProjectPath(path, src) : undefined
				return target ? (
					<DocumentImage read={read} sessionId={sessionId} path={target} alt={alt} />
				) : (
					<span className="notice">{alt || 'Picture'}</span>
				)
			},
		}),
		[path, read, sessionId],
	)
	return (
		<div className="document-page" data-output-preview="markdown">
			<div className="document-page-bar">
				<Outline text={text} page={page} />
			</div>
			<article className="file-document document-page-sheet" ref={page}>
				<MarkdownContent text={text} document={options} />
			</article>
		</div>
	)
}
