import type { ToolCallView } from '@namzu/sdk'

/** Render the tool's presentation contract, including tools unknown to this host. */
export function ToolView({ view }: { view: ToolCallView }) {
	if (view.kind === 'generic') return <p className="tool-content">{view.label}</p>
	if (view.kind === 'terminal')
		return (
			<div className="tool-content">
				{view.command && <pre className="tool-command">{view.command}</pre>}
				<pre>{view.output || 'No output.'}</pre>
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
					<h4>After</h4>
					<pre>{view.after || '(empty)'}</pre>
				</section>
			</div>
		</div>
	)
}
