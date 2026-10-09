/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import {
	type ComponentProps,
	type ComponentPropsWithoutRef,
	type HTMLAttributes,
	type ReactNode,
	createContext,
	memo,
	useContext,
	useMemo,
	useState,
} from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../shared/protocol.js'
import { CopyButton } from './copy-button.js'
import {
	ProjectFileLink,
	ResolvedRefsContext,
	useResolvedRefs,
} from './file-panel/project-files.js'
import { codeRef, linkRef } from './file-panel/project-refs.js'
import { cn } from './lib/utils.js'
import { LinkPreviewCard } from './link-preview-card.js'
import { markdownBlockSources } from './markdown-blocks.js'
import { COPY_CODE_PROPERTY, markdownCodeCopy, remarkCodeCopy } from './markdown-code-copy.js'
import { useThrottledText } from './throttled-text.js'
import './message-footer.css'
import {
	PreviewCard,
	PreviewCardCreateHandle,
	PreviewCardPopup,
	PreviewCardTrigger,
} from './ui/preview-card.js'

function externalWebUrl(value: string | undefined): string | undefined {
	if (!value || value.length > 8192) return undefined
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || code === 127) return undefined
	}
	try {
		const url = new URL(value)
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
			return undefined
		return url.href
	} catch {
		return undefined
	}
}

interface LinkPreviewPayload {
	url: string
	text: string
}
type LinkPreviewHandle = ReturnType<typeof PreviewCardCreateHandle<LinkPreviewPayload>>

// One card per rendered message: its links share this handle, so opening a
// card re-renders the card alone and never the parsed Markdown.
const LinkPreviewContext = createContext<LinkPreviewHandle | null>(null)

function plainText(children: ReactNode): string {
	if (typeof children === 'string' || typeof children === 'number') return String(children)
	if (Array.isArray(children)) return children.map(plainText).join('')
	return ''
}

function MessageLink({ children, href }: { children?: ReactNode; href?: string }) {
	const [failed, setFailed] = useState(false)
	const handle = useContext(LinkPreviewContext)
	const refs = useContext(ResolvedRefsContext)
	const url = externalWebUrl(href)
	const payload = useMemo(
		() => (url ? { url, text: plainText(children) } : undefined),
		[url, children],
	)
	// A reply's local link renders as a file link only once the host has said it names a real file.
	const local = url ? undefined : refs.get(linkRef(href) ?? '')
	if (local) return <ProjectFileLink hit={local}>{children}</ProjectFileLink>
	if (!url || typeof window === 'undefined' || !window.namzu?.openExternal)
		return (
			<span className="message-link" title={href}>
				{children}
			</span>
		)
	const anchorProps = {
		className: 'message-link',
		href: url,
		target: '_blank',
		rel: 'noopener noreferrer',
		onClick: (event: { preventDefault(): void }) => {
			event.preventDefault()
			void window.namzu.openExternal?.(url).catch(() => setFailed(true))
		},
	}
	return (
		<>
			{handle && payload ? (
				<PreviewCardTrigger
					{...anchorProps}
					closeDelay={150}
					delay={500}
					handle={handle}
					payload={payload}
				>
					{children}
				</PreviewCardTrigger>
			) : (
				<a {...anchorProps}>{children}</a>
			)}
			{failed && (
				<span className="notice" role="alert">
					Could not open link.
				</span>
			)}
		</>
	)
}

const CodeBlockContext = createContext(false)

function MarkdownPre({
	node,
	children,
	...props
}: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
	const code = markdownCodeCopy(node)
	return (
		<div className="chat-markdown-codeblock">
			{code && (
				<div className="chat-markdown-codeblock-header">
					<span className="chat-markdown-codeblock-language">{code.language || 'Code'}</span>
					<CopyButton text={code.text} label="Copy code" />
				</div>
			)}
			<CodeBlockContext.Provider value={true}>
				<pre {...props}>{children}</pre>
			</CodeBlockContext.Provider>
		</div>
	)
}

