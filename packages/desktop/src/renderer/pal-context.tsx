import type { PalView } from '../shared/protocol.js'
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
	status: 'idle' | 'working' | 'approval' | 'paused' | 'offline'
	computer: {
		name: string
		workspace: string
		status: 'ready' | 'connecting' | 'error'
		notice?: string
	}
	activity: readonly { id: string; title: string; status?: string }[]
	outputs: readonly { id: string; label: string }[]
	onCustomize: () => void
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
	working: 'Working',
	approval: 'Waiting for your decision',
	paused: 'Paused',
	offline: 'Unavailable',
}

function PalContextBody({
	pal,
	status,
	computer,
	activity,
	outputs,
	onCustomize,
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
				</div>
			</header>
			<section className="pal-context-section" aria-label="Pal computer">
				<h3>Computer</h3>
				<div className="pal-computer-row">
					<MonitorIcon aria-hidden="true" />
					<div className="pal-context-copy">
						<strong>{computer.name}</strong>
						<output aria-live="polite">
							{computer.status === 'ready'
								? 'Connected · on this device'
								: computer.status === 'connecting'
									? 'Connecting…'
									: 'Unavailable'}
						</output>
					</div>
					{computer.status === 'connecting' && (
						<LoaderCircleIcon className="pal-context-loading" aria-label="Connecting" />
					)}
				</div>
				{computer.notice && <p className="pal-context-note">{computer.notice}</p>}
				{((onStartComputer && computer.status !== 'ready') ||
					(onOpenComputer && computer.status === 'ready')) && (
					<div className="pal-computer-actions">
						{onOpenComputer && computer.status === 'ready' ? (
							<Button variant="outline" size="sm" onClick={onOpenComputer}>
								Open computer
							</Button>
						) : (
							onStartComputer && (
								<Button
									variant="outline"
									size="sm"
									disabled={computer.status === 'connecting'}
									onClick={onStartComputer}
								>
									Start computer
								</Button>
							)
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
			{onPause && (
				<footer className="pal-context-footer">
					<Button variant="ghost-muted" size="sm" disabled={pauseDisabled} onClick={onPause}>
						{pal.paused ? 'Resume Pal' : 'Pause Pal'}
					</Button>
				</footer>
			)}
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
