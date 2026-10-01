import { useId } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import { LoaderCircleIcon, ShieldQuestionIcon } from './icons.js'
import { cn } from './lib/utils.js'
import './thread-card.css'

export function ThreadCard({
	conversation,
	project,
	thread,
	active,
	onClick,
}: {
	conversation: ConversationView
	project: ProjectView
	thread?: ThreadState
	active: boolean
	onClick: () => void
}) {
	const statusId = useId()
	const age = Date.now() - Date.parse(conversation.updatedAt)
	const time = !Number.isFinite(age)
		? ''
		: age < 60000
			? 'now'
			: age < 3600000
				? `${Math.floor(age / 60000)}m`
				: age < 86400000
					? `${Math.floor(age / 3600000)}h`
					: `${Math.floor(age / 86400000)}d`
	const status = thread?.permissions.length
		? 'Approval needed'
		: thread?.running
			? 'Running'
			: thread?.error
				? 'Needs attention'
				: undefined
	return (
		<li
			data-thread-item
			data-session-id={conversation.id}
			className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_32px]"
		>
			<button
				type="button"
				aria-label={conversation.title}
				aria-describedby={status ? statusId : undefined}
				aria-current={active ? 'page' : undefined}
				onClick={onClick}
				className={cn(
					'group/sidebar-row sidebar-conversation-button relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
					active
						? 'bg-sidebar-row-active text-sidebar-foreground'
						: 'bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover',
				)}
			>
				{status && (
					<span id={statusId} className="sr-only">
						{status}
					</span>
				)}
				<div className="conversation-row" title={`${conversation.title} · ${project.name}`}>
					<span className="conversation-row-title">{conversation.title}</span>
					<span className="conversation-row-state">
						{thread?.permissions.length ? (
							<ShieldQuestionIcon
								className="size-3.5 text-warning-foreground"
								aria-label="Approval needed"
							/>
						) : thread?.running ? (
							<LoaderCircleIcon
								className="thread-running-indicator"
								role="img"
								aria-label="Running"
								aria-hidden={false}
							/>
						) : (
							<span className="conversation-age">{time}</span>
						)}
						{thread?.error && (
							<span className="connection-dot error" aria-label="Needs attention" />
						)}
					</span>
				</div>
			</button>
		</li>
	)
}
