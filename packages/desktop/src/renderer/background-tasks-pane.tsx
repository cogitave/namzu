import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JobView } from '../shared/protocol.js'
import {
	type TaskSections,
	type TasksChoices,
	finishedOpen,
	pruneDismissed,
	readChoices,
	sectionTasks,
	writeChoices,
} from './background-tasks-model.js'
import { ChevronRightIcon, ListTodoIcon, TrashIcon } from './icons.js'
import { type JobOutput, JobRow } from './job-row.js'
import { Button } from './ui/button.js'
import { viewState } from './view-state.js'
import './background-tasks.css'

/** Where the pane should look when it opens: one task, or the Finished section. */
export interface TasksFocus {
	id?: string
	finished?: boolean
	/** Changes on every request, so asking for the same task twice scrolls to it twice. */
	nonce: number
}

export interface TaskChoices {
	sections: TaskSections
	finishedOpen: boolean
	/** At least one finished task is showing, so there is something to clear. */
	canClear: boolean
	clearFinished: () => void
	setFinishedOpen: (open: boolean) => void
}

/**
 * The pane's sections and what the person chose in them, for one conversation. Clearing hides the
 * finished tasks of the list only; the choice is remembered per conversation and a task that runs
 * again is shown again. The header's button and the body read the same state.
 */
export function useTaskChoices(sessionId: string, jobs: readonly JobView[]): TaskChoices {
	const [choices, setChoices] = useState<TasksChoices>(() => readChoices(viewState, sessionId))
	const owner = useRef(sessionId)
	if (owner.current !== sessionId) {
		owner.current = sessionId
		setChoices(readChoices(viewState, sessionId))
	}
	const update = useCallback(
		(change: (value: TasksChoices) => TasksChoices) =>
			setChoices((value) => {
				const next = change(value)
				writeChoices(viewState, sessionId, next)
				return next
			}),
		[sessionId],
	)
	const dismissed = useMemo(() => new Set(choices.dismissed), [choices.dismissed])
	const sections = useMemo(() => sectionTasks(jobs, dismissed), [jobs, dismissed])
	// A cleared task that is gone from the engine is forgotten, so the saved list stays short.
	useEffect(() => {
		if (jobs.length === 0) return
		const kept = pruneDismissed(choices.dismissed, jobs)
		if (kept.length !== choices.dismissed.length) update((value) => ({ ...value, dismissed: kept }))
	}, [jobs, choices.dismissed, update])
	return {
		sections,
		finishedOpen: finishedOpen(choices.finishedOpen, sections.running.length > 0),
		canClear: sections.finished.length > 0,
		clearFinished: () =>
			update((value) => ({
				...value,
				dismissed: [...new Set([...value.dismissed, ...sections.finished.map((job) => job.id)])],
			})),
		setFinishedOpen: (open) => update((value) => ({ ...value, finishedOpen: open })),
	}
}

/** The pane header's button: clears the finished tasks from the list. */
export function ClearFinishedButton({ choices }: { choices: TaskChoices }) {
	return (
		<Button
			type="button"
			variant="ghost-muted"
			size="icon-xs"
			className="pane-control"
			aria-label="Clear finished tasks"
			title="Clear finished tasks"
			disabled={!choices.canClear}
			onClick={choices.clearFinished}
		>
			<TrashIcon aria-hidden="true" />
		</Button>
	)
}

function Heading({
	title,
	count,
	open,
	onToggle,
}: {
	title: string
	count: number
	open?: boolean
	onToggle?: () => void
}) {
	const body = (
		<>
			{onToggle && (
				<ChevronRightIcon className="tasks-heading-chevron" data-open={open || undefined} />
			)}
			<span>{title}</span>
			<span className="tasks-count">{count}</span>
		</>
	)
	return (
		<h3 className="tasks-heading">
			{onToggle ? (
				<button
					type="button"
					className="tasks-heading-button"
					aria-expanded={open}
					onClick={onToggle}
				>
					{body}
				</button>
			) : (
				<span className="tasks-heading-text">{body}</span>
			)}
		</h3>
	)
}

export interface BackgroundTasksPaneProps {
	choices: TaskChoices
	/** False while the list is being read or could not be. */
	known: boolean
	now: number
	focus?: TasksFocus | undefined
	onRead: (job: JobView) => Promise<JobOutput | undefined>
	onStop: (job: JobView) => Promise<unknown>
}

/** Running, then Finished: one row per task, each opening to its live output. */
export function BackgroundTasksPane({
	choices,
	known,
	now,
	focus,
	onRead,
	onStop,
}: BackgroundTasksPaneProps) {
	const { running, finished } = choices.sections
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
	const root = useRef<HTMLDivElement>(null)
	const handled = useRef(focus?.nonce)
	const { setFinishedOpen } = choices
	// biome-ignore lint/correctness/useExhaustiveDependencies: a request is handled once, by its nonce
	useEffect(() => {
		if (!focus || handled.current === focus.nonce) return
		handled.current = focus.nonce
		const id = focus.id
		if (id) setOpen((value) => new Set(value).add(id))
		if (focus.finished || (id && finished.some((job) => job.id === id))) setFinishedOpen(true)
		const frame = requestAnimationFrame(() => {
			const row = id
				? root.current?.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(id)}"]`)
				: root.current?.querySelector<HTMLElement>('[data-section="finished"]')
			row?.scrollIntoView({ block: 'nearest' })
		})
		return () => cancelAnimationFrame(frame)
	}, [focus?.nonce])

	const row = (job: JobView) => (
		<li key={job.id}>
			<JobRow
				job={job}
				now={now}
				open={open.has(job.id)}
				onOpenChange={(next) =>
					setOpen((value) => {
						const copy = new Set(value)
						if (next) copy.add(job.id)
						else copy.delete(job.id)
						return copy
					})
				}
				onRead={() => onRead(job)}
				onStop={() => onStop(job)}
			/>
		</li>
	)
	if (running.length === 0 && finished.length === 0) {
		return (
			<div className="tasks-pane" ref={root} data-testid="tasks-pane">
				<div className="tasks-empty">
					<ListTodoIcon className="tasks-empty-icon" aria-hidden="true" />
					<p>{known ? 'Background tasks appear here' : 'Checking background tasks…'}</p>
				</div>
			</div>
		)
	}
	return (
		<div className="tasks-pane" ref={root} data-testid="tasks-pane">
			{running.length > 0 && (
				<section className="tasks-section" data-section="running" aria-label="Running">
					<Heading title="Running" count={running.length} />
					<ul className="tasks-list">{running.map(row)}</ul>
				</section>
			)}
			{finished.length > 0 && (
				<section className="tasks-section" data-section="finished" aria-label="Finished">
					<Heading
						title="Finished"
						count={finished.length}
						open={choices.finishedOpen}
						onToggle={() => choices.setFinishedOpen(!choices.finishedOpen)}
					/>
					{choices.finishedOpen && <ul className="tasks-list">{finished.map(row)}</ul>}
				</section>
			)}
		</div>
	)
}
