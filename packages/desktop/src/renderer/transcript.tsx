import { useEffect, useState } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import { AttachmentList } from './attachment-list.js'
import { ChevronRightIcon, FileDiffIcon, TerminalIcon, WrenchIcon } from './icons.js'
import { Message, MessageContent } from './message.js'
import { ToolView } from './tool-view.js'
import {
	elapsedLabel,
	terminalNotice,
	toolGroupLabel,
	transcriptTurns,
} from './transcript-layout.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'

function ToolRow({
	tool,
	active,
	onOpenChange,
}: {
	tool: ThreadState['tools'][string]
	active: boolean
	onOpenChange?: (open: boolean) => void
}) {
	const Icon =
		tool.view.kind === 'terminal'
			? TerminalIcon
			: tool.view.kind === 'diff'
				? FileDiffIcon
				: WrenchIcon
	const label =
		tool.view.kind === 'terminal'
			? `${tool.status === 'pending' ? (active ? 'Running' : 'Interrupted') : 'Ran'} ${tool.view.command || tool.title}`
			: tool.view.kind === 'diff'
				? `${tool.status === 'pending' ? (active ? 'Editing' : 'Interrupted edit of') : tool.status === 'failed' ? 'Failed edit of' : 'Edited'} ${tool.view.path || tool.title}`
				: tool.view.label
	return (
		<Collapsible
			className={`tool ${tool.status} ${active ? 'active' : ''}`}
			data-tool-call-id={tool.toolCallId}
			onOpenChange={onOpenChange}
		>
			<CollapsibleTrigger className="tool-trigger" title={label}>
				<Icon className="tool-icon" aria-hidden="true" />
				<span className="tool-label">{label}</span>
				{tool.status === 'failed' ? (
					<span className="tool-status">Failed</span>
				) : tool.status === 'pending' && !active ? (
					<span className="tool-status">Interrupted</span>
				) : tool.durationMs !== undefined ? (
					<span className="tool-status">{elapsedLabel(tool.durationMs)}</span>
				) : null}
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
}

function Entry({
	entry,
	thread,
	onToolOpenChange,
}: { entry: TimelineEntry; thread: ThreadState; onToolOpenChange?: (open: boolean) => void }) {
	if (entry.kind === 'tool') {
		const tool = thread.tools[entry.id]
		return tool ? (
			<div className="tool-list" data-timeline-turn={entry.turn}>
				<ToolRow
					tool={tool}
					active={thread.activeToolIds.includes(entry.id)}
					onOpenChange={onToolOpenChange}
				/>
			</div>
		) : null
	}
	if (entry.kind === 'reasoning') {
		const thought = thread.reasoning[entry.id]
		// A redacted block can drive Thinking, but cannot invent a public body.
		return thought?.text ? (
			<div className="reasoning" data-timeline-turn={entry.turn} data-reasoning-id={entry.id}>
				<MessageContent text={thought.text} markdown />
			</div>
		) : null
	}
	const message = thread.messages[entry.index]
	return message?.text || message?.attachments?.length ? (
		<Message
			from={message.role}
			className={`message ${message.role}`}
			data-timeline-turn={entry.turn}
			data-message-phase={message.phase}
		>
			<MessageContent text={message.text} markdown={message.role === 'assistant'} />
			{message.attachments && (
				<div className="mt-2">
					<AttachmentList attachments={message.attachments} />
				</div>
			)}
		</Message>
	) : null
}

function entryKey(entry: TimelineEntry): string {
	return entry.kind === 'message' ? `message-${entry.index}` : `${entry.kind}-${entry.id}`
}

function ToolGroup({ entries, thread }: { entries: TimelineEntry[]; thread: ThreadState }) {
	const [chosenOpen, setChosenOpen] = useState<boolean>()
	const [openTools, setOpenTools] = useState<string[]>([])
	const multiple = entries.length > 1
	const tools = entries.flatMap((entry) =>
		entry.kind === 'tool' && thread.tools[entry.id] ? [thread.tools[entry.id]] : [],
	)
	const active = entries.some(
		(entry) => entry.kind === 'tool' && thread.activeToolIds.includes(entry.id),
	)
	const Icon = tools.some((tool) => tool.view.kind === 'diff') ? FileDiffIcon : TerminalIcon
	return (
		<Collapsible
			className={`tool ${multiple ? 'tool-group' : ''} ${active ? 'active' : ''}`}
			open={!multiple || (chosenOpen ?? openTools.length > 0)}
			onOpenChange={setChosenOpen}
		>
			{multiple && (
				<CollapsibleTrigger className="tool-trigger">
					<Icon className="tool-icon" aria-hidden="true" />
					<span className="tool-label">{toolGroupLabel(tools, active)}</span>
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

function ActivityEntries({ entries, thread }: { entries: TimelineEntry[]; thread: ThreadState }) {
	const groups: TimelineEntry[][] = []
	for (const entry of entries) {
		const last = groups.at(-1)
		const knownTool =
			entry.kind === 'tool' &&
			Boolean(thread.tools[entry.id]) &&
			thread.tools[entry.id]?.view.kind !== 'generic'
		const previous = last?.at(-1)
		if (
			knownTool &&
			previous?.kind === 'tool' &&
			thread.tools[previous.id]?.view.kind !== 'generic'
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

function TurnActivity({
	thread,
	turn,
	entries,
}: { thread: ThreadState; turn: number; entries: TimelineEntry[] }) {
	const live = thread.running && thread.stopReason === undefined && thread.turn === turn
	const [chosenOpen, setChosenOpen] = useState<boolean>()
	const timing = thread.turns[turn]
	const duration =
		timing?.startedAt !== undefined && timing.endedAt !== undefined
			? timing.endedAt - timing.startedAt
			: undefined
	const label = live
		? 'Activity'
		: `${timing?.reason === 'paused' ? 'Paused' : timing?.stopReason === 'cancelled' ? 'Stopped' : timing?.stopReason && timing.stopReason !== 'end_turn' ? 'Activity' : 'Worked'}${duration !== undefined ? ` for ${elapsedLabel(duration)}` : ''}`
	return (
		<Collapsible
			className="turn-activity"
			open={chosenOpen ?? live}
			onOpenChange={setChosenOpen}
			data-activity-turn={turn}
		>
			<CollapsibleTrigger className="activity-trigger">
				<span>{label}</span>
				<ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<div className="activity-entries">
					<ActivityEntries entries={entries} thread={thread} />
				</div>
			</CollapsiblePanel>
		</Collapsible>
	)
}

function LiveStatus({ thread }: { thread: ThreadState }) {
	const phase = threadPhase(thread)
	const [now, setNow] = useState(Date.now)
	const start = thread.turns[thread.turn]?.startedAt
	useEffect(() => {
		if (!thread.running || start === undefined) return
		setNow(Date.now())
		const timer = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(timer)
	}, [thread.running, start])
	if (phase === 'idle') return null
	const label =
		phase === 'waiting'
			? 'Waiting for your decision'
			: phase === 'thinking'
				? 'Thinking'
				: 'Working'
	return (
		<output
			className={`working ${phase === 'waiting' ? 'waiting' : ''}`}
			aria-live="polite"
			data-transcript-phase={phase}
		>
			<span className="working-label">{label}</span>
			{start !== undefined && (
				<span className="working-elapsed" aria-hidden="true">
					{elapsedLabel(now - start)}
				</span>
			)}
		</output>
	)
}

export function Transcript({ thread }: { thread: ThreadState }) {
	const notice = !thread.running
		? terminalNotice(thread.turns[thread.turn]?.reason ?? thread.stopReason)
		: undefined
	return (
		<>
			{transcriptTurns(thread).map((group) => (
				<div className="transcript-turn" key={group.turn} data-transcript-turn={group.turn}>
					{group.user.map((entry) => (
						<Entry key={entryKey(entry)} entry={entry} thread={thread} />
					))}
					{group.activity.length > 0 && (
						<TurnActivity thread={thread} turn={group.turn} entries={group.activity} />
					)}
					{group.answer.map((entry) => (
						<Entry key={entryKey(entry)} entry={entry} thread={thread} />
					))}
				</div>
			))}
			<LiveStatus thread={thread} />
			{notice && <p className="notice">{notice}</p>}
		</>
	)
}
