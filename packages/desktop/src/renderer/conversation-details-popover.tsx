import { Menu } from '@base-ui/react/menu'
import { type Ref, useEffect, useRef, useState } from 'react'
import type { ComputerAppsView } from '../shared/computer-protocol.js'
import type { ProjectGitView, ProjectView } from '../shared/protocol.js'
import { CUT_NOTE, type ChangeTotals } from './changes-totals.js'
import type { ConversationSource } from './conversation-actions.js'
import { copyPlainText } from './copy-button.js'
import {
	ArchiveIcon,
	FileDiffIcon,
	FileTextIcon,
	FolderIcon,
	GitBranchIcon,
	GitCommitIcon,
	ImageIcon,
	ListTodoIcon,
	MoreHorizontalIcon,
	PlusIcon,
	TerminalIcon,
} from './icons.js'
import {
	type SessionSummary,
	type SessionWork,
	finishedText,
	sessionSummary,
} from './session-summary-model.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import './conversation-details-popover.css'
import { MENU_OFFSET } from './menu-metrics.js'

/** The background work the popover and the session panel both report. */
export type DetailsWork = SessionWork

/** The icon button's label carries the count so the dot is not the only signal. */
export function detailsTriggerLabel(work: DetailsWork): string {
	if (work.state !== 'known') return 'Conversation details'
	const parts: string[] = []
	if (work.running > 0)
		parts.push(`${work.running} ${work.running === 1 ? 'process' : 'processes'} running`)
	if (work.needsAttention) parts.push('background work needs attention')
	return parts.length ? `Conversation details, ${parts.join(', ')}` : 'Conversation details'
}

function SourceIcon({ kind }: { kind: 'image' | 'text' }) {
	return kind === 'image' ? <ImageIcon aria-hidden="true" /> : <FileTextIcon aria-hidden="true" />
}

const COLLAPSED_SOURCES = 3

/** The rows the popover and the session panel both say, drawn from the one summary. */
export function DetailsRows({
	summary,
	git,
	work,
	onOpenChanges,
	onOpenWork,
}: {
	summary: SessionSummary
	git: ProjectGitView | null
	work: DetailsWork
	onOpenChanges: () => void
	onOpenWork: () => void
}) {
	const { changes, background, environment } = summary
	const finishedLine = finishedText(background.finished)
	return (
		<>
			<button type="button" className="conversation-details-row" onClick={onOpenChanges}>
				<FileDiffIcon aria-hidden="true" />
				<span className="conversation-details-label">Changes</span>
				{changes.hasChanges ? (
					<span className="conversation-details-totals" title={changes.note}>
						<span className="conversation-details-added">
							<span aria-hidden="true">+</span>
							<span className="sr-only">Added </span>
							{changes.added}
						</span>
						<span className="conversation-details-removed">
							<span aria-hidden="true">−</span>
							<span className="sr-only">Removed </span>
							{changes.removed}
						</span>
						{changes.cut && <span className="conversation-details-value">{CUT_NOTE}</span>}
					</span>
				) : (
					<span className="conversation-details-value">{changes.empty}</span>
				)}
			</button>
			{git && (
				<div
					className="conversation-details-row conversation-details-static"
					title={environment.branch?.title}
				>
					{git.branch === null ? (
						<GitCommitIcon aria-hidden="true" />
					) : (
						<GitBranchIcon aria-hidden="true" />
					)}
					<span className="conversation-details-label">
						<span className="conversation-details-branch">{environment.branch?.text}</span>
						{git.subject && <span className="conversation-details-subject">{git.subject}</span>}
					</span>
				</div>
			)}
			<button type="button" className="conversation-details-row" onClick={onOpenWork}>
				<TerminalIcon aria-hidden="true" />
				<span className="conversation-details-label">Background work</span>
				<span
					className="conversation-details-value"
					data-attention={work.state === 'known' && work.needsAttention ? '' : undefined}
				>
					{background.text}
					{finishedLine && work.state === 'known' && ` · ${finishedLine}`}
				</span>
			</button>
		</>
	)
}

export interface ConversationDetailsProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	triggerRef?: Ref<HTMLButtonElement>
	/** Absent for a conversation without a project, which then has no header or path. */
	project?: ProjectView
	totals: ChangeTotals
	/** Null hides the repository row. */
	git: ProjectGitView | null
	work: DetailsWork
	sources: readonly ConversationSource[]
	/** Why the "+" is unavailable, or undefined when it works. */
	attachReason?: string
	onOpenChanges: () => void
	onOpenWork: () => void
	onAttach: () => void
	/** Switches the sidebar to its archived conversations; absent when the host cannot list them. */
	onOpenArchived?: () => void
	/** The applications this conversation has allowed and used; absent until the agent has worked in one. */
	apps?: ComputerAppsView | undefined
	/** Takes an application back; absent when the host cannot. */
	onRevokeApp?: (app: string) => void
}

