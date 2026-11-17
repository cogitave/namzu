import { type ReactNode, useState } from 'react'
import type { JobView } from '../shared/protocol.js'
import {
	ChevronRightIcon,
	FileDiffIcon,
	FolderIcon,
	GitBranchIcon,
	MonitorIcon,
	ServerIcon,
	SquareIcon,
	TerminalIcon,
	XIcon,
} from './icons.js'
import { jobLabel, jobStatusOf } from './job-row.js'
import { type SessionSummary, finishedText, jobElapsed } from './session-summary-model.js'
import { Button } from './ui/button.js'
import './session-panel.css'

export interface SessionPanelProps {
	summary: SessionSummary
	/** The conversation has no folder of its own: only Context and Background tasks are drawn. */
	chatOnly?: boolean
	jobs: readonly JobView[]
	/** False while the job list is being read or could not be. */
	jobsKnown: boolean
	/** The clock the running times are read against; the parent ticks it while a job runs. */
	now: number
	onClose: () => void
	onCopyPath?: () => void
	onOpenChanges: () => void
	onOpenWork: () => void
	onStopJob?: (job: JobView) => Promise<unknown>
	/** The commit action, drawn beside the totals. */
	commit?: ReactNode
}

function Section({
	title,
	children,
	aside,
}: { title: string; children: ReactNode; aside?: ReactNode }) {
	return (
		<section className="session-section" aria-label={title}>
			<div className="session-section-head">
				<h3>{title}</h3>
				{aside}
			</div>
			{children}
		</section>
	)
}

function StopButton({ job, onStop }: { job: JobView; onStop: () => Promise<unknown> }) {
	const [stopping, setStopping] = useState(false)
	const label = jobLabel(job)
	return (
		<Button
			variant="ghost-destructive"
			size="icon-xs"
			className="session-job-stop"
			disabled={stopping}
			aria-label={`Stop ${label}`}
			title={stopping ? 'Stopping…' : 'Stop'}
			onClick={() => {
				setStopping(true)
				void onStop().finally(() => setStopping(false))
			}}
		>
			<SquareIcon aria-hidden="true" />
		</Button>
	)
}

