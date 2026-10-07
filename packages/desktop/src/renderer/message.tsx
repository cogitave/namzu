/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import {
	type ComponentPropsWithoutRef,
	type HTMLAttributes,
	type ReactNode,
	createContext,
	memo,
	useContext,
	useState,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../shared/protocol.js'
import { cn } from './lib/utils.js'

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

function MessageLink({ children, href }: { children?: ReactNode; href?: string }) {
	const [failed, setFailed] = useState(false)
	const url = externalWebUrl(href)
	if (!url || typeof window === 'undefined' || !window.namzu?.openExternal)
		return (
			<span className="message-link" title={href}>
				{children}
			</span>
		)
	return (
		<>
			<a
				className="message-link"
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				onClick={(event) => {
					event.preventDefault()
					void window.namzu.openExternal?.(url).catch(() => setFailed(true))
				}}
			>
				{children}
			</a>
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
	node: _node,
	children,
	...props
}: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
	return (
		<CodeBlockContext.Provider value={true}>
			<pre {...props}>{children}</pre>
		</CodeBlockContext.Provider>
	)
}

function MarkdownCode({
	node: _node,
	children,
	...props
}: ComponentPropsWithoutRef<'code'> & { node?: unknown }) {
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

export function MessageTime({
	time,
	focusable = false,
}: { time?: ChatMessage['time']; focusable?: boolean }) {
	const [expanded, setExpanded] = useState(false)
	if (!time || !Number.isFinite(time.at) || time.at < 0 || time.at > 8_640_000_000_000_000)
		return null
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
	return (
		<div className="message-text chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] [word-break:break-word]">
			<Markdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				components={{
					// Remote media stays inert; web links require the owned main bridge.
					a: MessageLink,
					pre: MarkdownPre,
					code: MarkdownCode,
					img: ({ alt }) => <span className="notice">{alt || 'Image'}</span>,
					table: ({ children }) => (
						<div className="table-scroll">
							<table>{children}</table>
						</div>
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
