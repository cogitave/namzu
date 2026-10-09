import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { PalScreenView, PalView } from '../shared/protocol.js'
import { ConversationTasks } from './conversation-tasks.js'
import {
	ChevronRightIcon,
	ConversationIcon,
	FileTextIcon,
	HistoryIcon,
	LoaderCircleIcon,
	MonitorIcon,
	PencilIcon,
	SettingsIcon,
	UserRoundIcon,
	XIcon,
} from './icons.js'
import { PalCharacter3D } from './pal-character-3d.js'
import { PalCharacter, type PalCharacterAppearance } from './pal-character.js'
import { COMPUTER_SETUP_NOTICE } from './pal-computer-notice.js'
import type { PalRecentAction } from './pal-recent-activity.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import './pal-context.css'

export interface PalContextProps {
	pal: PalView
	status: 'idle' | 'working' | 'approval' | 'paused' | 'offline' | 'operator'
	computer: {
		name: string
		workspace: string
		status: 'ready' | 'connecting' | 'error'
		notice?: string
		/** The computer cannot start until Docker or Podman is set up, so Start is switched off. */
		setupMissing?: boolean
		screen?: PalScreenView | null
		loading?: boolean
	}
	/** Supplied only when the native host has reported its actual identity. */
	hostComputer?: { name: string }
	activity: readonly PalRecentAction[]
	outputs: readonly { id: string; label: string; content?: ReactNode }[]
	tasks?: Pick<ThreadState, 'tasks' | 'tasksNotice'>
	onCustomize: () => void
	onCommunication?: (trigger: HTMLButtonElement) => void
	onPause?: () => void
	pauseDisabled?: boolean
	customizeDisabled?: boolean
	/** Messages waiting for the person's go, with the one action that moves them on. */
	waiting?: {
		text: string
		action: 'start' | 'resume' | 'retry' | null
		blocked?: { text: string; help: string }
	} | null
	onWaitingAction?: (action: 'start' | 'resume' | 'retry') => void
	/** Hides a failed start that is no longer current; the messages keep waiting. */
	onDismissWaiting?: () => void
	onStartComputer?: () => void
	onOpenComputer?: () => void
	onStopComputer?: () => void
	stopComputerDisabled?: boolean
}

/** Character identity does not indicate computer connection state. */
export function PalAvatar({
	name,
	compact = false,
	appearance,
	paused,
}: {
	name: string
	compact?: boolean
	appearance?: PalCharacterAppearance
	paused?: boolean
}) {
	return (
		<span
			className={`pal-avatar${compact ? ' pal-avatar-compact' : ''}`}
			title={name}
			aria-hidden="true"
		>
			<PalCharacter appearance={appearance} size={compact ? 'compact' : 'avatar'} paused={paused} />
		</span>
	)
}

const statusLabels: Record<PalContextProps['status'], string> = {
	idle: 'Ready to chat',
	operator: 'You have control',
	working: 'Working',
	approval: 'Waiting for your decision',
	paused: 'Paused',
	offline: 'Unavailable',
}

function computerStatusLabel(status: PalContextProps['computer']['status']) {
	return status === 'ready' ? 'Connected' : status === 'connecting' ? 'Starting…' : 'Offline'
}

/** What is missing, and a way to read how to set it up without leaving the page. */
function SetupHelp({ text, help }: { text?: string; help: string }) {
	return (
		<>
			{text && <p className="pal-context-note">{text}</p>}
			<details className="pal-setup-help">
				<summary>How to set up</summary>
				<p>{help}</p>
			</details>
		</>
	)
}