/** The conversation's state at a glance, in a column beside it. Draws only what the summary says. */
export function SessionPanel({
	summary,
	chatOnly = false,
	jobs,
	jobsKnown,
	now,
	onClose,
	onCopyPath,
	onOpenChanges,
	onOpenWork,
	onStopJob,
	commit,
}: SessionPanelProps) {
	const [serversOpen, setServersOpen] = useState(false)
	const [finishedOpen, setFinishedOpen] = useState(false)
	const { environment, context, toolServers, changes, background } = summary
	const running = jobs.filter((job) => job.status === 'running')
	const finished = jobs.filter((job) => job.status !== 'running')
	const finishedLine = finishedText(jobsKnown ? finished.length : background.finished)
	return (
		<div className="session-panel" data-testid="session-panel">
			<div className="session-panel-head">
				<h2>Session</h2>
				<Button
					variant="ghost-muted"
					size="icon-xs"
					aria-label="Close the session panel"
					title="Close"
					onClick={onClose}
				>
					<XIcon aria-hidden="true" />
				</Button>
			</div>
			<div className="session-panel-body">
				{!chatOnly && (
					<Section title="Environment">
						<div className="session-row">
							<MonitorIcon aria-hidden="true" />
							<span className="session-label">{environment.host}</span>
						</div>
						{environment.folder && (
							<button
								type="button"
								className="session-row session-row-button"
								title={`${environment.folder.path}\nCopy the path`}
								onClick={onCopyPath}
							>
								<FolderIcon aria-hidden="true" />
								<span className="session-label">{environment.folder.name}</span>
								<span className="session-value session-path">{environment.folder.path}</span>
							</button>
						)}
						{environment.branch && (
							<div className="session-row" title={environment.branch.title}>
								<GitBranchIcon aria-hidden="true" />
								<span className="session-label">{environment.branch.text}</span>
							</div>
						)}
						{environment.branchNote && <p className="session-note">{environment.branchNote}</p>}
					</Section>
				)}
				<Section title="Context">
					<div className="session-row" data-testid="session-context">
						<span
							className="session-bar"
							data-tone={context.tone}
							data-measured={context.measured || undefined}
							aria-hidden="true"
						>
							<span style={{ width: `${Math.round(context.fraction * 100)}%` }} />
						</span>
						<span className="session-value">{context.text}</span>
					</div>
				</Section>
				{!chatOnly && toolServers && (
					<Section title={toolServers.label}>
						<button
							type="button"
							className="session-row session-row-button"
							aria-expanded={serversOpen}
							disabled={toolServers.rows.length === 0}
							onClick={() => setServersOpen((value) => !value)}
						>
							<ServerIcon aria-hidden="true" />
							<span className="session-label">{toolServers.count}</span>
							{toolServers.rows.length > 0 && (
								<ChevronRightIcon
									className="session-chevron"
									data-open={serversOpen || undefined}
									aria-hidden="true"
								/>
							)}
						</button>
						{toolServers.attention && (
							<p className="session-note" data-tone="warning">
								{toolServers.attention}
							</p>
						)}
						{serversOpen && (
							<ul className="session-list">
								{toolServers.rows.map((row) => (
									<li key={row.name} data-state={row.state} title={row.detail ?? row.where}>
										<span className="session-label">{row.name}</span>
										<span className="session-value">{row.stateLabel}</span>
									</li>
								))}
							</ul>
						)}
					</Section>
				)}
				{!chatOnly && (
					<Section title="Changes">
						<div className="session-row session-changes">
							<button
								type="button"
								className="session-changes-open"
								title={changes.note}
								onClick={onOpenChanges}
							>
								<FileDiffIcon aria-hidden="true" />
								{changes.hasChanges ? (
									<span className="session-totals">
										<span className="session-added">
											<span aria-hidden="true">+</span>
											<span className="sr-only">Added </span>
											{changes.added}
										</span>
										<span className="session-removed">
											<span aria-hidden="true">−</span>
											<span className="sr-only">Removed </span>
											{changes.removed}
										</span>
									</span>
								) : (
									<span className="session-value">{changes.empty}</span>
								)}
							</button>
							{commit}
						</div>
					</Section>
				)}
				<Section title="Background tasks">
					{!jobsKnown && (
						<button type="button" className="session-row session-row-button" onClick={onOpenWork}>
							<TerminalIcon aria-hidden="true" />
							<span className="session-label" data-attention={background.attention || undefined}>
								{background.text}
							</span>
						</button>
					)}
					{jobsKnown && running.length === 0 && finished.length === 0 && (
						<p className="session-note">None</p>
					)}
					{jobsKnown && (
						<ul className="session-list" data-testid="session-jobs">
							{running.map((job) => (
								<li key={`${job.id}:${job.startedAt}`} data-state="running">
									<TerminalIcon aria-hidden="true" />
									<span className="session-label" title={jobLabel(job)}>
										{jobLabel(job)}
									</span>
									<span className="session-value" data-testid="session-job-time">
										{jobElapsed(job.startedAt, now)}
									</span>
									{onStopJob && <StopButton job={job} onStop={() => onStopJob(job)} />}
								</li>
							))}
						</ul>
					)}
					{finishedLine && (
						<button
							type="button"
							className="session-row session-row-button"
							aria-expanded={finishedOpen}
							disabled={!jobsKnown}
							onClick={() => setFinishedOpen((value) => !value)}
						>
							<span className="session-label">{finishedLine}</span>
							{jobsKnown && (
								<ChevronRightIcon
									className="session-chevron"
									data-open={finishedOpen || undefined}
									aria-hidden="true"
								/>
							)}
						</button>
					)}
					{jobsKnown && finishedOpen && (
						<ul className="session-list">
							{finished.map((job) => (
								<li key={`${job.id}:${job.startedAt}`} data-state="finished">
									<span className="session-label" title={jobLabel(job)}>
										{jobLabel(job)}
									</span>
									<span className="session-value">{jobStatusOf(job).label}</span>
								</li>
							))}
						</ul>
					)}
				</Section>
			</div>
		</div>
	)
}
