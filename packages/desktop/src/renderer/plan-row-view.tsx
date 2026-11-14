import type { AcpTask } from '@namzu/sdk'
import { useState } from 'react'
import { CheckIcon, ChevronRightIcon, ListTodoIcon, LoaderCircleIcon, XIcon } from './icons.js'
import { planLabel, planSummary, planVisibleTasks } from './plan-row.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import './plan-row.css'

const stateText: Record<AcpTask['status'], string> = {
	completed: 'Done',
	in_progress: 'In progress',
	failed: 'Failed',
	pending: 'Not started',
}

function StepMark({ status }: { status: AcpTask['status'] }) {
	if (status === 'completed') return <CheckIcon aria-hidden="true" />
	if (status === 'failed') return <XIcon aria-hidden="true" />
	if (status === 'in_progress')
		return <LoaderCircleIcon className="plan-spinner" aria-hidden="true" />
	return <span className="plan-pending-mark" aria-hidden="true" />
}

/** Done is a muted disc with a check, current a spinning arc, not started a dashed ring (failed a disc with a cross). */
function BoxMark({ status }: { status: AcpTask['status'] }) {
	return (
		<svg className="plan-box-mark" viewBox="0 0 16 16" aria-hidden="true">
			{status === 'completed' || status === 'failed' ? (
				<>
					<circle
						className="plan-box-disc"
						data-failed={status === 'failed' ? '' : undefined}
						cx="8"
						cy="8"
						r="8"
					/>
					<path
						className="plan-box-glyph"
						d={
							status === 'completed'
								? 'M4.75 8.25 7 10.5 11.25 5.75'
								: 'M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5'
						}
					/>
				</>
			) : status === 'in_progress' ? (
				<>
					<circle className="plan-box-arc" cx="8" cy="8" r="7" />
					<path className="plan-box-arc-head" d="M8 1A7 7 0 0 1 15 8" />
				</>
			) : (
				<circle className="plan-box-ring" cx="8" cy="8" r="7" />
			)}
		</svg>
	)
}

/**
 * The plan while the turn runs: one box in the flow under the person's message, outside the fold. When the
 * answer lands the plan folds into the work block as a row (PlanRow).
 */
export function PlanBox({
	tasks,
	onOpenTasks,
}: {
	tasks: readonly AcpTask[]
	onOpenTasks?: () => void
}) {
	if (!planSummary(tasks).total) return null
	const { shown, more } = planVisibleTasks(tasks)
	return (
		<section className="plan-box" aria-label="Plan">
			<ul className="plan-box-steps">
				{shown.map((task) => (
					<li key={task.taskId} data-status={task.status}>
						<BoxMark status={task.status} />
						<span className="plan-subject">{task.subject}</span>
						<span className="plan-state">{stateText[task.status]}</span>
					</li>
				))}
			</ul>
			{more > 0 && onOpenTasks && (
				<button type="button" className="plan-more" onClick={onOpenTasks}>
					+{more} more
				</button>
			)}
		</section>
	)
}

/**
 * The plan inside the work block: one row that updates in place by task id, folded to a checklist.
 * The task tools' own rows never draw; this is where they went.
 */
export function PlanRow({
	tasks,
	turnLive,
	open,
	onOpenChange,
	onOpenTasks,
}: {
	tasks: readonly AcpTask[]
	turnLive: boolean
	/** The person's saved choice; without one the row folds. */
	open?: boolean
	onOpenChange?: (open: boolean) => void
	onOpenTasks?: () => void
}) {
	const [chosen, setChosen] = useState<boolean>()
	const summary = planSummary(tasks)
	// The tool call can land a moment before the first task does.
	if (!summary.total) return turnLive ? null : <PlanTouched />
	const label = planLabel(summary, turnLive)
	const { shown, more } = planVisibleTasks(tasks)
	const live = label.tone === 'live'
	return (
		<Collapsible
			className={`tool tool-group plan-row${live ? ' active' : ''}`}
			data-tone={label.tone}
			open={open ?? chosen ?? false}
			onOpenChange={(next) => {
				if (onOpenChange) onOpenChange(next)
				else setChosen(next)
			}}
		>
			<CollapsibleTrigger className="tool-trigger tool-run-trigger plan-trigger">
				<ListTodoIcon className="tool-icon" aria-hidden="true" />
				<span className="tool-label plan-label">
					{label.text}
					{label.current && <span className="plan-current"> · {label.current}</span>}
				</span>
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
			</CollapsibleTrigger>
			<CollapsiblePanel keepMounted>
				<ul className="plan-steps" aria-label="Plan">
					{shown.map((task) => (
						<li key={task.taskId} data-status={task.status}>
							<span className="plan-mark">
								<StepMark status={task.status} />
							</span>
							<span className="plan-subject">{task.subject}</span>
							<span className="plan-state">{stateText[task.status]}</span>
						</li>
					))}
				</ul>
				{more > 0 && onOpenTasks && (
					<button type="button" className="plan-more" onClick={onOpenTasks}>
						+{more} more
					</button>
				)}
			</CollapsiblePanel>
		</Collapsible>
	)
}

/** An earlier turn that changed the plan: a single quiet line, nothing to open. */
export function PlanTouched() {
	return (
		<div className="tool plan-row plan-touched" data-tone="muted">
			<div className="tool-trigger tool-summary">
				<ListTodoIcon className="tool-icon" aria-hidden="true" />
				<span className="tool-label plan-label">Updated tasks</span>
			</div>
		</div>
	)
}
