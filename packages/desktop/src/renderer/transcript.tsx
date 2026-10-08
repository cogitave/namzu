import { Fragment, type ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { type ActivityActions, ActivityActionsContext } from './activity-actions.js'
import { AttachmentList } from './attachment-list.js'
import { ChevronRightIcon } from './icons.js'
import { Message, MessageContent, MessageFooter, timeDescription } from './message.js'
import { PlanRow, PlanTouched } from './plan-row-view.js'
import { isTaskEntry, latestPlanTurn } from './plan-row.js'
import { renderedEqual } from './rendered-equal.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { ToolTranscriptRow, actionIcon } from './tool-transcript-row.js'
import {
	actionRunKind,
	actionRunLabel,
	dateSeparatorFlags,
	dateSeparatorLabel,
	elapsedLabel,
	replyClock,
	runDefaultOpen,
	splitActivity,
	terminalNotice,
	toolGroupLabel,
	transcriptTurns,
	workBlockOpen,
} from './transcript-layout.js'
import { turnInputsUnchanged } from './transcript-memo.js'
import {
	type LiveStage,
	livePhaseLabel,
	liveStatus,
	narrationBeingWritten,
	transcriptEntryKey,
	turnActivityLabel,
	useTranscriptEntryMotion,
	useTranscriptPhaseMotion,
} from './transcript-motion.js'
import { TurnChangesCard } from './turn-changes-card.js'
import { turnChanges, turnUndo } from './turn-changes.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { type WorkDisclosureChoices, workDisclosureKey } from './workspace-presentation.js'
import './transcript-motion.css'

/** A reply is settled once it stops streaming; only then are its file references looked up. */
function replySettled(
	thread: ThreadState,
	entry: Extract<TimelineEntry, { kind: 'message' }>,
	message: ChatMessage | undefined,
): boolean {
	return (
		message?.status !== 'pending' &&
		(!thread.running || entry.turn !== thread.turn || !!thread.turns[entry.turn]?.stopReason)
	)
}

function Entry({
	entry,
	thread,
	action,
	quiet = false,
	showTime = true,
	streaming = false,
}: {
	entry: TimelineEntry
	thread: ThreadState
	/** The reply's action row; shown once the reply has settled. */
	action?: ReactNode
	/** Narration still being written: its newest words shimmer until it completes. */
	streaming?: boolean
	/** Inside a Worked block: no visible clock; the time stays in the row's tooltip. */
	quiet?: boolean
	/** A reply shows one clock, under its last answer; the other answer messages leave it out. */
	showTime?: boolean
}) {
	if (entry.kind === 'tool') {
		const tool = thread.tools[entry.id]
		return tool ? (
			<div
				className="tool-list"
				data-timeline-turn={entry.turn}
				data-transcript-entry-key={transcriptEntryKey(entry)}
			>
				<ToolTranscriptRow thread={thread} id={entry.id} quiet={quiet} />
			</div>
		) : null
	}
	if (entry.kind === 'reasoning') {
		const thought = thread.reasoning[entry.id]
		// A redacted block can drive Thinking, but cannot invent a public body.
		return thought?.text.trim() ? (
			<section
				className="reasoning"
				aria-label="Public reasoning"
				data-timeline-turn={entry.turn}
				data-reasoning-id={entry.id}
				data-transcript-entry-key={transcriptEntryKey(entry)}
				title={timeDescription(thought.startedTime ?? thought.endedTime)}
			>
				<MessageContent text={thought.text} markdown />
			</section>
		) : null
	}
	const message = thread.messages[entry.index]
	const settled = replySettled(thread, entry, message)
	return message?.text.trim() || message?.attachments?.length ? (
		<Message
			from={message.role}
			className={`message ${message.role}${message.phase === 'commentary' ? ' commentary' : ''}`}
			role={message.phase === 'commentary' ? 'group' : undefined}
			aria-label={message.phase === 'commentary' ? 'Progress update' : undefined}
			title={quiet || !showTime ? timeDescription(message.time) : undefined}
			data-timeline-turn={entry.turn}
			data-message-phase={message.phase}
			data-streaming={streaming ? '' : undefined}
			data-transcript-entry-key={transcriptEntryKey(entry)}
		>
			{message.role === 'user' && message.attachments?.length ? (
				<AttachmentList
					attachments={message.attachments}
					layout="cards"
					delivering={message.status === 'pending'}
				/>
			) : null}
			{/* A message of attachments alone has no bubble. */}
			{(message.text.trim() || message.role !== 'user') && (
				<MessageContent
					text={message.text}
					markdown={message.role === 'assistant'}
					settled={settled && message.role === 'assistant'}
				/>
			)}
			{message.role !== 'user' && message.attachments && (
				<div className="mt-2">
					<AttachmentList attachments={message.attachments} />
				</div>
			)}
			<MessageFooter time={quiet || !showTime ? undefined : message.time} focusable>
				{message.role === 'assistant' && message.text.trim() && settled && action}
			</MessageFooter>
		</Message>
	) : null
}

const entryKey = transcriptEntryKey

function DateSeparator({ at }: { at: number }) {
	return (
		<p className="transcript-date-separator">
			<time dateTime={new Date(at).toISOString()}>{dateSeparatorLabel(at)}</time>
		</p>
	)
}

/** Times of the visible messages that start a new stretch of the conversation, by entry key. */
function separatorTimes(
	groups: ReturnType<typeof transcriptTurns>,
	thread: ThreadState,
): Map<string, number> {
	const visible: { key: string; at: number | undefined }[] = []
	for (const group of groups)
		for (const segment of group.segments)
			for (const entry of [...segment.user, ...segment.answer])
				visible.push({
					key: entryKey(entry),
					at: entry.kind === 'message' ? thread.messages[entry.index]?.time?.at : undefined,
				})
	const flags = dateSeparatorFlags(visible.map((item) => item.at))
	const result = new Map<string, number>()
	visible.forEach((item, index) => {
		if (flags[index] && item.at !== undefined) result.set(item.key, item.at)
	})
	return result
}

function PhaseLabel({ label, animate }: { label: string; animate: boolean }) {
	const ref = useRef<HTMLSpanElement>(null)
	useTranscriptPhaseMotion(ref, label, animate)
	return (
		<span className="transcript-phase-label" ref={ref} aria-hidden="true">
			<span className="transcript-phase-text">{label}</span>
		</span>
	)
}

/**
 * Two or more consecutive actions between narration: one summary row that counts what was done,
 * with the rows under it. Open while the work is going, and when it is short.
 */
function ToolRun({
	entries,
	thread,
	last,
	turnLive,
	disclosureKey,
	workDisclosures,
	onWorkDisclosureChange,
}: {
	entries: TimelineEntry[]
	thread: ThreadState
	/** Nothing but this run follows it in the work, so more actions may still join it. */
	last: boolean
	turnLive: boolean
	disclosureKey?: string
	workDisclosures?: WorkDisclosureChoices
	onWorkDisclosureChange?: (key: string, open: boolean) => void
}) {
	const [chosenOpen, setChosenOpen] = useState<boolean>()
	const presentations = entries.flatMap((entry) => {
		const presentation =
			entry.kind === 'tool' ? toolTranscriptPresentation(thread, entry.id) : undefined
		return presentation ? [presentation] : []
	})
	const active = presentations.some((item) => item.state === 'running' || item.state === 'waiting')
	const live = active || (turnLive && last)
	const states = presentations.map((item) => item.state)
	const actions = presentations.map((item) => ({
		kind: item.kind,
		subject: item.file?.path,
		state: item.state,
	}))
	const lookups = presentations.length > 0 && presentations.every((item) => item.kind === 'lookup')
	const label = lookups
		? toolGroupLabel(
				entries.flatMap((entry) =>
					entry.kind === 'tool' && thread.tools[entry.id] ? [thread.tools[entry.id]] : [],
				),
				active,
				states,
			)
		: actionRunLabel(actions, live)
	const Icon = actionIcon(actionRunKind(actions))
	// A run the person watched work stays open when it ends, however long it grew.
	const watched = useRef(false)
	if (live) watched.current = true
	const defaultOpen = watched.current || runDefaultOpen(live, entries.length)
	const controlled = !!disclosureKey && !!onWorkDisclosureChange
	const saved = disclosureKey ? workDisclosures?.[disclosureKey] : undefined
	return (
		<Collapsible
			className={`tool tool-group${active ? ' active' : ''}${states.includes('waiting') ? ' waiting' : ''}`}
			open={controlled ? (saved ?? defaultOpen) : (chosenOpen ?? defaultOpen)}
			onOpenChange={(open) => {
				if (disclosureKey && onWorkDisclosureChange) onWorkDisclosureChange(disclosureKey, open)
				else setChosenOpen(open)
			}}
		>
			<CollapsibleTrigger className="tool-trigger tool-run-trigger">
				<Icon className="tool-icon" aria-hidden="true" />
				<span className="tool-label">{label}</span>
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
			</CollapsibleTrigger>
			<CollapsiblePanel keepMounted>
				<div className="tool-group-entries">
					{entries.map((entry) => (
						<Entry key={entryKey(entry)} entry={entry} thread={thread} quiet />
					))}
				</div>
			</CollapsiblePanel>
		</Collapsible>
	)
}

function ActivityEntries({
	entries,
	thread,
	turn,
	turnLive,
	workDisclosures,
	onWorkDisclosureChange,
	hiddenReasoningId,
	streamingMessage,
}: {
	entries: TimelineEntry[]
	thread: ThreadState
	turn: number
	turnLive: boolean
	/** The reasoning row the status line stands in for. */
	hiddenReasoningId?: string
	/** The narration message being written. */
	streamingMessage?: number
	workDisclosures?: WorkDisclosureChoices
	onWorkDisclosureChange?: (key: string, open: boolean) => void
}) {
	const parts = splitActivity(
		entries.filter(
			(entry) =>
				!(entry.kind === 'reasoning' && entry.id === hiddenReasoningId) &&
				(entry.kind !== 'tool' || (Boolean(thread.tools[entry.id]) && !isTaskEntry(thread, entry))),
		),
	)
	return parts.map((part, index) => {
		if ('entry' in part)
			return (
				<Entry
					key={entryKey(part.entry)}
					entry={part.entry}
					thread={thread}
					quiet
					streaming={part.entry.kind === 'message' && part.entry.index === streamingMessage}
				/>
			)
		const first = part.run[0]
		if (!first) return null
		// One action is just its row; the summary starts at two.
		if (part.run.length === 1)
			return <Entry key={entryKey(first)} entry={first} thread={thread} quiet />
		return (
			<ToolRun
				key={entryKey(first)}
				entries={part.run}
				thread={thread}
				last={index === parts.length - 1}
				turnLive={turnLive}
				disclosureKey={workDisclosureKey(turn, `run:${entryKey(first)}`)}
				workDisclosures={workDisclosures}
				onWorkDisclosureChange={onWorkDisclosureChange}
			/>
		)
	})
}

function hasPublicActivity(entries: TimelineEntry[], thread: ThreadState): boolean {
	return entries.some((entry) => {
		if (entry.kind === 'tool') return Boolean(thread.tools[entry.id])
		if (entry.kind === 'reasoning') return Boolean(thread.reasoning[entry.id]?.text.trim())
		const message = thread.messages[entry.index]
		return Boolean(message?.text.trim() || message?.attachments?.length)
	})
}

function TurnActivity({
	thread,
	turn,
	entries,
	ownsTurnSummary,
	disclosureKey,
	workDisclosures,
	onWorkDisclosureChange,
	answered,
	animate,
	now,
	planTurn,
	onOpenTasks,
}: {
	thread: ThreadState
	turn: number
	entries: TimelineEntry[]
	/** The latest turn that touched the plan; only it draws the plan itself. */
	planTurn?: number
	onOpenTasks?: () => void
	/** The reply text has started, so this work is done even though the turn is still running. */
	answered: boolean
	ownsTurnSummary: boolean
	disclosureKey?: string
	workDisclosures?: WorkDisclosureChoices
	onWorkDisclosureChange?: (key: string, open: boolean) => void
	animate: boolean
	now: number
}) {
	const live = thread.running && thread.stopReason === undefined && thread.turn === turn
	// The task tools' rows fold into one plan row, drawn where the first of them was.
	const planAt = entries.findIndex((entry) => isTaskEntry(thread, entry))
	const planKey = workDisclosureKey(turn, 'plan')
	// Only the block that owns the clock names the stage, and only until the answer starts.
	const status = live && ownsTurnSummary && !answered ? liveStatus(thread) : undefined
	const stage = status?.stage
	const streamingMessage = status ? narrationBeingWritten(thread) : undefined
	// Open while the reply is written, folded once it ends; a choice the person made always wins.
	const [chosenOpen, setChosenOpen] = useState<boolean>()
	const controlled = !!disclosureKey && !!onWorkDisclosureChange
	const savedOpen = disclosureKey ? workDisclosures?.[disclosureKey] : undefined
	const label = ownsTurnSummary ? turnActivityLabel(thread, turn) : 'Earlier work'
	const start = live && ownsTurnSummary ? thread.turns[turn]?.startedAt : undefined
	const elapsed = start === undefined ? undefined : elapsedLabel(now - start)
	const savedTime = ownsTurnSummary
		? (thread.turns[turn]?.startedTime ??
			(thread.turns[turn]?.startedAt === undefined
				? undefined
				: { at: thread.turns[turn].startedAt, source: 'host' as const }))
		: undefined
	const savedDuration =
		ownsTurnSummary &&
		!live &&
		thread.turns[turn]?.recordedDurationMs !== undefined &&
		thread.turns[turn]?.startedAt === undefined
	return (
		<Collapsible
			className="turn-activity"
			// Fold when the answer arrives, not after it: folding later shrinks the page under a reader at the end.
			open={workBlockOpen(controlled ? savedOpen : chosenOpen, live && !answered)}
			onOpenChange={(open) => {
				if (disclosureKey && onWorkDisclosureChange) onWorkDisclosureChange(disclosureKey, open)
				else setChosenOpen(open)
			}}
			data-activity-turn={turn}
			// No choice yet, so any fold is the work finishing: it settles at once, in the same frame the answer lands.
			data-automatic={(controlled ? savedOpen : chosenOpen) === undefined ? '' : undefined}
		>
			<CollapsibleTrigger
				className="activity-trigger"
				aria-label={elapsed ? `${label} for ${elapsed}` : label}
				title={
					savedDuration
						? 'Time reported for this saved work'
						: live
							? undefined
							: timeDescription(savedTime)
				}
				data-duration-source={savedDuration ? 'recorded-runtime' : undefined}
				data-live={live ? '' : undefined}
			>
				<span className="activity-text">
					<PhaseLabel label={label} animate={animate} />
					{elapsed && <span className="turn-activity-elapsed">for {elapsed}</span>}
				</span>
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
			</CollapsibleTrigger>
			<CollapsiblePanel keepMounted>
				<div className="activity-entries">
					{planAt < 0 ? (
						<ActivityEntries
							entries={entries}
							thread={thread}
							turn={turn}
							turnLive={live}
							workDisclosures={workDisclosures}
							onWorkDisclosureChange={onWorkDisclosureChange}
							hiddenReasoningId={status?.hiddenReasoningId}
							streamingMessage={streamingMessage}
						/>
					) : (
						<>
							<ActivityEntries
								entries={entries.slice(0, planAt)}
								thread={thread}
								turn={turn}
								turnLive={live}
								workDisclosures={workDisclosures}
								onWorkDisclosureChange={onWorkDisclosureChange}
								hiddenReasoningId={status?.hiddenReasoningId}
								streamingMessage={streamingMessage}
							/>
							{planTurn === turn ? (
								<PlanRow
									tasks={thread.tasks}
									turnLive={live}
									open={planKey ? workDisclosures?.[planKey] : undefined}
									onOpenChange={
										planKey && onWorkDisclosureChange
											? (open) => onWorkDisclosureChange(planKey, open)
											: undefined
									}
									onOpenTasks={onOpenTasks}
								/>
							) : (
								<PlanTouched />
							)}
							<ActivityEntries
								entries={entries.slice(planAt)}
								thread={thread}
								turn={turn}
								turnLive={live}
								workDisclosures={workDisclosures}
								onWorkDisclosureChange={onWorkDisclosureChange}
								hiddenReasoningId={status?.hiddenReasoningId}
								streamingMessage={streamingMessage}
							/>
						</>
					)}
				</div>
			</CollapsiblePanel>
			{stage && <StageLine stage={stage} animate={animate} />}
		</Collapsible>
	)
}

/**
 * The stage the work is in, one muted line at the bottom of the live block. It keeps its words for the whole stage; a new
 * stage fades in and starts a new sweep, and the same stage re-derived never does.
 */
function StageLine({ stage, animate }: { stage: LiveStage; animate: boolean }) {
	const ref = useRef<HTMLOutputElement>(null)
	const shown = stage
	useTranscriptPhaseMotion(ref, shown.text, animate)
	return (
		<output ref={ref} className="stage-line" data-stage-source={shown.source} aria-live="polite">
			{/* Live regions announce changed text, not a changed label, so the words live in the region. */}
			<span className="transcript-visually-hidden">{shown.text}</span>
			<span className="transcript-phase-label" aria-hidden="true">
				<span key={shown.text} className="transcript-phase-text stage-text">
					{shown.text}
				</span>
			</span>
		</output>
	)
}

function LiveStatus({
	thread,
	animate,
	now,
	visuallyHidden,
	showElapsed,
}: {
	thread: ThreadState
	animate: boolean
	now: number
	visuallyHidden: boolean
	showElapsed: boolean
}) {
	const phase = threadPhase(thread)
	const label = livePhaseLabel(thread)
	const retained = useRef(label)
	const ref = useRef<HTMLOutputElement>(null)
	useTranscriptPhaseMotion(ref, label, animate, true)
	useEffect(() => {
		if (label) retained.current = label
	}, [label])
	const start = thread.turns[thread.turn]?.startedAt
	return (
		<output
			ref={ref}
			className={`working ${phase === 'waiting' ? 'waiting' : ''}${visuallyHidden ? ' transcript-status-only' : ''}`}
			aria-live={label && !visuallyHidden ? 'polite' : 'off'}
			aria-label={label}
			aria-hidden={!label}
			inert={!label}
			data-transcript-phase={phase === 'idle' ? undefined : phase}
		>
			<span className="working-label transcript-phase-label" aria-hidden="true">
				<span className="transcript-phase-text">{label ?? retained.current}</span>
			</span>
			{start !== undefined && showElapsed && !visuallyHidden && (
				<span className="working-elapsed" aria-hidden="true">
					{elapsedLabel(now - start)}
				</span>
			)}
		</output>
	)
}

interface TurnGroupProps {
	thread: ThreadState
	group: ReturnType<typeof transcriptTurns>[number]
	/** Entry key to the time of the date separator drawn above that entry. */
	separators: Record<string, number>
	/** Entry key to the settled reply's action row. */
	actions: Record<string, ReactNode>
	changes: ReturnType<typeof turnChanges> extends Map<number, infer Value>
		? Value | undefined
		: never
	live: boolean
	/** A finished turn away from the end; the browser may skip drawing it while it is off screen. */
	deferred: boolean
	animate: boolean
	now: number
	workDisclosures?: WorkDisclosureChoices
	undoKept?: Record<string, number>
	/** Absent when the caller offers nothing to do; the same function for the life of the transcript. */
	onWorkDisclosureChange?: (key: string, open: boolean) => void
	onOpenTurnChanges?: (receiptIds: string[], path?: string) => void
	onOpenChangedFile?: (path: string) => void
	onUndoTurn?: (turnId: string) => void
	projectRoot?: string
	/** The latest turn that touched the plan. */
	planTurn?: number
	/** Opens the full task list; the same function for the life of the transcript. */
	onOpenTasks?: () => void
}

function shallowEqual(a: object | undefined, b: object | undefined): boolean {
	if (a === b) return true
	if (!a || !b) return false
	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>
	const keys = Object.keys(left)
	return (
		keys.length === Object.keys(right).length &&
		keys.every((key) => Object.is(left[key], right[key]))
	)
}

/**
 * A turn that is not being written redraws only when its own rows' data changes, so a streamed
 * delta in the last turn no longer reconciles every earlier turn.
 */
const TurnGroupView = memo(function TurnGroupView({
	thread,
	group,
	separators,
	actions,
	changes,
	live,
	deferred,
	animate,
	now,
	workDisclosures,
	undoKept,
	onWorkDisclosureChange,
	onOpenTurnChanges,
	onOpenChangedFile,
	onUndoTurn,
	projectRoot,
	planTurn,
	onOpenTasks,
}: TurnGroupProps) {
	const actionsValue = useMemo<ActivityActions>(
		() => ({ changes, projectRoot, onOpenTurnChanges, onOpenChangedFile }),
		[changes, projectRoot, onOpenTurnChanges, onOpenChangedFile],
	)
	const clock = replyClock(thread, group, live)
	return (
		<ActivityActionsContext.Provider value={actionsValue}>
			<div
				className="transcript-turn"
				data-transcript-turn={group.turn}
				data-transcript-live={live ? '' : undefined}
				data-transcript-deferred={deferred && !live ? '' : undefined}
			>
				{group.segments.map((segment, index) => (
					<Fragment
						key={
							segment.user[0]
								? entryKey(segment.user[0])
								: segment.activity[0]
									? entryKey(segment.activity[0])
									: segment.answer[0]
										? entryKey(segment.answer[0])
										: `${group.turn}:${index}`
						}
					>
						{segment.user.map((entry) => (
							<Fragment key={entryKey(entry)}>
								{entryKey(entry) in separators && (
									<DateSeparator at={separators[entryKey(entry)] as number} />
								)}
								<Entry entry={entry} thread={thread} />
							</Fragment>
						))}
						{hasPublicActivity(segment.activity, thread) && (
							<TurnActivity
								thread={thread}
								turn={group.turn}
								entries={segment.activity}
								disclosureKey={
									segment.activity[0]
										? workDisclosureKey(group.turn, entryKey(segment.activity[0]))
										: undefined
								}
								workDisclosures={workDisclosures}
								onWorkDisclosureChange={onWorkDisclosureChange}
								ownsTurnSummary={
									!group.segments
										.slice(index + 1)
										.some((later) => hasPublicActivity(later.activity, thread))
								}
								answered={hasPublicActivity(segment.answer, thread)}
								animate={animate}
								now={now}
								planTurn={planTurn}
								onOpenTasks={onOpenTasks}
							/>
						)}
						{segment.answer.map((entry) => (
							<Fragment key={entryKey(entry)}>
								{entryKey(entry) in separators && (
									<DateSeparator at={separators[entryKey(entry)] as number} />
								)}
								<Entry
									entry={entry}
									thread={thread}
									action={actions[entryKey(entry)]}
									showTime={clock?.at === 'answer' && clock.entry === entry}
								/>
							</Fragment>
						))}
					</Fragment>
				))}
				{clock?.at === 'turn' && (
					<Message from="assistant" className="message assistant turn-clock">
						<MessageFooter time={clock.time} focusable />
					</Message>
				)}
				{onOpenTurnChanges && changes && !live && (
					<TurnChangesCard
						changes={changes}
						onOpen={onOpenTurnChanges}
						onOpenFile={onOpenChangedFile}
						{...turnUndo(thread, group.turn, onUndoTurn, undoKept)}
					/>
				)}
			</div>
		</ActivityActionsContext.Provider>
	)
}, turnGroupPropsEqual)

function turnGroupPropsEqual(previous: TurnGroupProps, next: TurnGroupProps): boolean {
	if (
		previous.live !== next.live ||
		previous.deferred !== next.deferred ||
		previous.animate !== next.animate ||
		previous.now !== next.now ||
		previous.changes !== next.changes ||
		previous.projectRoot !== next.projectRoot ||
		previous.workDisclosures !== next.workDisclosures ||
		// The caller builds this record anew on every render.
		!shallowEqual(previous.undoKept, next.undoKept) ||
		previous.onWorkDisclosureChange !== next.onWorkDisclosureChange ||
		previous.onOpenTurnChanges !== next.onOpenTurnChanges ||
		previous.onOpenChangedFile !== next.onOpenChangedFile ||
		previous.onUndoTurn !== next.onUndoTurn ||
		previous.planTurn !== next.planTurn ||
		previous.onOpenTasks !== next.onOpenTasks ||
		!shallowEqual(previous.separators, next.separators)
	)
		return false
	const keys = Object.keys(next.actions)
	if (
		keys.length !== Object.keys(previous.actions).length ||
		!keys.every((key) => renderedEqual(previous.actions[key], next.actions[key]))
	)
		return false
	return turnInputsUnchanged(previous, next)
}

export function Transcript({
	thread,
	animate = false,
	renderMessageAction,
	workDisclosures,
	onWorkDisclosureChange,
	onOpenTurnChanges,
	onOpenChangedFile,
	onUndoTurn,
	onOpenTasks,
	undoKept,
	projectRoot,
	dateSeparators = true,
}: {
	thread: ThreadState
	animate?: boolean
	renderMessageAction?: (message: ChatMessage, key: string) => ReactNode
	workDisclosures?: WorkDisclosureChoices
	onWorkDisclosureChange?: (key: string, open: boolean) => void
	/** Receipt ids of the edits one reply made; without it no per-reply edit card shows. */
	onOpenTurnChanges?: (receiptIds: string[], path?: string) => void
	/** Shows an edited file in the side panel; absent when the project's files are not available. */
	onOpenChangedFile?: (path: string) => void
	/** Opens the undo dialog for a reply by its journal turn id; absent where the CLI cannot undo. */
	onUndoTurn?: (turnId: string) => void
	/** Opens the full task list, for the plan row's "+N more". */
	onOpenTasks?: () => void
	/** Files a partly undone reply still has to finish, by turn id. */
	undoKept?: Record<string, number>
	/** The conversation's folder; relative paths in action rows show in full against it. */
	projectRoot?: string
	dateSeparators?: boolean
}) {
	const ref = useRef<HTMLDivElement>(null)
	useTranscriptEntryMotion(ref, thread, animate)
	// The caller builds these handlers anew on every render. A settled turn must not redraw for
	// that, so each is passed as one function that calls the newest one.
	const handlers = useRef({
		onWorkDisclosureChange,
		onOpenTurnChanges,
		onOpenChangedFile,
		onUndoTurn,
		onOpenTasks,
	})
	handlers.current = {
		onWorkDisclosureChange,
		onOpenTurnChanges,
		onOpenChangedFile,
		onUndoTurn,
		onOpenTasks,
	}
	const stable = useMemo(
		() => ({
			onWorkDisclosureChange: (key: string, open: boolean) =>
				handlers.current.onWorkDisclosureChange?.(key, open),
			onOpenTurnChanges: (ids: string[], path?: string) =>
				handlers.current.onOpenTurnChanges?.(ids, path),
			onOpenChangedFile: (path: string) => handlers.current.onOpenChangedFile?.(path),
			onUndoTurn: (turnId: string) => handlers.current.onUndoTurn?.(turnId),
			onOpenTasks: () => handlers.current.onOpenTasks?.(),
		}),
		[],
	)
	const notice = !thread.running
		? terminalNotice(thread.turns[thread.turn]?.reason ?? thread.stopReason)
		: undefined
	const groups = transcriptTurns(thread)
	const { timeline, tools } = thread
	const planTurn = useMemo(() => latestPlanTurn({ timeline, tools }), [timeline, tools])
	// Line totals are costly to recompute for every streamed token, so they follow the receipts. The
	// handler is built anew on every render, so only whether there is one may key the totals.
	const showsChanges = Boolean(onOpenTurnChanges)
	const changes = useMemo(
		() => (showsChanges ? turnChanges({ timeline, tools }) : new Map()),
		[timeline, tools, showsChanges],
	)
	const separators = dateSeparators ? separatorTimes(groups, thread) : new Map<string, number>()
	const hasLiveActivity =
		thread.running &&
		groups.some(
			(group) =>
				group.turn === thread.turn &&
				group.segments.some((segment) => hasPublicActivity(segment.activity, thread)),
		)
	// The stage line under the clock names the state once there is work to show.
	const visuallyHidden = hasLiveActivity
	const [now, setNow] = useState(Date.now)
	const start = thread.turns[thread.turn]?.startedAt
	useEffect(() => {
		if (!thread.running || thread.stopReason !== undefined || start === undefined) return
		setNow(Date.now())
		const timer = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(timer)
	}, [thread.running, thread.stopReason, start])
	return (
		<div className="normal-transcript" ref={ref}>
			{thread.historyWorkPartial && (
				<p className="notice">Some saved work details are unavailable.</p>
			)}
			{groups.map((group, position) => {
				const live = thread.running && thread.stopReason === undefined && thread.turn === group.turn
				const groupSeparators: Record<string, number> = {}
				const actions: Record<string, ReactNode> = {}
				for (const entry of group.segments.flatMap((segment) => [
					...segment.user,
					...segment.answer,
				])) {
					const at = separators.get(entryKey(entry))
					if (at !== undefined) groupSeparators[entryKey(entry)] = at
				}
				if (renderMessageAction)
					for (const entry of group.answer) {
						const message = entry.kind === 'message' ? thread.messages[entry.index] : undefined
						if (
							entry.kind === 'message' &&
							message?.role === 'assistant' &&
							message.text.trim() &&
							replySettled(thread, entry, message)
						)
							actions[entryKey(entry)] = renderMessageAction(message, entryKey(entry))
					}
				return (
					<TurnGroupView
						key={group.turn}
						thread={thread}
						group={group}
						separators={groupSeparators}
						actions={actions}
						changes={changes.get(group.turn)}
						live={live}
						deferred={position < groups.length - 2}
						animate={animate}
						// Only the turn being written shows an elapsed clock.
						now={live ? now : 0}
						workDisclosures={workDisclosures}
						undoKept={undoKept}
						projectRoot={projectRoot}
						onWorkDisclosureChange={
							onWorkDisclosureChange ? stable.onWorkDisclosureChange : undefined
						}
						onOpenTurnChanges={onOpenTurnChanges ? stable.onOpenTurnChanges : undefined}
						onOpenChangedFile={onOpenChangedFile ? stable.onOpenChangedFile : undefined}
						onUndoTurn={onUndoTurn ? stable.onUndoTurn : undefined}
						planTurn={planTurn}
						onOpenTasks={onOpenTasks ? stable.onOpenTasks : undefined}
					/>
				)
			})}
			<LiveStatus
				thread={thread}
				animate={animate}
				now={now}
				visuallyHidden={visuallyHidden}
				showElapsed={!hasLiveActivity}
			/>
			{notice && <p className="notice">{notice}</p>}
		</div>
	)
}
