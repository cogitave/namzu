import type { JobView } from '../shared/protocol.js'
import { Button } from './ui/button.js'

export function JobRow({
	job,
	onRead,
	onStop,
}: {
	job: JobView
	onRead(): void
	onStop(): void
}) {
	const recovery = job.status === 'running' && job.recoveryRequired === true
	return (
		<div className="job">
			<strong>{job.status}</strong>
			<code>{job.command}</code>
			{recovery && (
				<output className="quiet block mb-3">
					{job.stopError || 'Stopping this job has not been confirmed. Retry stop.'}
				</output>
			)}
			<div>
				<Button type="button" onClick={onRead}>
					View output
				</Button>
				{job.status === 'running' && (
					<Button type="button" onClick={onStop}>
						{recovery ? 'Retry stop' : 'Stop'}
					</Button>
				)}
			</div>
		</div>
	)
}
