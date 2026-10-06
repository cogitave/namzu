/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import { type HTMLAttributes, memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from './lib/utils.js'

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
					// These messages cannot load remote media or start navigation.
					a: ({ children, href }) => (
						<span className="message-link" title={href}>
							{children}
						</span>
					),
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
