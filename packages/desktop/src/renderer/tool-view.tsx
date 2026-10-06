import type { ToolCallView } from '@namzu/sdk'
import type { ToolTranscriptState } from './tool-transcript-presentation.js'

function emptyOutput(state?: ToolTranscriptState): string {
	if (state === 'waiting') return 'Waiting for approval. No output yet.'
	if (state === 'running') return 'No output yet.'
	if (state === 'completed') return 'No output returned.'
	if (state === 'failed') return 'No output was returned before the failure.'
	if (state === 'cancelled') return 'No output was returned before cancellation.'
	if (state === 'interrupted') return 'No output was returned before interruption.'
	if (state === 'skipped') return 'This action was not executed.'
	return 'No output.'
}

/** Render the tool's presentation contract, including tools unknown to this host. */
export function ToolView({ view, state }: { view: ToolCallView; state?: ToolTranscriptState }) {
	if (view.kind === 'generic') return <p className="tool-content">{view.label}</p>
	if (view.kind === 'terminal')
		return (
			<div className="tool-content">
				{view.command && <pre className="tool-command">{view.command}</pre>}
				<pre>{view.output || emptyOutput(state)}</pre>
			</div>
		)
	return (
		<div className="tool-content">
			{(view.label || view.path) && (
				<p>
					{view.label}
					{view.label && view.path ? ' · ' : ''}
					{view.path}
				</p>
			)}
			<div className="diff">
				<section>
					<h4>Before</h4>
					<pre>{view.before || '(empty)'}</pre>
				</section>
				<section>
					<h4>{state && state !== 'completed' ? 'Proposed change' : 'After'}</h4>
					<pre>{view.after || '(empty)'}</pre>
				</section>
			</div>
		</div>
	)
}
