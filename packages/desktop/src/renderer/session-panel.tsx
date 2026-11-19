import { Menu } from '@base-ui/react/menu'
import { type ReactNode, useState } from 'react'
import type { ComputerAppsView } from '../shared/computer-protocol.js'
import type { ThreadUsage } from '../shared/projection.js'
import type { JobView } from '../shared/protocol.js'
import { ContextInline, type ContextPanelSource, useContextPanel } from './context-panel.js'
import type { ConversationSource } from './conversation-actions.js'
import { FileTypeIcon } from './file-panel/file-icons.js'
import {
	ArchiveIcon,
	ChevronRightIcon,
	FileDiffIcon,
	FileTextIcon,
	FolderIcon,
	GitBranchIcon,
	GitCommitIcon,
	ImageIcon,
	MonitorIcon,
	MoreHorizontalIcon,
	PlusIcon,
	ServerIcon,
	SquareIcon,
	TerminalIcon,
	XIcon,
} from './icons.js'
import { jobLabel, jobStatusOf } from './job-row.js'
import { MENU_OFFSET } from './menu-metrics.js'
import type { OutputFile } from './outputs-model.js'
import { middleEllipsis, tildePath } from './path-display.js'
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
	/** Files attached to the conversation so far; the section is drawn only when this is given. */
	sources?: readonly ConversationSource[]
	/** Why the "+" beside Sources is unavailable, or undefined when it works. */
	attachReason?: string
	onAttach?: () => void
	/** Switches the sidebar to the archived conversations; absent when the host cannot list them. */
	onOpenArchived?: () => void
	/** The applications this conversation has allowed and used; absent until the agent has worked in one. */
	apps?: ComputerAppsView | undefined
	/** Takes an application back; absent when the host cannot. */
	onRevokeApp?: (app: string) => void
	/** A detached head has no branch name; the row then shows a commit mark. */
	detached?: boolean
	/** Lets Context read the full breakdown; without it only the bar and the figure are drawn. */
	contextPanel?: ContextPanelSource | undefined
	usage?: ThreadUsage | undefined
	/** What this conversation made, newest first; the section is drawn only when there is one. */
	outputs?: readonly OutputFile[]
	/** Opens one output where its kind belongs: a page in the browser, a document or code in Files. */
	onOpenOutput?: (file: OutputFile) => void
}

const COLLAPSED_SOURCES = 3

