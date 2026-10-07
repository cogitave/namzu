import { type ReactNode, useContext, useState } from 'react'
import type { ThreadState } from '../shared/projection.js'
import { ActivityActionsContext, fullPath, openAction, openTarget } from './activity-actions.js'
import {
	ChevronRightIcon,
	FileTextIcon,
	PencilIcon,
	SearchIcon,
	TerminalIcon,
	WrenchIcon,
} from './icons.js'
import { MessageTime } from './message.js'
import { type ActionKind, toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { ToolView } from './tool-view.js'
import { elapsedLabel } from './transcript-layout.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

export function actionIcon(kind: ActionKind) {
	return kind === 'command'
		? TerminalIcon
		: kind === 'edit'
			? PencilIcon
			: kind === 'read'
				? FileTextIcon
				: kind === 'search' || kind === 'web' || kind === 'lookup'
					? SearchIcon
					: WrenchIcon
}

/** Hover or keyboard focus on a row shows the text; the row itself is the focus stop. */
function Tip({
	text,
	focused,
	className,
	children,
}: {
	text: string
	focused: boolean
	className: string
	children: ReactNode
}) {
	const [hover, setHover] = useState(false)
	return (
		<Tooltip open={hover || focused} onOpenChange={setHover}>
			<TooltipTrigger render={<span className={className} />}>{children}</TooltipTrigger>
			<TooltipPopup variant="code" side="top">
				{text}
			</TooltipPopup>
		</Tooltip>
	)
}

function focusVisible(target: HTMLElement): boolean {
	try {
		return target.matches(':focus-visible')
	} catch {
		return true
	}
}

/** One admitted action: a one-line row, with a disclosure only when there is output to inspect. */
export function ToolTranscriptRow({
	thread,
	id,
	onOpenChange,
}: {
	thread: ThreadState
	id: string
	onOpenChange?: (open: boolean) => void
}) {
	const actions = useContext(ActivityActionsContext)
	const [focused, setFocused] = useState(false)
	const tool = thread.tools[id]
	const presentation = toolTranscriptPresentation(thread, id)
	if (!tool || !presentation) return null
	const { label, state, statusLabel, detailView, callDetail, quietCompleted, kind, lead, file } =
		presentation
	const Icon = actionIcon(kind)
	const active = state === 'running' || state === 'waiting'
	const expandable = Boolean(callDetail || detailView || tool.progress)
	const opens =
		file && (kind === 'edit' || kind === 'read')
			? kind === 'edit'
				? openTarget(actions, file.path) !== undefined
				: Boolean(actions?.onOpenChangedFile)
			: false
	const duration =
		tool.durationMs !== undefined && Number.isFinite(tool.durationMs) && tool.durationMs >= 0
			? tool.durationMs < 1000
				? `${tool.durationMs} ms`
				: elapsedLabel(tool.durationMs)
			: undefined
	// Screen readers get the command or the full path the sighted reader sees in the tooltip.
	const description = file ? fullPath(file.path, actions?.projectRoot) : presentation.tooltip
	const focusProps = {
		'aria-description': description,
		onFocus: (event: React.FocusEvent<HTMLElement>) =>
			setFocused(focusVisible(event.currentTarget)),
		onBlur: () => setFocused(false),
	}
	const name = file ? (
		<Tip className="tool-file" text={fullPath(file.path, actions?.projectRoot)} focused={focused}>
			{file.name}
		</Tip>
	) : null
	const text =
		lead && file ? (
			<span className="tool-label">
				{lead} {name}
			</span>
		) : presentation.tooltip ? (
			<span className="tool-label">
				<Tip className="tool-tip-text" text={presentation.tooltip} focused={focused}>
					{label}
				</Tip>
			</span>
		) : (
			<span className="tool-label">{label}</span>
		)
	const tail = (
		<>
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
		</>
	)
	const props = {
		className: `tool ${state}${active ? ' active' : ''} tool-kind-${kind}`,
		'data-tool-call-id': tool.toolCallId,
		'data-tool-state': state,
	}
	if (opens && file && actions)
		return (
			<div {...props}>
				<button
					type="button"
					className="tool-trigger tool-open"
					aria-label={label}
					onClick={() => openAction(actions, file.path)}
					{...focusProps}
				>
					<Icon className="tool-icon" aria-hidden="true" />
					{text}
					{tail}
				</button>
			</div>
		)
	if (!expandable)
		return (
			<div {...props}>
				{/* A row whose only extra is a tooltip is still a keyboard stop, so focus can show it. */}
				<div
					className="tool-trigger tool-summary"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip must be reachable without a pointer
					tabIndex={file || presentation.tooltip ? 0 : undefined}
					{...focusProps}
				>
					<Icon className="tool-icon" aria-hidden="true" />
					{text}
					{tail}
				</div>
			</div>
		)
	return (
		<Collapsible {...props} onOpenChange={onOpenChange}>
			<CollapsibleTrigger className="tool-trigger" {...focusProps}>
				<Icon className="tool-icon" aria-hidden="true" />
				{text}
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
				{tail}
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
