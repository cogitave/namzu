import { List } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { documentOutline, drawnHeadingIndex, outlineDepths } from './document-outline.js'
import { type DocumentOptions, MarkdownContent } from './message.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import './document-page.css'

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
 * sideways, and an outline of its headings. The page is the file as it is now: when the file is written
 * again the text changes and the page follows, in the same scroll place. How links and pictures draw is
 * the caller's (`options`), so the Files pane keeps its own file links and project pictures.
 */
export function DocumentPage({
	text,
	options,
	lead,
}: {
	text: string
	options: DocumentOptions
	/** Drawn above the text inside the sheet, such as a file's metadata. */
	lead?: ReactNode
}) {
	const page = useRef<HTMLElement | null>(null)
	return (
		<div className="document-page" data-output-preview="markdown">
			<div className="document-page-bar">
				<Outline text={text} page={page} />
			</div>
			<article className="file-document document-page-sheet" ref={page}>
				{lead}
				<MarkdownContent text={text} document={options} />
			</article>
		</div>
	)
}
