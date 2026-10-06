import { useEffect, useRef, useState } from 'react'
import type { JobView } from '../shared/protocol.js'
import { ChevronRightIcon, LoaderCircleIcon, SquareIcon, TerminalIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'

export interface JobOutput {
	output: string
	truncated?: boolean
}

function jobStatus(job: JobView): { label: string; tone: string } {
	if (job.status === 'running') return { label: 'Running', tone: 'running' }
	if (job.status === 'killed') return { label: 'Stopped', tone: 'muted' }
	if (job.status === 'exited') {
		if (job.exitCode === 0) return { label: 'Done', tone: 'success' }
		if (job.exitCode !== undefined) return { label: 'Failed', tone: 'error' }
		return { label: 'Finished', tone: 'muted' }
	}
	return { label: 'Status unavailable', tone: 'muted' }
}

export function JobRow({
	job,
	disabled = false,
	onRead,
	onStop,
}: {
	job: JobView
	disabled?: boolean
	onRead(): Promise<JobOutput | undefined>
	onStop(): Promise<unknown>
}) {
	const [open, setOpen] = useState(false)
	const [output, setOutput] = useState<JobOutput>()
	const [reading, setReading] = useState(false)
	const [stopping, setStopping] = useState(false)
	const [error, setError] = useState('')
	const mounted = useRef(false)
	const readPending = useRef(false)
	const stopPending = useRef(false)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const recovery = job.status === 'running' && job.recoveryRequired === true
	const status = jobStatus(job)
	const command = job.command || 'Background terminal'
	const read = async () => {
		if (disabled || readPending.current) return
		readPending.current = true
		setReading(true)
		setError('')
		try {
			const result = await onRead()
			if (mounted.current && result !== undefined) setOutput(result)
		} catch (failure) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
		} finally {
			readPending.current = false
			if (mounted.current) setReading(false)
		}
	}
	const stop = async () => {
		if (disabled || stopPending.current) return
		stopPending.current = true
		setStopping(true)
		setError('')
		try {
			await onStop()
		} catch (failure) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
		} finally {
			stopPending.current = false
			if (mounted.current) setStopping(false)
		}
	}
	return (
		<Collapsible
			className="job"
			data-job-id={job.id}
			data-job-status={job.status}
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (next) void read()
			}}
		>
			<div className="job-heading">
				<CollapsibleTrigger className="job-trigger" aria-label={`Output for ${command}`}>
					<TerminalIcon className="size-3.5" aria-hidden="true" />
					<code className="job-command" title={command}>
						{command}
					</code>
					<ChevronRightIcon className="job-chevron size-3" aria-hidden="true" />
				</CollapsibleTrigger>
				<span className="job-status" data-tone={status.tone}>
					{status.label}
				</span>
				{job.status === 'running' && (
					<Button
						variant="ghost-destructive"
						size="icon-xs"
						className="job-stop"
						disabled={disabled || stopping}
						aria-label={`${recovery ? 'Retry stop' : 'Stop'} ${command}`}
						title={stopping ? 'Stopping…' : recovery ? 'Retry stop' : 'Stop'}
						onClick={() => void stop()}
					>
						{stopping ? <LoaderCircleIcon className="job-spinner" /> : <SquareIcon />}
					</Button>
				)}
			</div>
			{recovery && (
				<output className="job-recovery">
					{job.stopError || 'Stopping this job has not been confirmed. Retry stop.'}
				</output>
			)}
			{error && (
				<p role="alert" className="job-error">
					{error}
				</p>
			)}
			<CollapsiblePanel keepMounted>
				<div className="job-details">
					<div className="job-output-heading">
						<span>Terminal output</span>
						<Button
							variant="ghost-muted"
							size="micro"
							disabled={disabled || reading}
							onClick={() => void read()}
						>
							{reading ? 'Reading…' : 'Refresh'}
						</Button>
					</div>
					{output !== undefined ? (
						<>
							{output.truncated && <p className="job-output-note">Earlier output omitted.</p>}
							{output.output ? (
								<pre className="job-output">{output.output}</pre>
							) : (
								<p className="job-output-note">No output yet.</p>
							)}
						</>
					) : (
						<p className="job-output-note">
							{reading ? 'Reading output…' : 'Output has not been read.'}
						</p>
					)}
				</div>
			</CollapsiblePanel>
		</Collapsible>
	)
}
