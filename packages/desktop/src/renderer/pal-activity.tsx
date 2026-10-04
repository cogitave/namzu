import type { ThreadState } from '../shared/projection.js'
import { ChevronRightIcon, FileDiffIcon, TerminalIcon, WrenchIcon } from './icons.js'
import { ToolView } from './tool-view.js'
import { elapsedLabel } from './transcript-layout.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'

/** Tool receipts stay in their admitted order and retain their actual presentation. */
export function palToolActivity(thread: ThreadState) {
	return thread.timeline.flatMap((entry) => {
		const tool = entry.kind === 'tool' ? thread.tools[entry.id] : undefined
		return tool && entry.kind === 'tool' ? [{ id: entry.id, tool }] : []
	})
}

export function PalActivity({ thread }: { thread: ThreadState }) {
	const activity = palToolActivity(thread)
	return (
		<section aria-label="Pal actions" className="pal-activity">
			{activity.length === 0 ? (
				<p className="quiet">No retained actions in this view.</p>
			) : (
				<div className="tool-list">
					{activity.map(({ id, tool }) => {
						const active = tool.status === 'pending' && thread.activeToolIds.includes(id)
						const Icon =
							tool.view.kind === 'terminal'
								? TerminalIcon
								: tool.view.kind === 'diff'
									? FileDiffIcon
									: WrenchIcon
						return (
							<Collapsible
								key={id}
								className={`tool ${tool.status}${active ? ' active' : ''}`}
								data-tool-call-id={tool.toolCallId}
							>
								<CollapsibleTrigger className="tool-trigger" title={tool.title}>
									<Icon className="tool-icon" aria-hidden="true" />
									<span className="tool-label">{tool.title}</span>
									<span className="tool-status">
										{tool.status === 'failed'
											? 'Failed'
											: tool.status === 'pending'
												? active
													? 'Working'
													: 'Interrupted'
												: tool.durationMs !== undefined
													? elapsedLabel(tool.durationMs)
													: 'Completed'}
									</span>
									<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
								</CollapsibleTrigger>
								<CollapsiblePanel>
									<ToolView view={tool.view} />
									{tool.progress && (
										<output className="tool-progress">
											{tool.progress.message}
											{tool.progress.fraction !== undefined && (
												<progress value={tool.progress.fraction} max={1} />
											)}
										</output>
									)}
								</CollapsiblePanel>
							</Collapsible>
						)
					})}
				</div>
			)}
		</section>
	)
}