function MarkdownCode({
	node: _node,
	children,
	[COPY_CODE_PROPERTY]: _copyText,
	...props
}: ComponentPropsWithoutRef<'code'> & {
	node?: unknown
	[COPY_CODE_PROPERTY]?: string
}) {
	const block = useContext(CodeBlockContext)
	const refs = useContext(ResolvedRefsContext)
	const text = typeof children === 'string' ? children : undefined
	const local = !block && text ? refs.get(codeRef(text) ?? '') : undefined
	if (local)
		return (
			<code {...props}>
				<ProjectFileLink hit={local}>{children}</ProjectFileLink>
			</code>
		)
	const url = !block && text && /^https?:\/\/\S+$/.test(text) ? externalWebUrl(text) : undefined
	return <code {...props}>{url ? <MessageLink href={url}>{text}</MessageLink> : children}</code>
}

/** A known clock only; source stays explicit in its full-date tooltip. */
const messageClock = new Intl.DateTimeFormat(undefined, {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false,
})
const messageFullTime = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'medium',
	timeStyle: 'medium',
})

function knownMessageTime(time: ChatMessage['time']): boolean {
	return !!time && Number.isFinite(time.at) && time.at >= 0 && time.at <= 8_640_000_000_000_000
}

/** The full time as the clock's tooltip and accessible name say it; undefined when it is unknown. */
export function timeDescription(time: ChatMessage['time']): string | undefined {
	if (!time || !knownMessageTime(time)) return undefined
	const full = messageFullTime.format(new Date(time.at))
	return `${time.source === 'journal' ? 'Saved in this conversation' : 'Time'}: ${full}`
}

export function MessageTime({
	time,
	focusable = false,
}: { time?: ChatMessage['time']; focusable?: boolean }) {
	const [expanded, setExpanded] = useState(false)
	if (!time || !knownMessageTime(time)) return null
	const date = new Date(time.at)
	const label = messageClock.format(date)
	const full = messageFullTime.format(date)
	const description = timeDescription(time) ?? full
	if (focusable)
		return (
			<button
				type="button"
				className="message-time"
				aria-label={description}
				aria-pressed={expanded}
				title={description}
				onClick={() => setExpanded((value) => !value)}
			>
				<time dateTime={date.toISOString()}>{expanded ? full : label}</time>
			</button>
		)
	return (
		<time
			className="message-time"
			dateTime={date.toISOString()}
			aria-label={description}
			title={description}
		>
			{label}
		</time>
	)
}

/** Clock and reply controls occupy one stable row before being revealed. */
export function MessageFooter({
	time,
	children,
	focusable = false,
}: { time?: ChatMessage['time']; children?: ReactNode; focusable?: boolean }) {
	if (!knownMessageTime(time) && !children) return null
	return (
		<div className="message-footer">
			<MessageTime time={time} focusable={focusable} />
			{children}
		</div>
	)
}

export function Message({
	className,
	from,
	...props
}: HTMLAttributes<HTMLDivElement> & { from: 'user' | 'assistant' }) {
	return (
		<div
			data-message-role={from}
			className={cn(
				'pb-4',
				from === 'user'
					? 'group is-user flex flex-col items-end gap-1'
					: 'group group/assistant is-assistant',
				className,
			)}
			{...props}
		/>
	)
}

/** How a document view in the side panel treats links and images that name project files. */
export interface DocumentOptions {
	link(href: string | undefined, children: ReactNode): ReactNode | undefined
	image(src: string | undefined, alt: string | undefined): ReactNode
}

// Streaming updates change the live body, while settled bodies retain their
// parsed tree. Wrapper attributes and inherited theme styling remain live.
// Only a settled reply asks the host which of its links name project files.
export const MarkdownContent = memo(function MarkdownContent({
	text,
	settled = false,
	document,
}: { text: string; settled?: boolean; document?: DocumentOptions }) {
	const [handle] = useState(() => PreviewCardCreateHandle<LinkPreviewPayload>())
	// A reply that is still streaming is shown at most every 50 ms; a settled one at once.
	const shown = useThrottledText(text, !settled && !document)
	const refs = useResolvedRefs(shown, settled && !document)
	return (
		<LinkPreviewContext.Provider value={handle}>
			<ResolvedRefsContext.Provider value={refs}>
				<MarkdownBody text={shown} document={document} />
			</ResolvedRefsContext.Provider>
			<LinkPreviews handle={handle} />
		</LinkPreviewContext.Provider>
	)
})

