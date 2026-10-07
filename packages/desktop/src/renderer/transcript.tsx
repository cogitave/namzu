import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { AttachmentList } from './attachment-list.js'
import { ChevronRightIcon, SearchIcon } from './icons.js'
import { Message, MessageContent, MessageTime } from './message.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { ToolTranscriptRow } from './tool-transcript-row.js'
import {
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
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
			<div
				className="reasoning"
				data-timeline-turn={entry.turn}
				data-reasoning-id={entry.id}
				data-transcript-entry-key={transcriptEntryKey(entry)}
			>
				<span className="transcript-content-label">Reasoning</span>
				<MessageContent text={thought.text} markdown />
				<MessageTime time={thought.startedTime ?? thought.endedTime} focusable />
			</div>
		) : null
	}
	const message = thread.messages[entry.index]
	return message?.text.trim() || message?.attachments?.length ? (
		<Message
			from={message.role}
			className={`message ${message.role}${message.phase === 'commentary' ? ' commentary' : ''}`}
			data-timeline-turn={entry.turn}
			data-message-phase={message.phase}
			data-transcript-entry-key={transcriptEntryKey(entry)}
		>
			{message.phase === 'commentary' && <span className="transcript-content-label">Update</span>}
			<MessageContent text={message.text} markdown={message.role === 'assistant'} />
			{message.attachments && (
				<div className="mt-2">
					<AttachmentList attachments={message.attachments} />
				</div>
			)}
			<MessageTime time={message.time} focusable />
			{message.role === 'assistant' &&
				message.text.trim() &&
				message.status !== 'pending' &&
				(!thread.running || entry.turn !== thread.turn || thread.turns[entry.turn]?.stopReason) &&
				renderMessageAction?.(message, entryKey(entry))}
		</Message>
	) : null
}

const entryKey = transcriptEntryKey

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
	renderMessageAction,
}: {
	entries: TimelineEntry[]
	thread: ThreadState
	renderMessageAction?: (message: ChatMessage, key: string) => ReactNode
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
			<Entry
				key={entryKey(first)}
				entry={first}
				thread={thread}
				renderMessageAction={renderMessageAction}
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
	animate,
	renderMessageAction,
	now,
}: {
	thread: ThreadState
	turn: number
	entries: TimelineEntry[]
	animate: boolean
	renderMessageAction?: (message: ChatMessage, key: string) => ReactNode
	now: number
}) {
	const live = thread.running && thread.stopReason === undefined && thread.turn === turn
	const [chosenOpen, setChosenOpen] = useState<boolean>()
	const label = live ? (livePhaseLabel(thread) ?? 'Working') : turnActivityLabel(thread, turn)
	const start = live ? thread.turns[turn]?.startedAt : undefined
	const elapsed = start === undefined ? undefined : elapsedLabel(now - start)
	const savedTime =
		thread.turns[turn]?.startedTime ??
		(thread.turns[turn]?.startedAt === undefined
			? undefined
			: { at: thread.turns[turn].startedAt, source: 'host' as const })
	const savedDuration =
		!live &&
		thread.turns[turn]?.recordedDurationMs !== undefined &&
		thread.turns[turn]?.startedAt === undefined
	return (
		<Collapsible
			className="turn-activity"
			open={chosenOpen ?? live}
			onOpenChange={setChosenOpen}
			data-activity-turn={turn}
		>
			<CollapsibleTrigger
				className="activity-trigger"
				aria-label={elapsed ? `${label} · ${elapsed}` : label}
				title={savedDuration ? 'Time reported for this saved work' : undefined}
				data-duration-source={savedDuration ? 'recorded-runtime' : undefined}
			>
				<PhaseLabel label={label} animate={animate} />
				{elapsed && <span className="turn-activity-elapsed">{elapsed}</span>}
				{!live && <MessageTime time={savedTime} />}
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<div className="activity-entries">
					<ActivityEntries
						entries={entries}
						thread={thread}
						renderMessageAction={renderMessageAction}
					/>
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
}: {
	thread: ThreadState
	animate: boolean
	now: number
	visuallyHidden: boolean
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
			{start !== undefined && !visuallyHidden && (
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
}: {
	thread: ThreadState
	animate?: boolean
	renderMessageAction?: (message: ChatMessage, key: string) => ReactNode
}) {
	const ref = useRef<HTMLDivElement>(null)
	useTranscriptEntryMotion(ref, thread, animate)
	const notice = !thread.running
		? terminalNotice(thread.turns[thread.turn]?.reason ?? thread.stopReason)
		: undefined
	const groups = transcriptTurns(thread)
	const visuallyHidden =
		thread.running &&
		groups.some(
			(group) =>
				group.turn === thread.turn &&
				group.segments.some((segment) => hasPublicActivity(segment.activity, thread)),
		)
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
								<Entry
									key={entryKey(entry)}
									entry={entry}
									thread={thread}
									renderMessageAction={renderMessageAction}
								/>
							))}
							{hasPublicActivity(segment.activity, thread) && (
								<TurnActivity
									thread={thread}
									turn={group.turn}
									entries={segment.activity}
									animate={animate}
									renderMessageAction={renderMessageAction}
									now={now}
								/>
							)}
							{segment.answer.map((entry) => (
								<Entry
									key={entryKey(entry)}
									entry={entry}
									thread={thread}
									renderMessageAction={renderMessageAction}
								/>
							))}
						</Fragment>
					))}
				</div>
			))}
			<LiveStatus thread={thread} animate={animate} now={now} visuallyHidden={visuallyHidden} />
			{notice && <p className="notice">{notice}</p>}
		</div>
	)
}
