import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { AttachmentList } from './attachment-list.js'
import { ChevronRightIcon, SearchIcon } from './icons.js'
import { Message, MessageContent, MessageFooter, MessageTime } from './message.js'
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

function Entry({
	entry,
	thread,
	onToolOpenChange,
	renderMessageAction,
}: {
	entry: TimelineEntry
	thread: ThreadState
	onToolOpenChange?: (open: boolean) => void
	renderMessageAction?: (message: ChatMessage, key: string) => ReactNode
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
	// A reply is settled once it stops streaming; only then are its file references looked up.
	const settled =
		message?.status !== 'pending' &&
		(!thread.running || entry.turn !== thread.turn || !!thread.turns[entry.turn]?.stopReason)
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
				{message.role === 'assistant' &&
					message.text.trim() &&
					settled &&
					renderMessageAction?.(message, entryKey(entry))}
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
	const notice = !thread.running
		? terminalNotice(thread.turns[thread.turn]?.reason ?? thread.stopReason)
		: undefined
	const groups = transcriptTurns(thread)
	const { timeline, tools } = thread
	// Line totals are costly to recompute for every streamed token, so they follow the receipts.
	const changes = useMemo(
		() => (onOpenTurnChanges ? turnChanges({ timeline, tools }) : new Map()),
		[timeline, tools, onOpenTurnChanges],
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
			{groups.map((group) => (
				<div className="transcript-turn" key={group.turn} data-transcript-turn={group.turn}>
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
									{separators.has(entryKey(entry)) && (
										<DateSeparator at={separators.get(entryKey(entry)) as number} />
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
									{separators.has(entryKey(entry)) && (
										<DateSeparator at={separators.get(entryKey(entry)) as number} />
									)}
									<Entry entry={entry} thread={thread} renderMessageAction={renderMessageAction} />
								</Fragment>
							))}
						</Fragment>
					))}
					{onOpenTurnChanges &&
						changes.has(group.turn) &&
						!(thread.running && thread.stopReason === undefined && thread.turn === group.turn) && (
							<TurnChangesCard
								changes={changes.get(group.turn)}
								onOpen={onOpenTurnChanges}
								onOpenFile={onOpenChangedFile}
								{...turnUndo(thread, group.turn, onUndoTurn, undoKept)}
							/>
						)}
				</div>
			))}
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