/** Opening a card changes only this subtree. */
function LinkPreviews({ handle }: { handle: LinkPreviewHandle }) {
	return (
		<PreviewCard handle={handle}>
			{({ payload }) =>
				payload && (
					<PreviewCardPopup>
						<LinkPreviewCard
							text={payload.text}
							url={payload.url}
							onOpen={(url) => {
								handle.close()
								void window.namzu?.openExternal?.(url).catch(() => {})
							}}
						/>
					</PreviewCardPopup>
				)
			}
		</PreviewCard>
	)
}

// One component map for every block of a reply (T3 Code's ChatMarkdown keeps its map stable the
// same way), so a settled block's memo is never broken by a fresh object.
const markdownComponents: Components = {
	// Remote media stays inert; web links require the owned main bridge.
	a: ({ node: _node, href, children }) => <MessageLink href={href}>{children}</MessageLink>,
	pre: MarkdownPre,
	code: MarkdownCode,
	img: ({ alt }) => <span className="notice">{alt || 'Image'}</span>,
	table: ({ children }) => (
		<section
			className="table-scroll"
			aria-label="Table"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: A horizontal table region needs keyboard focus for scrolling.
			tabIndex={0}
		>
			<table>{children}</table>
		</section>
	),
}

function documentComponents(document: DocumentOptions): Components {
	return {
		...markdownComponents,
		a: ({ node: _node, href, children }) =>
			document.link(href, children) ?? <MessageLink href={href}>{children}</MessageLink>,
		// Only a document view may show an image, and only one the project itself holds.
		img: ({ alt, src }) => document.image(typeof src === 'string' ? src : undefined, alt),
	}
}

type RemarkPlugins = NonNullable<ComponentProps<typeof Markdown>['remarkPlugins']>

const MarkdownBlock = memo(function MarkdownBlock({
	text,
	document,
}: { text: string; document?: DocumentOptions }) {
	const plugins = useMemo(
		(): RemarkPlugins => [
			remarkGfm,
			...(document ? [remarkFrontmatter] : []),
			[remarkCodeCopy, { source: text }],
		],
		[text, document],
	)
	const components = useMemo(
		() => (document ? documentComponents(document) : markdownComponents),
		[document],
	)
	return (
		<Markdown remarkPlugins={plugins} skipHtml components={components}>
			{text}
		</Markdown>
	)
})

/**
 * A streaming reply is cut at blank lines outside code: a settled block keeps its parsed tree and
 * only the tail is parsed again. A document is parsed whole, because front matter and its
 * relative links belong to the file, not to a block.
 */
export const MarkdownBody = memo(function MarkdownBody({
	text,
	document,
	split = true,
}: { text: string; document?: DocumentOptions; split?: boolean }) {
	const blocks = useMemo(
		() => (document || !split ? [text] : markdownBlockSources(text)),
		[text, document, split],
	)
	return (
		<div
			className={cn(
				'message-text chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] [word-break:break-word]',
				document && 'document-markdown',
			)}
		>
			{blocks.map((block, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: A block's identity is its position; only the tail grows.
				<MarkdownBlock key={index} text={block} document={document} />
			))}
		</div>
	)
})

export function MessageContent({
	children,
	className,
	text,
	markdown,
	settled,
	...props
}: HTMLAttributes<HTMLDivElement> & {
	text?: string
	markdown?: boolean
	/** The reply has finished streaming, so its file references may be looked up. */
	settled?: boolean
}) {
	return (
		<div
			className={cn(
				'relative min-w-0 group-[.is-user]:max-w-[80%] group-[.is-user]:rounded-2xl group-[.is-user]:bg-message group-[.is-user]:p-3 group-[.is-user]:text-message-foreground',
				'group-[.is-assistant]:px-1 group-[.is-assistant]:py-0.5',
				className,
			)}
			{...props}
		>
			{markdown && text !== undefined ? (
				<MarkdownContent text={text} settled={settled} />
			) : text !== undefined ? (
				<div className="message-text whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
					{text}
				</div>
			) : (
				children
			)}
		</div>
	)
}
