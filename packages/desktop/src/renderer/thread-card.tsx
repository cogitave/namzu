import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
	type BackgroundWorkStatus,
	freshBackgroundWorkStatus,
} from '../shared/background-work-protocol.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectGitView, ProjectView } from '../shared/protocol.js'
import { ConversationContextMenu } from './conversation-actions-menu.js'
import {
	type ConversationActionId,
	type ConversationActionInput,
	archiveBlockedReason,
} from './conversation-actions.js'
import {
	ArchiveIcon,
	LoaderCircleIcon,
	PinIcon,
	PinOffIcon,
	ShieldQuestionIcon,
	TerminalIcon,
} from './icons.js'
import { cn } from './lib/utils.js'
import { createHoverIntent, relativeAge } from './sidebar-hover-card.js'
import { ThreadHoverCard } from './thread-hover-card.js'
import { Button } from './ui/button.js'
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from './ui/preview-card.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './thread-card.css'

/** What a sidebar row can do besides open: the hover buttons and the right-click menu. */
export interface ThreadRowActions {
	mac: boolean
	input: (view: ConversationView) => ConversationActionInput
	run: (id: ConversationActionId, view: ConversationView, trigger: HTMLElement | null) => void
	/** Absent when the host cannot archive; the hover button is then not offered. */
	archive?: (view: ConversationView, trigger: HTMLElement | null) => void
	/** Absent when the host cannot pin. */
	pin?: (view: ConversationView) => void
	loadGit?: (projectId: string) => Promise<ProjectGitView | null>
}

// While any row's menu is open no other row opens a card beside it.
let menusOpen = 0

export function ThreadCard({
	conversation,
	project,
	thread,
	backgroundWork,
	active,
	onClick,
	rowActions,
}: {
	conversation: ConversationView
	project: ProjectView
	thread?: ThreadState
	backgroundWork?: BackgroundWorkStatus
	active: boolean
	onClick: () => void
	rowActions?: ThreadRowActions
}) {
	const statusId = useId()
	const rowButton = useRef<HTMLButtonElement>(null)
	const time = relativeAge(conversation.updatedAt, Date.now())
	const [cardOpen, setCardOpen] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const intent = useMemo(
		() =>
			createHoverIntent({
				onOpen: () => setCardOpen(true),
				onClose: () => setCardOpen(false),
			}),
		[],
	)
	useEffect(() => () => intent.cancel(), [intent])
	useEffect(() => {
		if (!cardOpen) return
		const close = () => intent.cancel()
		window.addEventListener('scroll', close, true)
		window.addEventListener('blur', close)
		return () => {
			window.removeEventListener('scroll', close, true)
			window.removeEventListener('blur', close)
		}
	}, [cardOpen, intent])
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
	const archiveReason = archiveBlockedReason({
		running: !!thread?.running,
		queued: thread?.queued.length ?? 0,
		permissions: thread?.permissions.length ?? 0,
		backgroundRunning: work.state === 'known' ? work.runningCount : 0,
	})
	const status =
		[conversation.pinned ? 'Pinned' : undefined, threadStatus, workText]
			.filter(Boolean)
			.join('; ') || undefined
	const archiveButton = rowActions?.archive
	const pinButton = rowActions?.pin
	const actions = archiveButton || pinButton
	const rowProps = {
		'data-thread-item': true,
		'data-session-id': conversation.id,
		className:
			'sidebar-thread-item relative list-none [content-visibility:auto] [contain-intrinsic-size:auto_32px]',
		'data-removable': actions ? true : undefined,
		'data-menu-open': menuOpen || undefined,
		onPointerEnter: (event: React.PointerEvent) => {
			if (event.pointerType === 'touch' || menusOpen > 0) return
			intent.enter()
		},
		onPointerLeave: () => intent.cancel(),
		onPointerDown: () => intent.cancel(),
		onDragStart: () => intent.cancel(),
	}
	const rowChildren = (
		<>
			<PreviewCard open={cardOpen && !menuOpen} onOpenChange={() => {}}>
				<PreviewCardTrigger
					render={
						<button
							type="button"
							ref={rowButton}
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
						/>
					}
				>
					{status && (
						<span id={statusId} className="sr-only">
							{status}
						</span>
					)}
					<div className="conversation-row">
						<span className="conversation-row-title">{conversation.title}</span>
						{conversation.pinned && <PinIcon className="conversation-row-pin" aria-hidden="true" />}
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
				</PreviewCardTrigger>
				<PreviewCardPopup
					side="right"
					align="start"
					sideOffset={12}
					positionerClassName="pointer-events-none"
				>
					<ThreadHoverCard
						conversation={conversation}
						project={project}
						loadGit={rowActions?.loadGit}
					/>
				</PreviewCardPopup>
			</PreviewCard>
			{actions && (
				<div className="sidebar-thread-actions" onPointerEnter={() => intent.cancel()}>
					{pinButton && (
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost-muted"
										size="icon-xs"
										className="sidebar-thread-action"
										aria-label={conversation.pinned ? 'Unpin' : 'Pin'}
										onClick={() => pinButton(conversation)}
									/>
								}
							>
								{conversation.pinned ? (
									<PinOffIcon aria-hidden="true" />
								) : (
									<PinIcon aria-hidden="true" />
								)}
							</TooltipTrigger>
							<TooltipPopup>{conversation.pinned ? 'Unpin' : 'Pin'}</TooltipPopup>
						</Tooltip>
					)}
					{archiveButton && (
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost-muted"
										size="icon-xs"
										className="sidebar-thread-action"
										aria-label="Archive"
										aria-disabled={archiveReason ? true : undefined}
										onClick={(event) => {
											if (archiveReason) return
											archiveButton(conversation, event.currentTarget)
										}}
									/>
								}
							>
								<ArchiveIcon aria-hidden="true" />
							</TooltipTrigger>
							<TooltipPopup>{archiveReason ?? 'Archive'}</TooltipPopup>
						</Tooltip>
					)}
				</div>
			)}
		</>
	)
	if (!rowActions) return <li {...rowProps}>{rowChildren}</li>
	return (
		<ConversationContextMenu
			getInput={() => rowActions.input(conversation)}
			mac={rowActions.mac}
			label={`${conversation.title} actions`}
			render={<li {...rowProps} />}
			restoreFocus={() => rowButton.current}
			onOpenChange={(open) => {
				menusOpen = Math.max(0, menusOpen + (open ? 1 : -1))
				setMenuOpen(open)
				if (open) intent.cancel()
			}}
			onAction={(id) => rowActions.run(id, conversation, rowButton.current)}
		>
			{rowChildren}
		</ConversationContextMenu>
	)
}
