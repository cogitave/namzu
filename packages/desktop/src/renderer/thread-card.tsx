import { Menu } from '@base-ui/react/menu'
import { useId, useRef } from 'react'
import {
	type BackgroundWorkStatus,
	freshBackgroundWorkStatus,
} from '../shared/background-work-protocol.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import {
	LoaderCircleIcon,
	MoreHorizontalIcon,
	ShieldQuestionIcon,
	TerminalIcon,
	TrashIcon,
} from './icons.js'
import { cn } from './lib/utils.js'
import { Button } from './ui/button.js'
import './thread-card.css'

export function ThreadCard({
	conversation,
	project,
	thread,
	backgroundWork,
	active,
	onClick,
	onRemove,
}: {
	conversation: ConversationView
	project: ProjectView
	thread?: ThreadState
	backgroundWork?: BackgroundWorkStatus
	active: boolean
	onClick: () => void
	onRemove?: (trigger: HTMLElement | null) => void
}) {
	const statusId = useId()
	const trigger = useRef<HTMLButtonElement>(null)
	const accepted = useRef(false)
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
	const work =
		conversation.palId || (conversation.harness && conversation.harness !== 'namzu')
			? { state: 'unavailable' as const }
			: freshBackgroundWorkStatus(backgroundWork)
	const workText =
		work.state === 'known' && (work.runningCount > 0 || work.needsAttention)
			? work.runningCount > 0
				? `${work.runningCount} ${work.runningCount === 1 ? 'process' : 'processes'} running in background${work.needsAttention ? '; background work needs attention' : ''}`
				: 'Background work needs attention'
			: undefined
	const threadStatus = thread?.permissions.length
		? 'Approval needed'
		: thread?.running
			? 'Running'
			: thread?.error
				? 'Needs attention'
				: undefined
	const status = [threadStatus, workText].filter(Boolean).join('; ') || undefined
	return (
		<li
			data-thread-item
			data-session-id={conversation.id}
			className="sidebar-thread-item relative list-none [content-visibility:auto] [contain-intrinsic-size:auto_32px]"
			data-removable={!!onRemove || undefined}
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
						{workText && work.state === 'known' && (
							<span
								className="thread-background-work"
								data-background-work={work.needsAttention ? 'attention' : 'running'}
								aria-hidden="true"
							>
								{work.needsAttention ? '!' : <TerminalIcon />}
							</span>
						)}
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
			{onRemove && (
				<Menu.Root
					onOpenChange={(open) => {
						if (open) accepted.current = false
					}}
				>
					<Menu.Trigger
						render={
							<Button
								variant="ghost-muted"
								size="icon-xs"
								ref={trigger}
								className="sidebar-thread-menu"
								aria-label={`Actions for ${conversation.title}`}
							/>
						}
					>
						<MoreHorizontalIcon aria-hidden="true" />
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner
							className="z-[150] outline-none"
							side="right"
							align="start"
							sideOffset={4}
						>
							<Menu.Popup
								finalFocus={() => (accepted.current ? false : (trigger.current ?? true))}
								className="window-titlebar-popup dropdown-glass min-w-44 rounded-lg p-1 text-sm text-popover-foreground shadow-xl outline-none"
							>
								<Menu.Item
									className="window-titlebar-item text-destructive-foreground"
									onClick={() => {
										accepted.current = true
										onRemove(trigger.current)
									}}
									disabled={!!thread?.running || !!thread?.permissions.length}
								>
									<TrashIcon className="size-4" aria-hidden="true" />
									<span>Delete conversation</span>
								</Menu.Item>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			)}
		</li>
	)
}
