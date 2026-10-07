import type { ThreadState } from '../shared/projection.js'
import { ChevronRightIcon, FileDiffIcon, SearchIcon, TerminalIcon, WrenchIcon } from './icons.js'
import { MessageTime } from './message.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { ToolView } from './tool-view.js'
import { elapsedLabel } from './transcript-layout.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'

/** One admitted action, with a disclosure only when there is content to inspect. */
export function ToolTranscriptRow({
	thread,
	id,
	onOpenChange,
}: {
	thread: ThreadState
	id: string
	onOpenChange?: (open: boolean) => void
}) {
	const tool = thread.tools[id]
	const presentation = toolTranscriptPresentation(thread, id)
	if (!tool || !presentation) return null
	const { label, state, statusLabel, detailView, callDetail, quietCompleted } = presentation
	const Icon =
		tool.title === 'search_conversation' ||
		(tool.toolCallId.startsWith('provider-hosted-web-search:') &&
			(tool.title === 'Web search' || tool.title === 'Web fetch'))
			? SearchIcon
			: tool.view.kind === 'terminal'
				? TerminalIcon
				: tool.view.kind === 'diff'
					? FileDiffIcon
					: WrenchIcon
	const active = state === 'running' || state === 'waiting'
	const expandable = Boolean(callDetail || detailView || tool.progress)
	const duration =
		tool.durationMs !== undefined && Number.isFinite(tool.durationMs) && tool.durationMs >= 0
			? tool.durationMs < 1000
				? `${tool.durationMs} ms`
				: elapsedLabel(tool.durationMs)
			: undefined
	const contents = (
		<>
			<Icon className="tool-icon" aria-hidden="true" />
			<span className="tool-label">{label}</span>
			<span className={quietCompleted ? 'tool-status transcript-visually-hidden' : 'tool-status'}>
				{statusLabel}
			</span>
			<MessageTime time={tool.startedTime ?? tool.endedTime} />
			{duration && (
				<span
					className="tool-duration"
					aria-label={`Duration: ${tool.durationMs} ms`}
					title={`Duration: ${tool.durationMs} ms`}
				>
					{duration}
				</span>
			)}
			{expandable && <ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />}
		</>
	)
	const props = {
		className: `tool ${state}${active ? ' active' : ''}`,
		'data-tool-call-id': tool.toolCallId,
		'data-tool-state': state,
	}
	if (!expandable)
		return (
			<div {...props}>
				<div className="tool-trigger tool-summary" title={label}>
					{contents}
				</div>
			</div>
		)
	return (
		<Collapsible {...props} onOpenChange={onOpenChange}>
			<CollapsibleTrigger className="tool-trigger" title={label}>
				{contents}
			</CollapsibleTrigger>
			<CollapsiblePanel>
				{callDetail && <ToolView view={callDetail} state={state} />}
				{detailView && <ToolView view={detailView} state={state} />}
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
}
