import { Fragment, type ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { AttachmentList } from './attachment-list.js'
import { ChevronRightIcon, SearchIcon } from './icons.js'
import { Message, MessageContent, MessageFooter, MessageTime } from './message.js'
import { renderedEqual } from './rendered-equal.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { ToolTranscriptRow } from './tool-transcript-row.js'
import {
	dateSeparatorFlags,
	dateSeparatorLabel,
	elapsedLabel,
	terminalNotice,
	toolGroupLabel,
	transcriptTurns,
} from './transcript-layout.js'
import { turnInputsUnchanged } from './transcript-memo.js'
import {
	livePhaseLabel,
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
	onToolOpenChange,
	action,
}: {
	entry: TimelineEntry
	thread: ThreadState
	onToolOpenChange?: (open: boolean) => void
	/** The reply's action row; shown once the reply has settled. */
	action?: ReactNode
}) {
	if (entry.kind === 'tool') {
		const tool = thread.tools[entry.id]
		return tool ? (
			<div
				className="tool-list"
				data-timeline-turn={entry.turn}
				data-transcript-entry-key={transcriptEntryKey(entry)}
			>
				<ToolTranscriptRow thread={thread} id={entry.id} onOpenChange={onToolOpenChange} />
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
			>
				<MessageContent text={thought.text} markdown />
				<MessageTime time={thought.startedTime ?? thought.endedTime} focusable />
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
			data-timeline-turn={entry.turn}
			data-message-phase={message.phase}
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
			<MessageFooter time={message.time} focusable>
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

function ToolGroup({ entries, thread }: { entries: TimelineEntry[]; thread: ThreadState }) {
	const [chosenOpen, setChosenOpen] = useState<boolean>()
	const [openTools, setOpenTools] = useState<string[]>([])
	const multiple = entries.length > 1
	const tools = entries.flatMap((entry) =>
		entry.kind === 'tool' && thread.tools[entry.id] ? [thread.tools[entry.id]] : [],
	)
	const states = entries.flatMap((entry) => {
		const presentation =
			entry.kind === 'tool' ? toolTranscriptPresentation(thread, entry.id) : undefined
		return presentation ? [presentation.state] : []
	})
	const active = states.some((state) => state === 'running' || state === 'waiting')
	return (
		<Collapsible
			className={`tool ${multiple ? 'tool-group' : ''} ${active ? 'active' : ''}`}
			open={!multiple || (chosenOpen ?? openTools.length > 0)}
			onOpenChange={setChosenOpen}
		>
			{multiple && (
				<CollapsibleTrigger className="tool-trigger">
					<SearchIcon className="tool-icon" aria-hidden="true" />
					<span className="tool-label">{toolGroupLabel(tools, active, states)}</span>
					<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
				</CollapsibleTrigger>
			)}
			<CollapsiblePanel keepMounted>
				<div className={multiple ? 'tool-group-entries' : ''}>
					{entries.map((entry) => (
						<Entry
							key={entryKey(entry)}
							entry={entry}
							thread={thread}
							onToolOpenChange={(open) =>
								setOpenTools((previous) =>
									open
										? [...previous.filter((id) => id !== entryKey(entry)), entryKey(entry)]
										: previous.filter((id) => id !== entryKey(entry)),
								)
							}
						/>
					))}
				</div>
			</CollapsiblePanel>
		</Collapsible>
	)
}

function ActivityEntries({
	entries,
	thread,
}: {
	entries: TimelineEntry[]
	thread: ThreadState
}) {
	const groups: TimelineEntry[][] = []
	for (const entry of entries) {
		const last = groups.at(-1)
		const earlierLookup =
			entry.kind === 'tool' &&
			Boolean(thread.tools[entry.id]) &&
			thread.tools[entry.id]?.title === 'search_conversation'
		const previous = last?.at(-1)
		if (
			earlierLookup &&
			previous?.kind === 'tool' &&
			thread.tools[previous.id]?.title === 'search_conversation'
		)
			last?.push(entry)
		else groups.push([entry])
	}
	return groups.map((group) => {
		const first = group[0]
		if (!first) return null
		return first.kind === 'tool' ? (
			<ToolGroup key={entryKey(first)} entries={group} thread={thread} />
		) : (
			<Entry key={entryKey(first)} entry={first} thread={thread} />
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
	animate,
	now,
}: {
	thread: ThreadState
	turn: number
	entries: TimelineEntry[]
	ownsTurnSummary: boolean
	disclosureKey?: string
	workDisclosures?: WorkDisclosureChoices
	onWorkDisclosureChange?: (key: string, open: boolean) => void
	animate: boolean
	now: number
}) {
	const live = thread.running && thread.stopReason === undefined && thread.turn === turn
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
			open={controlled ? (savedOpen ?? live) : (chosenOpen ?? live)}
			onOpenChange={(open) => {
				if (disclosureKey && onWorkDisclosureChange) onWorkDisclosureChange(disclosureKey, open)
				else setChosenOpen(open)
			}}
			data-activity-turn={turn}
		>
			<CollapsibleTrigger
				className="activity-trigger"
				aria-label={elapsed ? `${label} for ${elapsed}` : label}
				title={savedDuration ? 'Time reported for this saved work' : undefined}
				data-duration-source={savedDuration ? 'recorded-runtime' : undefined}
			>
				<PhaseLabel label={label} animate={animate} />
				{elapsed && <span className="turn-activity-elapsed">for {elapsed}</span>}
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
				{!live && <MessageTime time={savedTime} />}
			</CollapsibleTrigger>
			<CollapsiblePanel keepMounted>
				<div className="activity-entries">
					<ActivityEntries entries={entries} thread={thread} />
				</div>
			</CollapsiblePanel>
		</Collapsible>
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
			aria-live={label ? 'polite' : 'off'}
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
}: TurnGroupProps) {
	return (
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
							animate={animate}
							now={now}
						/>
					)}
					{segment.answer.map((entry) => (
						<Fragment key={entryKey(entry)}>
							{entryKey(entry) in separators && (
								<DateSeparator at={separators[entryKey(entry)] as number} />
							)}
							<Entry entry={entry} thread={thread} action={actions[entryKey(entry)]} />
						</Fragment>
					))}
				</Fragment>
			))}
			{onOpenTurnChanges && changes && !live && (
				<TurnChangesCard
					changes={changes}
					onOpen={onOpenTurnChanges}
					onOpenFile={onOpenChangedFile}
					{...turnUndo(thread, group.turn, onUndoTurn, undoKept)}
				/>
			)}
		</div>
	)
}, turnGroupPropsEqual)

