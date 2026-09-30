/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import { FolderIcon, MessageSquareIcon, ShieldQuestionIcon } from 'lucide-react'
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
			className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]"
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
				<div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
					<div className="flex h-5 min-w-0 items-center gap-1.5">
						<FolderIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
						<span className="min-w-0 flex-1 truncate text-secondary-label text-xs font-medium">
							{project.name}
						</span>
						<span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-secondary-label tabular-nums">
							{thread?.permissions.length ? (
								<ShieldQuestionIcon
									className="size-3.5 text-warning-foreground"
									aria-label="Approval needed"
								/>
							) : thread?.running ? (
								<span className="activity" aria-label="Working" />
							) : (
								time
							)}
						</span>
					</div>
					<div className="mt-1 flex min-w-0">
						<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90 transition-opacity motion-reduce:transition-none">
							{conversation.title}
						</span>
					</div>
					<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
						<MessageSquareIcon className="size-3 shrink-0 text-muted-foreground/40" />
						<span className="min-w-0 flex-1 truncate text-muted-foreground/40">
							{thread?.error
								? 'Needs attention'
								: thread?.running
									? 'Working'
									: 'Local conversation'}
						</span>
					</div>
				</div>
			</button>
		</li>
	)
}
