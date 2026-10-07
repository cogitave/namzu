/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import {
	type ComponentPropsWithoutRef,
	type HTMLAttributes,
	type ReactNode,
	createContext,
	memo,
	useContext,
	useMemo,
	useState,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../shared/protocol.js'
import { CopyButton } from './copy-button.js'
import { cn } from './lib/utils.js'
import { LinkPreviewCard } from './link-preview-card.js'
import { COPY_CODE_PROPERTY, markdownCodeCopy, remarkCodeCopy } from './markdown-code-copy.js'
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
	const url = externalWebUrl(href)
	const payload = useMemo(
		() => (url ? { url, text: plainText(children) } : undefined),
		[url, children],
	)
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
	const text = typeof children === 'string' ? children : undefined
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

export function MessageTime({
	time,
	focusable = false,
}: { time?: ChatMessage['time']; focusable?: boolean }) {
	const [expanded, setExpanded] = useState(false)
	if (!time || !knownMessageTime(time)) return null
	const date = new Date(time.at)
	const label = messageClock.format(date)
	const full = messageFullTime.format(date)
	const description = `${time.source === 'journal' ? 'Recorded in conversation' : 'Observed by Namzu'}: ${full}`
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

// Streaming updates change the live body, while settled bodies retain their
// parsed tree. Wrapper attributes and inherited theme styling remain live.
const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
	const [handle] = useState(() => PreviewCardCreateHandle<LinkPreviewPayload>())
	return (
		<LinkPreviewContext.Provider value={handle}>
			<MarkdownBody text={text} />
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

const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
	return (
		<div className="message-text chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] [word-break:break-word]">
			<Markdown
				remarkPlugins={[remarkGfm, [remarkCodeCopy, { source: text }]]}
				skipHtml
				components={{
					// Remote media stays inert; web links require the owned main bridge.
					a: MessageLink,
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
				}}
			>
				{text}
			</Markdown>
		</div>
	)
})

export function MessageContent({
	children,
	className,
	text,
	markdown,
	...props
}: HTMLAttributes<HTMLDivElement> & { text?: string; markdown?: boolean }) {
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
				<MarkdownContent text={text} />
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
