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
import { MessageTime, timeDescription } from './message.js'
import { ToolBodyView } from './tool-output-view.js'
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

/** The duration rides the tooltip a row already has, so a sighted reader sees it too. */
function withTook(text: string, took: string | undefined): string {
	return took ? `${text} · ${took}` : text
}

/** One admitted action: a one-line row, with a disclosure only when there is output to inspect. */
export function ToolTranscriptRow({
	thread,
	id,
	onOpenChange,
	quiet = false,
}: {
	thread: ThreadState
	id: string
	onOpenChange?: (open: boolean) => void
	/** Inside a Worked block: no visible clock; the time stays in the row's tooltip. */
	quiet?: boolean
}) {
	const actions = useContext(ActivityActionsContext)
	const [focused, setFocused] = useState(false)
	const tool = thread.tools[id]
	const presentation = toolTranscriptPresentation(thread, id)
	if (!tool || !presentation) return null
	const {
		label,
		state,
		statusLabel,
		detailView,
		callDetail,
		quietCompleted,
		kind,
		lead,
		file,
		main,
		tail,
		stats,
		body,
	} = presentation
	const Icon = actionIcon(kind)
	const active = state === 'running' || state === 'waiting'
	const expandable = Boolean(callDetail || detailView || body || tool.progress)
	// A declined change never happened, so there is no file to open; its note is what the row opens to.
	// A call that failed for want of the file has nothing to open.
	const opens =
		state !== 'declined' &&
		!(state === 'failed' && tail) &&
		file &&
		(kind === 'edit' || kind === 'read')
			? kind === 'edit'
				? openTarget(actions, file.path) !== undefined
				: Boolean(actions?.onOpenChangedFile)
			: false
	// A clock beside every row is noise; a call that took a second or more says so on hover and to screen readers.
	const took =
		tool.durationMs !== undefined && Number.isFinite(tool.durationMs) && tool.durationMs >= 1000
			? `Took ${elapsedLabel(tool.durationMs)}`
			: undefined
	// Screen readers get the command or the full path the sighted reader sees in the tooltip.
	const quietTime = quiet ? timeDescription(tool.startedTime ?? tool.endedTime) : undefined
	const subject = file ? fullPath(file.path, actions?.projectRoot) : presentation.tooltip
	const description = [subject, quietTime, took].filter(Boolean).join('. ') || undefined
	const focusProps = {
		'aria-description': description,
		onFocus: (event: React.FocusEvent<HTMLElement>) =>
			setFocused(focusVisible(event.currentTarget)),
		onBlur: () => setFocused(false),
	}
	const name = file ? (
		<Tip
			className="tool-file"
			text={withTook(fullPath(file.path, actions?.projectRoot), took)}
			focused={focused}
		>
			{file.name}
		</Tip>
	) : null
	const tailText = tail ? <span className={`tool-tail ${state}`}>{tail}</span> : null
	const changed =
		stats && (stats.added > 0 || stats.removed > 0) ? (
			<span className="tool-stats">
				{stats.added > 0 && <span className="tool-stats-added">+{stats.added}</span>}
				{stats.removed > 0 && <span className="tool-stats-removed">−{stats.removed}</span>}
			</span>
		) : null
	// What follows the headline (how it ended, how much changed) never shrinks: only the words
	// before it are cut with an ellipsis when the row is narrow.
	const split = tailText || changed ? ' tool-label-split' : ''
	const text =
		lead && file ? (
			<span className={`tool-label${split}`}>
				<span className="tool-main">
					{lead} {name}
				</span>
				{tailText}
				{changed}
			</span>
		) : presentation.tooltip ? (
			<span className={`tool-label${split}`}>
				<span className="tool-main">
					<Tip
						className="tool-tip-text"
						text={withTook(presentation.tooltip, took)}
						focused={focused}
					>
						{main ?? label}
					</Tip>
				</span>
				{tailText}
			</span>
		) : (
			<span className={`tool-label${split}`}>
				<span className="tool-main">{main ?? label}</span>
				{tailText}
			</span>
		)
	// A failed command already says how it ended after its headline ("· failed (exit 3)"): the
	// separate badge would say it twice, so it stays for screen readers only.
	const quietStatus = quietCompleted || (state === 'failed' && kind === 'command' && Boolean(tail))
	const trailing = (
		<>
			<span className={quietStatus ? 'tool-status transcript-visually-hidden' : 'tool-status'}>
				{statusLabel}
			</span>
			{!quiet && <MessageTime time={tool.startedTime ?? tool.endedTime} />}
		</>
	)
	const props = {
		className: `tool ${state}${active ? ' active' : ''} tool-kind-${kind}`,
		'data-tool-call-id': tool.toolCallId,
		'data-tool-state': state,
		// A row with its own hover tooltip carries the time for screen readers only.
		title:
			!file && !presentation.tooltip
				? [quietTime, took].filter(Boolean).join('. ') || undefined
				: undefined,
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
					{trailing}
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
					{trailing}
				</div>
			</div>
		)
	return (
		<Collapsible {...props} onOpenChange={onOpenChange}>
			<CollapsibleTrigger className="tool-trigger" {...focusProps}>
				<Icon className="tool-icon" aria-hidden="true" />
				{text}
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
				{trailing}
			</CollapsibleTrigger>
			<CollapsiblePanel>
				{callDetail && <ToolView view={callDetail} state={state} />}
				{body ? <ToolBodyView body={body} /> : null}
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
