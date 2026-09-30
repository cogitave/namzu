/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import type { HTMLAttributes } from 'react'
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
			className={cn(
				'group flex w-full flex-col gap-2',
				from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
				className,
			)}
			{...props}
		/>
	)
}

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
				'is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-ui-base',
				'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground',
				'group-[.is-assistant]:text-foreground',
				className,
			)}
			{...props}
		>
			{markdown && text !== undefined ? (
				<div className="message-text markdown">
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
			) : text !== undefined ? (
				<div className="message-text">{text}</div>
			) : (
				children
			)}
		</div>
	)
}
