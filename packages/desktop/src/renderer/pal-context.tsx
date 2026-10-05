import type { PalScreenView, PalView } from '../shared/protocol.js'
import {
	ConversationIcon,
	FileTextIcon,
	LoaderCircleIcon,
	MonitorIcon,
	PencilIcon,
} from './icons.js'
import { PalCharacter3D } from './pal-character-3d.js'
import { PalCharacter, type PalCharacterAppearance } from './pal-character.js'
import { Button } from './ui/button.js'
import './pal-context.css'

export interface PalContextProps {
	pal: PalView
	status: 'idle' | 'working' | 'approval' | 'paused' | 'offline' | 'operator'
	computer: {
		name: string
		workspace: string
		status: 'ready' | 'connecting' | 'error'
		notice?: string
		screen?: PalScreenView | null
		loading?: boolean
	}
	/** Supplied only when the native host has reported its actual identity. */
	hostComputer?: { name: string }
	activity: readonly { id: string; title: string; status?: string }[]
	outputs: readonly { id: string; label: string }[]
	onCustomize: () => void
	onCommunication?: (trigger: HTMLButtonElement) => void
	onActivity: (id: string) => void
	onOutput: (id: string) => void
	onPause?: () => void
	pauseDisabled?: boolean
	customizeDisabled?: boolean
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
}: { name: string; compact?: boolean; appearance?: PalCharacterAppearance; paused?: boolean }) {
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

function PalContextBody({
	pal,
	status,
	computer,
	hostComputer,
	activity,
	outputs,
	onCustomize,
	onCommunication,
	onActivity,
	onOutput,
	onPause,
	pauseDisabled,
	customizeDisabled,
	onStartComputer,
	onOpenComputer,
	onStopComputer,
	stopComputerDisabled,
}: PalContextProps) {
	const pauseLabel = `${pal.paused ? 'Resume' : 'Pause'} ${pal.name}`
	const computerStatus =
		computer.status === 'ready'
			? 'Connected'
			: computer.status === 'connecting'
				? 'Connecting…'
				: 'Offline'
	const inlineStop = computer.status === 'ready' && !!onStopComputer
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
					{onPause ? (
						<>
							<output className="sr-only" aria-live="polite">
								{statusLabels[status]}
							</output>
							<Button
								variant="ghost-muted"
								className="pal-context-status pal-status-action"
								aria-label={pauseLabel}
								disabled={pauseDisabled}
								onClick={onPause}
							>
								<span className="pal-status-rest" aria-hidden="true">
									{status === 'working' && <LoaderCircleIcon className="pal-context-loading" />}
									<span>{statusLabels[status]}</span>
								</span>
								<span className="pal-status-hover" aria-hidden="true">
									<span>{pauseLabel}</span>
								</span>
							</Button>
						</>
					) : (
						<output className="pal-context-status" aria-live="polite">
							{status === 'working' && <LoaderCircleIcon className="pal-context-loading" />}
							{statusLabels[status]}
						</output>
					)}
				</div>
			</header>
			{onCommunication && (
				<section className="pal-context-section" aria-label="Pal communication">
					<Button
						variant="ghost"
						className="pal-context-row pal-communication-entry"
						onClick={(event) => onCommunication(event.currentTarget)}
					>
						<ConversationIcon aria-hidden="true" />
						<span>Communication</span>
					</Button>
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
							<span
								className={`pal-computer-status${inlineStop ? ' pal-computer-status-placeholder' : ''}`}
								aria-hidden={inlineStop || undefined}
							>
								{computerStatus}
							</span>
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
					{inlineStop && (
						<>
							<output className="sr-only" aria-live="polite">
								{computerStatus}
							</output>
							<Button
								variant="ghost-muted"
								className="pal-status-action pal-computer-stop"
								aria-label="Stop computer"
								disabled={stopComputerDisabled}
								onClick={onStopComputer}
							>
								<span className="pal-status-rest" aria-hidden="true">
									<span>{computerStatus}</span>
								</span>
								<span className="pal-status-hover" aria-hidden="true">
									<span>Stop computer</span>
								</span>
							</Button>
						</>
					)}
				</div>
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
				{computer.notice && <p className="pal-context-note">{computer.notice}</p>}
				{computer.status !== 'ready' && (onStartComputer || onStopComputer) && (
					<div className="pal-computer-actions">
						{onStartComputer && (
							<Button
								variant="outline"
								size="sm"
								disabled={computer.status === 'connecting'}
								onClick={onStartComputer}
							>
								Start computer
							</Button>
						)}
						{onStopComputer && (
							<Button
								variant="ghost-muted"
								size="sm"
								onClick={onStopComputer}
								disabled={stopComputerDisabled}
							>
								Stop computer
							</Button>
						)}
					</div>
				)}
			</section>
			<section className="pal-context-section" aria-label="Recent activity">
				<h3>Recent activity</h3>
				{activity.length === 0 ? (
					<p className="pal-context-empty">No activity yet</p>
				) : (
					<ul className="pal-context-list">
						{activity.slice(0, 5).map((item) => (
							<li key={item.id}>
								<Button
									variant="ghost"
									className="pal-context-row"
									onClick={() => onActivity(item.id)}
								>
									<ConversationIcon aria-hidden="true" />
									<span title={item.title}>{item.title}</span>
									{item.status === 'working' || item.status === 'running' ? (
										<LoaderCircleIcon className="pal-context-loading" />
									) : null}
								</Button>
							</li>
						))}
					</ul>
				)}
			</section>
			<section className="pal-context-section" aria-label="Outputs">
				<h3>Outputs</h3>
				{outputs.length === 0 ? (
					<p className="pal-context-empty">No outputs yet</p>
				) : (
					<ul className="pal-context-list">
						{outputs.slice(0, 5).map((item) => (
							<li key={item.id}>
								<Button
									variant="ghost"
									className="pal-context-row"
									onClick={() => onOutput(item.id)}
								>
									<FileTextIcon aria-hidden="true" />
									<span title={item.label}>{item.label}</span>
								</Button>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	)
}

export function PalContextCard(props: PalContextProps) {
	return (
		<aside className="pal-context-card" aria-label="Pal context">
			<PalContextBody {...props} />
		</aside>
	)
}
