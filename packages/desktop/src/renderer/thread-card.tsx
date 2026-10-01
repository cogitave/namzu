/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import { ShieldQuestionIcon } from 'lucide-react'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { cn } from './lib/utils.js'

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
	return (
		<li
			data-thread-item
			className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_34px]"
		>
			<button
				type="button"
				aria-label={conversation.title}
				aria-current={active ? 'page' : undefined}
				onClick={onClick}
				className={cn(
					'group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
					active
						? 'bg-sidebar-row-active text-sidebar-foreground'
						: 'bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover',
				)}
			>
				<div className="conversation-row" title={`${conversation.title} · ${project.name}`}>
					<span className="conversation-row-title">{conversation.title}</span>
					<span className="conversation-row-state">
						{thread?.permissions.length ? (
							<ShieldQuestionIcon
								className="size-3.5 text-warning-foreground"
								aria-label="Approval needed"
							/>
						) : thread?.running ? (
							<span className="activity" aria-label="Working" />
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