/** The single home of a conversation's project, changes, repository, background work and sources. */
export function ConversationDetailsPopover({
	open,
	onOpenChange,
	triggerRef,
	project,
	totals,
	git,
	work,
	sources,
	attachReason,
	onOpenChanges,
	onOpenWork,
	onAttach,
	onOpenArchived,
	apps,
	onRevokeApp,
}: ConversationDetailsProps) {
	const [showAll, setShowAll] = useState(false)
	const [copied, setCopied] = useState<'' | 'done' | 'failed'>('')
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(() => () => clearTimeout(timer.current), [])
	useEffect(() => {
		if (!open) {
			setShowAll(false)
			setCopied('')
		}
	}, [open])
	const dot =
		work.state === 'known'
			? work.needsAttention
				? 'attention'
				: work.running > 0
					? 'running'
					: undefined
			: undefined
	const visible = showAll ? sources : sources.slice(0, COLLAPSED_SOURCES)
	const summary = sessionSummary({
		...(project
			? { project: { name: project.name, path: project.path, trusted: project.trusted } }
			: {}),
		git,
		servers: { state: 'hidden' },
		totals,
		work,
	})
	const copyPath = async () => {
		if (!project) return
		try {
			await copyPlainText(project.path)
			setCopied('done')
		} catch {
			setCopied('failed')
		}
		clearTimeout(timer.current)
		timer.current = setTimeout(() => setCopied(''), 2000)
	}
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger
				ref={triggerRef}
				render={
					<Button variant="ghost-muted" size="icon-sm" className="conversation-details-trigger" />
				}
				aria-label={detailsTriggerLabel(work)}
				title="Conversation details"
			>
				<ListTodoIcon className="size-4" aria-hidden="true" />
				{dot && <span className="conversation-details-dot" data-state={dot} aria-hidden="true" />}
			</PopoverTrigger>
			<PopoverPopup
				aria-label="Conversation details"
				align="end"
				padding="none"
				className="conversation-details-popup"
			>
				<div className="conversation-details">
					{project && (
						<div className="conversation-details-heading">
							<FolderIcon aria-hidden="true" />
							<h2 title={project.path}>{project.name}</h2>
							<Menu.Root>
								<Menu.Trigger
									render={<Button variant="ghost-muted" size="icon-xs" />}
									aria-label="Project actions"
								>
									<MoreHorizontalIcon aria-hidden="true" />
								</Menu.Trigger>
								<Menu.Portal>
									<Menu.Positioner
										className="conversation-actions-positioner"
										align="end"
										sideOffset={MENU_OFFSET}
									>
										<Menu.Popup className="conversation-actions-popup" aria-label="Project actions">
											<Menu.Item
												className="conversation-actions-item"
												onClick={() => void copyPath()}
											>
												<FolderIcon aria-hidden="true" />
												<span className="conversation-actions-label">Copy path</span>
											</Menu.Item>
											{onOpenArchived && (
												<Menu.Item
													className="conversation-actions-item"
													onClick={() => {
														onOpenChange(false)
														onOpenArchived()
													}}
												>
													<ArchiveIcon aria-hidden="true" />
													<span className="conversation-actions-label">Archived conversations</span>
												</Menu.Item>
											)}
										</Menu.Popup>
									</Menu.Positioner>
								</Menu.Portal>
							</Menu.Root>
						</div>
					)}
					<output className="conversation-details-status" aria-live="polite">
						{copied === 'done'
							? 'Path copied.'
							: copied === 'failed'
								? 'Could not copy the path.'
								: ''}
					</output>
					<DetailsRows
						summary={summary}
						git={git}
						work={work}
						onOpenChanges={onOpenChanges}
						onOpenWork={onOpenWork}
					/>
					{apps && (apps.granted.length > 0 || apps.used.length > 0) && (
						<section
							className="conversation-details-sources conversation-details-apps"
							aria-label="Applications"
						>
							<div className="conversation-details-sources-heading">
								<h3>Applications</h3>
							</div>
							<ul>
								{apps.used.map((app) => {
									const allowed = apps.granted.includes(app)
									return (
										<li key={app} data-testid="computer-app-row">
											<span>{app}</span>
											<span className="conversation-details-value">
												{allowed ? 'Allowed' : 'Used'}
											</span>
											{allowed && onRevokeApp && (
												<button
													type="button"
													className="conversation-details-more"
													aria-label={`Take back access to ${app}`}
													onClick={() => onRevokeApp(app)}
												>
													Take back
												</button>
											)}
										</li>
									)
								})}
								{apps.granted
									.filter((app) => !apps.used.includes(app))
									.map((app) => (
										<li key={app} data-testid="computer-app-row">
											<span>{app}</span>
											<span className="conversation-details-value">Allowed</span>
											{onRevokeApp && (
												<button
													type="button"
													className="conversation-details-more"
													aria-label={`Take back access to ${app}`}
													onClick={() => onRevokeApp(app)}
												>
													Take back
												</button>
											)}
										</li>
									))}
							</ul>
						</section>
					)}
					<section className="conversation-details-sources" aria-label="Sources">
						<div className="conversation-details-sources-heading">
							<h3>Sources</h3>
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
						</div>
						{sources.length === 0 ? (
							<p className="conversation-details-empty">Nothing attached yet</p>
						) : (
							<ul>
								{visible.map(({ key, attachment }) => (
									<li key={key} title={attachment.name}>
										<SourceIcon kind={attachment.kind} />
										<span>{attachment.name}</span>
									</li>
								))}
							</ul>
						)}
						{sources.length > COLLAPSED_SOURCES && (
							<button
								type="button"
								className="conversation-details-more"
								aria-expanded={showAll}
								onClick={() => setShowAll((value) => !value)}
							>
								{showAll ? 'Show fewer' : `View all (${sources.length})`}
							</button>
						)}
					</section>
				</div>
			</PopoverPopup>
		</Popover>
	)
}