function PalContextBody({
	pal,
	status,
	computer,
	hostComputer,
	activity,
	outputs,
	tasks,
	onCustomize,
	onCommunication,
	onPause,
	pauseDisabled,
	customizeDisabled,
	waiting,
	onWaitingAction,
	onDismissWaiting,
	onStartComputer,
	onOpenComputer,
	onStopComputer,
	stopComputerDisabled,
}: PalContextProps) {
	const pauseLabel = `${pal.paused ? 'Resume' : 'Pause'} ${pal.name}`
	const computerStatus = computerStatusLabel(computer.status)
	// The status line always says what the computer is. The action is its own button, so choosing
	// it can never replace the status with the action's name.
	// There is one Start. It starts the computer when that is needed, and reads waiting messages when
	// there are some, so the Pal's own page never offers a second start next to the message one.
	const messageStart = waiting?.action === 'start'
	const computerAction =
		computer.status !== 'connecting' && onStopComputer
			? { label: 'Stop computer', onClick: onStopComputer, disabled: stopComputerDisabled }
			: computer.status === 'error' && onStartComputer && !messageStart
				? {
						label: `Start ${pal.name}`,
						onClick: onStartComputer,
						disabled: Boolean(computer.setupMissing),
					}
				: undefined
	return (
		<div className="pal-context-body">
			<header className="pal-context-heading">
				<div className="pal-context-avatar">
					<PalCharacter3D appearance={pal.appearance} size="avatar" paused={pal.paused} />
					<Button
						variant="secondary"
						size="icon-xs"
						className="pal-context-edit"
						aria-label={`Customize ${pal.name}`}
						disabled={customizeDisabled}
						onClick={onCustomize}
					>
						<PencilIcon />
					</Button>
				</div>
				<div className="pal-context-identity">
					<h2 title={pal.name}>{pal.name}</h2>
					<output className="pal-context-status" aria-live="polite">
						{status === 'working' && <LoaderCircleIcon className="pal-context-loading" />}
						{statusLabels[status]}
					</output>
					{onPause && (
						<Button
							variant="outline"
							size="xs"
							className="pal-pause-action"
							aria-label={pauseLabel}
							disabled={pauseDisabled}
							onClick={onPause}
						>
							{pal.paused ? 'Resume' : 'Pause'}
						</Button>
					)}
				</div>
				{onCommunication && (
					<Button
						variant="ghost-muted"
						size="icon-sm"
						className="pal-context-settings"
						aria-label={`${pal.name} settings`}
						title={`${pal.name} settings`}
						aria-haspopup="dialog"
						onClick={(event) => onCommunication(event.currentTarget)}
					>
						<SettingsIcon aria-hidden="true" />
					</Button>
				)}
			</header>
			{waiting && (
				<section className="pal-context-section pal-waiting" aria-label="Waiting messages">
					<output className="pal-waiting-line" aria-live="polite">
						{waiting.text}
					</output>
					{waiting.action && onWaitingAction && (
						<Button
							variant="outline"
							size="xs"
							className="pal-waiting-action"
							disabled={Boolean(waiting.blocked)}
							onClick={() => onWaitingAction(waiting.action as 'start' | 'resume' | 'retry')}
						>
							{waiting.action === 'resume'
								? `Resume ${pal.name}`
								: waiting.action === 'retry'
									? 'Retry'
									: `Start ${pal.name}`}
						</Button>
					)}
					{waiting.action === 'retry' && onDismissWaiting && (
						<Button variant="ghost-muted" size="xs" onClick={onDismissWaiting}>
							Dismiss
						</Button>
					)}
					{waiting.blocked && <SetupHelp text={waiting.blocked.text} help={waiting.blocked.help} />}
				</section>
			)}
			<section className="pal-context-section" aria-label="Pal computers">
				<h3>Computers</h3>
				<div className="pal-computer-entry">
					<Button
						variant="ghost"
						className="pal-computer-row pal-computer-open"
						disabled={!onOpenComputer}
						onClick={onOpenComputer}
						aria-label={`Open ${computer.name}`}
					>
						<span className="pal-computer-icon" data-connected={computer.status === 'ready'}>
							<MonitorIcon aria-hidden="true" />
						</span>
						<span className="pal-context-copy">
							<strong title={computer.name}>{computer.name}</strong>
							<span className="pal-computer-status">{computerStatus}</span>
						</span>
						<span className="pal-computer-thumbnail" aria-hidden="true">
							{computer.screen && computer.status === 'ready' ? (
								<img src={computer.screen.source} alt="" draggable={false} />
							) : computer.loading || computer.status === 'connecting' ? (
								<LoaderCircleIcon className="pal-context-loading" />
							) : (
								<MonitorIcon />
							)}
						</span>
					</Button>
					{computerAction && (
						<Button
							variant="outline"
							size="xs"
							className="pal-computer-action"
							disabled={computerAction.disabled}
							onClick={computerAction.onClick}
						>
							{computerAction.label}
						</Button>
					)}
				</div>
				{computerAction?.disabled && computerAction.label !== 'Stop computer' && (
					<SetupHelp help={COMPUTER_SETUP_NOTICE} />
				)}
				{computer.notice && !computer.setupMissing && (
					<p className="pal-context-note">{computer.notice}</p>
				)}
				{computer.notice && computer.setupMissing && !waiting?.blocked && (
					<p className="pal-context-note">
						{computer.name} cannot start yet: it needs Docker Desktop or Podman, and neither is
						ready on this computer.
					</p>
				)}
				{computer.status !== 'ready' && (
					<p className="pal-context-note">Chatting works without a computer.</p>
				)}
				{hostComputer?.name.trim() && (
					<div className="pal-computer-row pal-host-computer">
						<span className="pal-computer-icon">
							<MonitorIcon aria-hidden="true" />
						</span>
						<div className="pal-context-copy">
							<strong title={hostComputer.name}>{hostComputer.name}</strong>
							<span className="pal-computer-status">Your computer</span>
						</div>
					</div>
				)}
			</section>
			{tasks && (tasks.tasks.length > 0 || tasks.tasksNotice) && (
				<div className="pal-context-section pal-context-tasks">
					<ConversationTasks key={pal.id} thread={tasks} palName={pal.name} />
				</div>
			)}
			{activity.length > 0 && (
				<section className="pal-context-section" aria-label="Recent activity">
					<h3>Recent activity</h3>
					<ul className="pal-context-list">
						{activity.slice(0, 5).map((item) => {
							const Icon =
								item.status === 'working'
									? LoaderCircleIcon
									: item.status === 'failed'
										? XIcon
										: item.category === 'message'
											? ConversationIcon
											: item.category === 'pals'
												? UserRoundIcon
												: item.category === 'file'
													? FileTextIcon
													: item.category === 'computer'
														? MonitorIcon
														: HistoryIcon
							return (
								<li key={item.id}>
									<div className="pal-context-row pal-recent-action" data-status={item.status}>
										<Icon
											aria-hidden="true"
											className={item.status === 'working' ? 'pal-context-loading' : undefined}
										/>
										<span className="pal-recent-copy">
											<span>{item.title}</span>
											<span className="pal-recent-detail">{item.detail}</span>
										</span>
									</div>
								</li>
							)
						})}
					</ul>
				</section>
			)}
			{outputs.length > 0 && (
				<section className="pal-context-section" aria-label="Outputs">
					<h3>Outputs</h3>
					<ul className="pal-context-list">
						{outputs.slice(0, 5).map((item) => (
							<li key={item.id}>
								{item.content ? (
									<Collapsible>
										<CollapsibleTrigger
											render={<Button variant="ghost" className="pal-context-row" />}
										>
											<FileTextIcon aria-hidden="true" />
											<span title={item.label}>{item.label}</span>
											<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
										</CollapsibleTrigger>
										<CollapsiblePanel>
											<div className="pal-output-details">{item.content}</div>
										</CollapsiblePanel>
									</Collapsible>
								) : (
									<div className="pal-context-row">
										<FileTextIcon aria-hidden="true" />
										<span title={item.label}>{item.label}</span>
									</div>
								)}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	)
}

export function PalContextCard(props: PalContextProps) {
	const card = useRef<HTMLElement>(null)
	const compactSettings = useRef<HTMLButtonElement>(null)
	const [compact, setCompact] = useState(false)
	const [open, setOpen] = useState(false)
	useLayoutEffect(() => {
		const stage = card.current?.parentElement
		if (!stage?.classList.contains('chat-stage')) return
		const update = () => {
			const narrow = stage.getBoundingClientRect().width < 720
			setCompact(narrow)
			if (!narrow) setOpen(false)
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(stage)
		return () => observer.disconnect()
	}, [])
	const compactBodyProps: PalContextProps = {
		...props,
		onCustomize: () => {
			setOpen(false)
			props.onCustomize()
		},
		onCommunication: props.onCommunication
			? () => {
					const trigger = compactSettings.current
					if (!trigger) return
					setOpen(false)
					props.onCommunication?.(trigger)
				}
			: undefined,
		onOpenComputer: props.onOpenComputer
			? () => {
					setOpen(false)
					props.onOpenComputer?.()
				}
			: undefined,
	}
	return (
		<aside className="pal-context-card" aria-label="Pal context" data-compact={compact} ref={card}>
			{compact ? (
				<div className="pal-context-compact-bar">
					<Popover open={open} onOpenChange={setOpen}>
						<PopoverTrigger
							render={<Button variant="ghost-muted" className="pal-context-compact-trigger" />}
							aria-label={`Show ${props.pal.name} details, ${statusLabels[props.status]}, computer ${computerStatusLabel(props.computer.status)}`}
						>
							<PalAvatar
								name={props.pal.name}
								appearance={props.pal.appearance}
								compact
								paused={props.pal.paused}
							/>
							<strong title={props.pal.name}>{props.pal.name}</strong>
							<span className="pal-context-compact-status">{statusLabels[props.status]}</span>
							<span className="pal-context-compact-computer">
								<MonitorIcon aria-hidden="true" />
								{computerStatusLabel(props.computer.status)}
							</span>
							<ChevronRightIcon className="pal-context-compact-chevron" aria-hidden="true" />
						</PopoverTrigger>
						<PopoverPopup
							aria-label={`${props.pal.name} details`}
							align="start"
							padding="none"
							width="md"
							className="pal-context-popup"
						>
							<PalContextBody {...compactBodyProps} />
						</PopoverPopup>
					</Popover>
					{props.onCommunication && (
						<Button
							ref={compactSettings}
							variant="outline"
							size="sm"
							className="pal-context-compact-settings"
							aria-label={`${props.pal.name} settings`}
							aria-haspopup="dialog"
							onClick={() => {
								setOpen(false)
								props.onCommunication?.(compactSettings.current as HTMLButtonElement)
							}}
						>
							<SettingsIcon aria-hidden="true" />
							Settings
						</Button>
					)}
				</div>
			) : (
				<PalContextBody {...props} />
			)}
		</aside>
	)
}