/** The folder row's "…": copy the path, or look at the archived conversations. */
function FolderActions({
	onCopyPath,
	onOpenArchived,
}: { onCopyPath?: (() => void) | undefined; onOpenArchived?: (() => void) | undefined }) {
	if (!onCopyPath && !onOpenArchived) return null
	return (
		<Menu.Root>
			<Menu.Trigger
				render={<Button variant="ghost-muted" size="icon-xs" className="session-folder-more" />}
				aria-label="Folder actions"
			>
				<MoreHorizontalIcon aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					className="conversation-actions-positioner"
					align="end"
					sideOffset={MENU_OFFSET}
				>
					<Menu.Popup className="conversation-actions-popup" aria-label="Folder actions">
						{onCopyPath && (
							<Menu.Item className="conversation-actions-item" onClick={onCopyPath}>
								<FolderIcon aria-hidden="true" />
								<span className="conversation-actions-label">Copy path</span>
							</Menu.Item>
						)}
						{onOpenArchived && (
							<Menu.Item className="conversation-actions-item" onClick={onOpenArchived}>
								<ArchiveIcon aria-hidden="true" />
								<span className="conversation-actions-label">Archived conversations</span>
							</Menu.Item>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

function AppRow({
	app,
	allowed,
	onRevoke,
}: { app: string; allowed: boolean; onRevoke?: ((app: string) => void) | undefined }) {
	return (
		<li data-testid="computer-app-row">
			<span className="session-label">{app}</span>
			<span className="session-value">{allowed ? 'Allowed' : 'Used'}</span>
			{allowed && onRevoke && (
				<button
					type="button"
					className="session-link"
					aria-label={`Take back access to ${app}`}
					onClick={() => onRevoke(app)}
				>
					Take back
				</button>
			)}
		</li>
	)
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

/** The breakdown of the context window, read while the panel is open and drawn with no frame. */
function ContextBreakdown({
	source,
	usage,
}: { source: ContextPanelSource; usage: ThreadUsage | undefined }) {
	const read = useContextPanel(source, usage, true)
	return (
		<section className="session-section session-context-section" aria-label="Context">
			<ContextInline read={read} usage={usage} compacting={source.compacting} />
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
	detached,
	sources,
	attachReason,
	onAttach,
	onOpenArchived,
	apps,
	onRevokeApp,
	contextPanel,
	usage,
	outputs,
	onOpenOutput,
}: SessionPanelProps) {
	const [serversOpen, setServersOpen] = useState(false)
	const [showAllSources, setShowAllSources] = useState(false)
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
					className="pane-control"
					aria-label="Close the session panel"
					title="Close"
					onClick={onClose}
				>
					<XIcon aria-hidden="true" />
				</Button>
			</div>
			<div className="session-panel-body">
				<Section title="Environment">
					<div className="session-row">
						<MonitorIcon aria-hidden="true" />
						<span className="session-label">{environment.host}</span>
					</div>
					{environment.folder && (
						<div className="session-folder">
							<button
								type="button"
								className="session-row session-row-button"
								title={`${environment.folder.path}\nCopy the path`}
								onClick={onCopyPath}
							>
								<FolderIcon aria-hidden="true" />
								<span className="session-label">{environment.folder.name}</span>
								<span className="session-value session-path">
									{middleEllipsis(tildePath(environment.folder.path))}
								</span>
							</button>
							<FolderActions onCopyPath={onCopyPath} onOpenArchived={onOpenArchived} />
						</div>
					)}
					{environment.branch && (
						<div className="session-row session-branch" title={environment.branch.title}>
							{detached ? (
								<GitCommitIcon aria-hidden="true" />
							) : (
								<GitBranchIcon aria-hidden="true" />
							)}
							<span className="session-branch-text">
								<span className="session-label">{environment.branch.text}</span>
								{environment.branch.subject && (
									<span className="session-subject">{environment.branch.subject}</span>
								)}
							</span>
						</div>
					)}
					{environment.branchNote && <p className="session-note">{environment.branchNote}</p>}
				</Section>
				{contextPanel ? (
					<ContextBreakdown source={contextPanel} usage={usage} />
				) : (
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
				)}
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
				{outputs && outputs.length > 0 && (
					<Section title="Outputs">
						<ul className="session-list session-outputs" data-testid="session-outputs">
							{outputs.map((file) => (
								<li key={file.path}>
									<button
										type="button"
										className="session-output"
										data-output-row={file.path}
										title={file.path}
										onClick={() => onOpenOutput?.(file)}
									>
										<FileTypeIcon path={file.name} />
										<span className="session-label">{file.name}</span>
									</button>
								</li>
							))}
						</ul>
					</Section>
				)}
				{apps && (apps.granted.length > 0 || apps.used.length > 0) && (
					<Section title="Applications">
						<ul className="session-list">
							{apps.used.map((app) => (
								<AppRow
									key={app}
									app={app}
									allowed={apps.granted.includes(app)}
									onRevoke={onRevokeApp}
								/>
							))}
							{apps.granted
								.filter((app) => !apps.used.includes(app))
								.map((app) => (
									<AppRow key={app} app={app} allowed onRevoke={onRevokeApp} />
								))}
						</ul>
					</Section>
				)}
				{sources && (
					<Section
						title="Sources"
						aside={
							onAttach && (
								<Button
									variant="ghost-muted"
									size="icon-xs"
									aria-label="Add files to the next message"
									title={attachReason ?? 'Add files to the next message'}
									disabled={!!attachReason}
									onClick={onAttach}
								>
									<PlusIcon aria-hidden="true" />
								</Button>
							)
						}
					>
						{sources.length === 0 ? (
							<p className="session-note">Nothing attached yet</p>
						) : (
							<ul className="session-list">
								{(showAllSources ? sources : sources.slice(0, COLLAPSED_SOURCES)).map(
									({ key, attachment }) => (
										<li key={key} title={attachment.name}>
											{attachment.kind === 'image' ? (
												<ImageIcon aria-hidden="true" />
											) : (
												<FileTextIcon aria-hidden="true" />
											)}
											<span className="session-label">{attachment.name}</span>
										</li>
									),
								)}
							</ul>
						)}
						{sources.length > COLLAPSED_SOURCES && (
							<button
								type="button"
								className="session-link session-more"
								aria-expanded={showAllSources}
								onClick={() => setShowAllSources((value) => !value)}
							>
								{showAllSources ? 'Show fewer' : `View all (${sources.length})`}
							</button>
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
