import { useEffect, useRef, useState } from 'react'
import type { ProjectView } from '../shared/protocol.js'
import { FileDiffIcon, FolderIcon, PanelRightIcon, TerminalIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import './project-context.css'

export interface ProjectContextProps {
	project: ProjectView
	/** Completed diff receipts, which may include repeated changes to a file. */
	changes: number
	/** Null means background work has not been established by the host. */
	runningShells: number | null
	jobsUnavailable?: boolean
	activeTools: number
	awaitingApproval: boolean
	running: boolean
	onChanges: () => void
	onJobs: () => void
}

function ProjectContextBody({
	project,
	changes,
	runningShells,
	jobsUnavailable = false,
	activeTools,
	awaitingApproval,
	running,
	onChanges,
	onJobs,
}: ProjectContextProps) {
	const activity = awaitingApproval
		? 'Waiting for your decision'
		: activeTools > 0
			? `${activeTools} ${activeTools === 1 ? 'action' : 'actions'} in progress`
			: running
				? 'Working'
				: null
	return (
		<div className="project-context-body">
			<div className="project-context-heading">
				<FolderIcon aria-hidden="true" />
				<h2 title={project.path}>{project.name}</h2>
			</div>
			<Button
				variant="ghost-muted"
				className="project-context-row h-auto px-0 py-1.5 text-[13px] font-normal sm:h-auto sm:text-[13px]"
				aria-label="View changes"
				onClick={onChanges}
			>
				<FileDiffIcon className="size-3.5" aria-hidden="true" />
				<span className="project-context-row-label">Changes</span>
				<span className="project-context-count">{changes}</span>
			</Button>
			<div className="project-context-section">
				<h3>Background work</h3>
				<Button
					variant="ghost-muted"
					className="project-context-row h-auto px-0 py-1.5 text-[13px] font-normal sm:h-auto sm:text-[13px]"
					aria-label="View background work"
					onClick={onJobs}
				>
					<TerminalIcon className="size-3.5" aria-hidden="true" />
					<span className="project-context-row-label">Tasks</span>
					{runningShells !== null && (
						<span className="project-context-count">{runningShells} running</span>
					)}
				</Button>
				{runningShells === null && (
					<p className="project-context-description">
						{jobsUnavailable ? 'Background work unavailable' : 'Checking background work'}
					</p>
				)}
			</div>
			{activity && (
				<output className="project-context-activity" aria-live="polite">
					<span
						className="project-context-activity-mark"
						data-waiting={awaitingApproval || undefined}
						aria-hidden="true"
					/>
					<span>{activity}</span>
				</output>
			)}
		</div>
	)
}

/** A compact entry at widths where a floating card would cover the conversation. */
export function ProjectContextMenu(props: ProjectContextProps) {
	const [open, setOpen] = useState(false)
	const menu = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const workspace = menu.current?.closest('.workspace')
		if (!workspace) return
		// A portaled popup must close when its compact trigger is hidden by
		// the workspace container query. Viewport width is not that boundary.
		const observer = new ResizeObserver(([entry]) => {
			if (entry && entry.contentRect.width >= 1280) setOpen(false)
		})
		observer.observe(workspace)
		return () => observer.disconnect()
	}, [])
	return (
		<div className="project-context-menu" ref={menu}>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={<Button variant="ghost-muted" size="icon-sm" />}
					aria-label="Project context"
				>
					<PanelRightIcon aria-hidden="true" />
				</PopoverTrigger>
				<PopoverPopup
					aria-label="Project context"
					align="end"
					padding="none"
					className="project-context-popup"
				>
					<ProjectContextBody
						{...props}
						onChanges={() => {
							setOpen(false)
							props.onChanges()
						}}
						onJobs={() => {
							setOpen(false)
							props.onJobs()
						}}
					/>
				</PopoverPopup>
			</Popover>
		</div>
	)
}

/** Summary of host-observed work; detailed diffs and job output use existing panes. */
export function ProjectContextCard(props: ProjectContextProps) {
	return (
		<aside className="project-context-card" aria-label="Project context">
			<ProjectContextBody {...props} />
		</aside>
	)
}
