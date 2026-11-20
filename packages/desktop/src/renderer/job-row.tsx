import { useEffect, useRef, useState } from 'react'
import type { JobView } from '../shared/protocol.js'
import { type TaskCaption, isRunning, taskCaption } from './background-tasks-model.js'
import { ChevronRightIcon, EyeIcon, LoaderCircleIcon, SquareIcon, TerminalIcon } from './icons.js'
import { plainErrorText } from './plain-error.js'
import { TaskOutput } from './task-output.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'

export interface JobOutput {
	output: string
	truncated?: boolean
	/** Bytes the engine holds for this job; a large one is read less often. */
	size?: number
}

/** A monitor is named for what it watches; a shell, by the command it runs. */
export function jobLabel(job: JobView): string {
	return job.kind === 'monitor'
		? `Monitoring: ${job.description || job.command || 'a command'}`
		: job.command || 'Background terminal'
}

export function jobStatusOf(job: JobView): { label: string; tone: string } {
	if (job.status === 'running') {
		return {
			label: job.kind === 'monitor' ? 'Watching' : 'Running',
			tone: 'running',
		}
	}
	if (job.kind === 'monitor') {
		if (job.stopReason === 'expired') return { label: 'Ran out of time', tone: 'muted' }
		if (job.stopReason === 'too_much_output') return { label: 'Too much output', tone: 'muted' }
	}
	if (job.status === 'killed') return { label: 'Stopped', tone: 'muted' }
	if (job.status === 'exited') {
		if (job.exitCode === 0) return { label: 'Done', tone: 'success' }
		if (job.exitCode !== undefined) return { label: 'Failed', tone: 'error' }
		return { label: 'Finished', tone: 'muted' }
	}
	return { label: 'Status unavailable', tone: 'muted' }
}

/** One task in the Background tasks pane: what it is, how long, how it ended, Stop, and its output. */
export function JobRow({
	job,
	disabled = false,
	now = Date.now(),
	open: openProp,
	onOpenChange,
	onRead,
	onStop,
}: {
	job: JobView
	disabled?: boolean
	/** The clock the running time is read against. */
	now?: number
	/** The output is open. Without it the row keeps its own state. */
	open?: boolean
	onOpenChange?: (open: boolean) => void
	onRead(): Promise<JobOutput | undefined>
	onStop(): Promise<unknown>
}) {
	const [ownOpen, setOwnOpen] = useState(false)
	const open = openProp ?? ownOpen
	const [stopping, setStopping] = useState(false)
	const [error, setError] = useState('')
	const mounted = useRef(false)
	const stopPending = useRef(false)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const running = isRunning(job)
	// A stop that was confirmed ends the wait; one that was not leaves Retry.
	useEffect(() => {
		if (!running) setStopping(false)
	}, [running])
	const recovery = running && job.recoveryRequired === true
	// A monitor is named for what it watches; a shell, by the command it runs.
	const command = jobLabel(job)
	const caption = taskCaption(job, now, stopping && !recovery)
	const KindIcon = job.kind === 'monitor' ? EyeIcon : TerminalIcon
	const stop = async () => {
		if (disabled || stopPending.current) return
		stopPending.current = true
		setStopping(true)
		setError('')
		try {
			await onStop()
		} catch (failure) {
			if (mounted.current) {
				setStopping(false)
				setError(plainErrorText(failure, 'stop the task'))
			}
		} finally {
			stopPending.current = false
		}
	}
	return (
		<Collapsible
			className="task"
			data-job-id={job.id}
			data-job-status={job.status}
			open={open}
			onOpenChange={(next) => {
				setOwnOpen(next)
				onOpenChange?.(next)
			}}
		>
			<div className="task-heading">
				<CollapsibleTrigger className="task-trigger" aria-label={`Output for ${command}`}>
					<KindIcon className="task-kind" aria-hidden="true" />
					<span className="task-title" title={command}>
						{command}
					</span>
					<ChevronRightIcon className="task-chevron" aria-hidden="true" />
				</CollapsibleTrigger>
				<TaskCaptionView caption={caption} />
				{!running && <span className="task-stop-slot" aria-hidden="true" />}
				{running && (
					<Button
						variant="ghost-muted"
						size="icon-xs"
						className="task-stop"
						disabled={disabled || (stopping && !recovery)}
						aria-label={`${recovery ? 'Retry stop' : 'Stop'} ${command}`}
						title={stopping && !recovery ? 'Stopping…' : recovery ? 'Retry stop' : 'Stop'}
						onClick={() => void stop()}
					>
						{stopping && !recovery ? <LoaderCircleIcon className="task-spinner" /> : <SquareIcon />}
					</Button>
				)}
			</div>
			{recovery && (
				<output className="task-note">
					{job.stopError || 'Stopping this job has not been confirmed. Retry stop.'}
				</output>
			)}
			{error && (
				<p role="alert" className="task-note task-note-error">
					{error}
				</p>
			)}
			<CollapsiblePanel>
				{open && <TaskOutput command={command} running={running} read={onRead} />}
			</CollapsiblePanel>
		</Collapsible>
	)
}

/** The right side of a row: the state in words, then the time, in tabular figures. */
function TaskCaptionView({ caption }: { caption: TaskCaption }) {
	if (!caption.words && !caption.time) return null
	return (
		<span className="task-caption" data-tone={caption.tone}>
			{caption.words && <span className="task-words">{caption.words}</span>}
			{caption.time && (
				<span className="task-time" data-testid="task-time">
					{caption.time}
				</span>
			)}
		</span>
	)
}