function turnGroupPropsEqual(previous: TurnGroupProps, next: TurnGroupProps): boolean {
	if (
		previous.live !== next.live ||
		previous.deferred !== next.deferred ||
		previous.animate !== next.animate ||
		previous.now !== next.now ||
		previous.changes !== next.changes ||
		previous.workDisclosures !== next.workDisclosures ||
		// The caller builds this record anew on every render.
		!shallowEqual(previous.undoKept, next.undoKept) ||
		previous.onWorkDisclosureChange !== next.onWorkDisclosureChange ||
		previous.onOpenTurnChanges !== next.onOpenTurnChanges ||
		previous.onOpenChangedFile !== next.onOpenChangedFile ||
		previous.onUndoTurn !== next.onUndoTurn ||
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
	undoKept,
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
	/** Files a partly undone reply still has to finish, by turn id. */
	undoKept?: Record<string, number>
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
	})
	handlers.current = { onWorkDisclosureChange, onOpenTurnChanges, onOpenChangedFile, onUndoTurn }
	const stable = useMemo(
		() => ({
			onWorkDisclosureChange: (key: string, open: boolean) =>
				handlers.current.onWorkDisclosureChange?.(key, open),
			onOpenTurnChanges: (ids: string[], path?: string) =>
				handlers.current.onOpenTurnChanges?.(ids, path),
			onOpenChangedFile: (path: string) => handlers.current.onOpenChangedFile?.(path),
			onUndoTurn: (turnId: string) => handlers.current.onUndoTurn?.(turnId),
		}),
		[],
	)
	const notice = !thread.running
		? terminalNotice(thread.turns[thread.turn]?.reason ?? thread.stopReason)
		: undefined
	const groups = transcriptTurns(thread)
	const { timeline, tools } = thread
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
	const phase = threadPhase(thread)
	const visuallyHidden = hasLiveActivity && phase !== 'thinking' && phase !== 'waiting'
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
						onWorkDisclosureChange={
							onWorkDisclosureChange ? stable.onWorkDisclosureChange : undefined
						}
						onOpenTurnChanges={onOpenTurnChanges ? stable.onOpenTurnChanges : undefined}
						onOpenChangedFile={onOpenChangedFile ? stable.onOpenChangedFile : undefined}
						onUndoTurn={onUndoTurn ? stable.onUndoTurn : undefined}
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
