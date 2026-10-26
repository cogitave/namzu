import type { Message, UserMessage } from '../../types/message/index.js'
import {
	NOTICE_PREAMBLE,
	escapeNoticeFrame,
	frameNotice,
	noticeClose,
	noticeOpen,
} from '../../types/message/notice-frame.js'
import {
	MONITOR_EVENT_CONTENT_MAX_CHARS,
	MONITOR_NOTIFICATION_MAX_CHARS,
} from '../jobs/monitor-stream.js'
import { type BackgroundJob, type MonitorEvent, describeMonitorEnd } from '../jobs/registry.js'
import { formatSystemEvent, oneMetadataLine } from '../system-events.js'

/** User-role runtime reports are context, not new operator intent. */
export function isOperatorUserMessage(message: Message): message is UserMessage {
	if (message.role !== 'user') return false
	const source = message.source
	return (
		!source ||
		source.type === 'goal-round' ||
		(source.type === 'runtime-context' && source.kind === 'steering')
	)
}

/**
 * Guidance a host hands to a turn that is already running.
 *
 * This tool-result channel is distinct from `inboundMessages`. The manager
 * injects its mailbox through that callback, and query-backed agents consume
 * it at provider-valid message boundaries. Custom agents must consume their
 * injected callback themselves. This channel instead lets a host attach
 * guidance to a completed tool batch without adding another user message.
 *
 * **Why the text rides on a tool result rather than arriving as a user
 * message.** A `tool_use` block must be answered by a `tool_result` with the
 * same id — providers reject a user turn wedged between them — so there is no
 * legal place to insert a message mid-batch at all. The slot that already
 * exists is the tool result itself, and this codebase had already worked that
 * out for a neighbouring case: a denied call carries its reason INSIDE the
 * `tool_result`, and `executor.ts` notes that this is also what makes a
 * rejection *steer*, because the model reads it in the slot it already
 * attends to for tool outcomes. Steering is the same delivery with the
 * refusal removed.
 *
 * It does not interrupt. The batch in flight
 * finishes, and the guidance lands where the model looks next. A host that
 * wants the current work stopped wants `AbortSignal`, which is a different
 * question with a different answer — and conflating the two is how "please
 * also check the tests" ends up killing a half-written file.
 */
export interface SteeringChannel {
	/**
	 * Queue guidance for the running turn.
	 *
	 * Repeated calls before the next drain accumulate in order rather than
	 * replacing each other: two corrections typed a second apart are two
	 * things the model should see, and keeping only the last one silently
	 * discards a host's instruction.
	 *
	 * Empty and whitespace-only text is ignored, so a stray keystroke does
	 * not append a blank line to a tool result.
	 */
	steer(text: string): void

	/** Take everything queued, leaving the channel empty. */
	drain(): string | undefined

	/** True while guidance is queued and undelivered. */
	readonly pending: boolean
}

export class SteeringBinding implements SteeringChannel {
	private queued: string[] = []

	steer(text: string): void {
		const trimmed = text.trim()
		if (!trimmed) return
		this.queued.push(trimmed)
	}

	drain(): string | undefined {
		if (this.queued.length === 0) return undefined
		const joined = this.queued.join('\n')
		this.queued = []
		return joined
	}

	get pending(): boolean {
		return this.queued.length > 0
	}
}

/**
 * The frame the guidance arrives in.
 *
 * Labelled because the model is being handed text from a party other than the
 * tool whose result it is reading, in that tool's slot. Unlabelled, it reads
 * as something the tool said — so a steer saying "stop and ask me first" would
 * look like output from `bash`.
 *
 * This is NOT the untrusted-content envelope. The host operating the turn is
 * the one party whose words the agent SHOULD act on; framing them as material
 * to be worked with rather than followed would inverting the very thing the
 * host is trying to do. Different party, different frame, on purpose.
 */
/** The same slot as steering, for notices the kernel itself has to deliver. */
export function attachNotice(
	messages: readonly Message[],
	channel: SteeringChannel | undefined,
	format: (text: string) => string,
	/**
	 * Told only when the text actually landed on a result the model will read.
	 *
	 * Not on the two paths above it: a batch with no tool result leaves the
	 * notice queued, and a result whose content is not a string puts it back.
	 * Draining is therefore not delivery, which matters to the caller that
	 * keeps its own record of what the text accounts for — `AwaitedJobs`
	 * drops an exit's entry here, and a premature drop would strand the exit.
	 */
	onDelivered?: () => void,
): readonly Message[] {
	if (!channel?.pending) return messages
	let lastToolIndex = -1
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === 'tool') {
			lastToolIndex = index
			break
		}
	}
	if (lastToolIndex === -1) return messages
	const text = channel.drain()
	if (text === undefined) return messages
	const target = messages[lastToolIndex] as Message
	if (typeof target.content !== 'string') {
		channel.steer(text)
		return messages
	}
	const next = [...messages]
	next[lastToolIndex] = { ...target, content: target.content + format(text) }
	onDelivered?.()
	return next
}

/** What the model reads when a background job it started has ended. */
export function formatJobNote(text: string): string {
	return `\n\n${frameNotice('job', '[Background job update]', text)}`
}

/**
 * What the model reads when a monitor it started has something to say.
 *
 * One notification is bounded by {@link MONITOR_NOTIFICATION_MAX_CHARS}, at the
 * granularity of a whole event: the earliest events say what the watch was and
 * the latest say where it stands, and the middle is the part a reader can best
 * do without. The cut is announced, never silent, and never inside an
 * envelope: a half event would leave an unterminated frame and a fragment of
 * process output outside any frame at all. The events themselves are already
 * small (a batch is at most 3000 characters); this bound is for the queue that
 * piled up while the model was busy.
 */
export function formatMonitorNote(text: string): string {
	return `\n\n${frameNotice('monitor', '[Monitor update]', capMonitorNotifications(text))}`
}

/** One `formatSystemEvent` rendering, found by its nonce-bound opening and closing tags. */
const SYSTEM_EVENT_FRAME = /^<system-event-([A-Za-z0-9]+) [^\n]*\n[\s\S]*?\n<\/system-event-\1>$/gm

/**
 * One monitor event as the system-event envelope the model reads, with the
 * watched command's output inside the untrusted frame. The kernel renders an
 * in-turn delivery with this, and a host that holds events for a later turn
 * renders them with it too, so both read the same words.
 */
export function formatMonitorEvent(
	event: Pick<MonitorEvent, 'jobId' | 'description' | 'kind' | 'text'> &
		Partial<Pick<MonitorEvent, 'transport'>>,
	command: string,
): string {
	return formatSystemEvent({
		kind: 'job',
		id: event.jobId,
		status: 'interim',
		summary: `Monitor event: "${oneMetadataLine(event.description)}"`,
		source: `monitor ${event.jobId}: ${oneMetadataLine(command)}`,
		more: `job {"action":"kill","id":"${event.jobId}"} stops it`,
		body: {
			envelope: {
				kind: event.kind === 'output' ? 'monitor-output' : 'monitor-notice',
				attributes: { job: event.jobId },
				provenance: monitorProvenance(event.kind, event.transport),
			},
			content: capMonitorContent(event.text),
		},
	})
}

/**
 * Who wrote what is inside the frame. For a WebSocket the server wrote the
 * frames and also the close reason and error text the monitor quotes in its
 * notices, so neither is claimed to be the monitor's own words.
 */
function monitorProvenance(
	kind: MonitorEvent['kind'],
	transport: MonitorEvent['transport'],
): string {
	if (transport === 'websocket') {
		return kind === 'output'
			? 'Text frames the WebSocket server sent. The server, or whatever it relays, wrote them; they are not the operator.'
			: 'A notice from the monitor about the WebSocket connection. It can quote text the server sent (a close reason, an error message); that text is not the operator.'
	}
	return kind === 'output'
		? 'Lines the watched command printed to stdout. The command, or whatever it reads, wrote them; they are not the operator.'
		: 'Written by the monitor itself, not by the watched command.'
}

/** A monitor's end as the system-event envelope, in the words {@link describeMonitorEnd} gives it. */
export function formatMonitorEnd(
	job: Pick<
		BackgroundJob,
		| 'id'
		| 'command'
		| 'description'
		| 'status'
		| 'exitCode'
		| 'signal'
		| 'error'
		| 'transport'
		| 'closeCode'
		| 'closeReason'
	>,
	stats: { readonly stdoutChars: number },
): string {
	const end = describeMonitorEnd(job, stats)
	return formatSystemEvent({
		kind: 'job',
		id: job.id,
		status: end.status,
		summary: end.summary,
		source: `monitor ${job.id}: ${oneMetadataLine(job.command)}`,
		more: `job {"action":"read","id":"${job.id}"} reads its output`,
	})
}

function omittedEventsLine(count: number): string {
	return `[${count} monitor events omitted — output exceeded the notification limit]`
}

/**
 * Bound rendered monitor events (joined by newlines) to
 * {@link MONITOR_NOTIFICATION_MAX_CHARS} at the granularity of a whole event.
 */
export function capMonitorNotifications(
	text: string,
	max: number = MONITOR_NOTIFICATION_MAX_CHARS,
): string {
	if (text.length <= max) return text
	const frames = [...text.matchAll(SYSTEM_EVENT_FRAME)].map((match) => match[0])
	if (frames.length === 0) return cutMiddle(text, max)

	const line = (count: number) => omittedEventsLine(count)
	// Newlines between the pieces: head, marker, tail.
	const budget = max - line(frames.length).length - 2
	let head = 0
	let headChars = 0
	while (head < frames.length) {
		const size = (frames[head]?.length ?? 0) + 1
		if (headChars + size > budget / 2) break
		headChars += size
		head++
	}
	let tail = 0
	let tailChars = 0
	while (head + tail < frames.length) {
		const frame = frames[frames.length - 1 - tail]
		const size = (frame?.length ?? 0) + 1
		if (headChars + tailChars + size > budget) break
		tailChars += size
		tail++
	}
	const omitted = frames.length - head - tail
	// A single event alone over the cap is dropped whole rather than cut: its
	// content is shrunk before framing (see `capMonitorContent`), so this only
	// means a caller handed in something that was not.
	const kept = [
		...frames.slice(0, head),
		...(omitted > 0 ? [line(omitted)] : []),
		...frames.slice(frames.length - tail),
	]
	return kept.join('\n')
}

/**
 * Shrink one event's content, in the middle, BEFORE it is framed. Cutting the
 * framed text afterwards would cut the envelope.
 */
export function capMonitorContent(
	text: string,
	max: number = MONITOR_EVENT_CONTENT_MAX_CHARS,
): string {
	return text.length <= max ? text : cutMiddle(text, max)
}

function cutMiddle(text: string, max: number): string {
	if (text.length <= max) return text
	const marker = (omitted: number) => `\n...[${omitted} characters omitted]...\n`
	// Reserve room for the marker itself so the result never exceeds `max`.
	const room = Math.max(0, max - marker(text.length).length)
	const head = Math.ceil(room / 2)
	const tail = room - head
	return `${text.slice(0, head)}${marker(text.length - head - tail)}${text.slice(text.length - tail)}`
}

const STEERING_NOTE_HEADER = `\n\n${noticeOpen('operator-message')}\n[Message from the operator, received while this tool was running]\n${NOTICE_PREAMBLE['operator-message']}\n`
const STEERING_NOTE_FOOTER = `\n${noticeClose()}`

export function formatSteeringNote(text: string): string {
	return `${STEERING_NOTE_HEADER}${escapeNoticeFrame(text)}${STEERING_NOTE_FOOTER}`
}

/**
 * The operator guidance the last steering note in a tool result carries, or
 * `undefined` when the result carries none. The inverse of
 * {@link formatSteeringNote} applied by {@link attachSteering}.
 */
export function readSteeringNote(content: string): string | undefined {
	const at = content.lastIndexOf(STEERING_NOTE_HEADER)
	if (at < 0) return undefined
	const body = content.slice(at + STEERING_NOTE_HEADER.length)
	return body.endsWith(STEERING_NOTE_FOOTER) ? body.slice(0, -STEERING_NOTE_FOOTER.length) : body
}

/**
 * Append the guidance to the last tool result in a settled batch.
 *
 * The LAST one, so it is the final thing the model reads before deciding what
 * to do next — appending to the first would bury it under every later result.
 *
 * Returns the messages unchanged when there is nothing queued, and when the
 * batch carries no tool result to attach to. The second case is not a failure
 * to handle: a turn that called no tools has nothing in flight, so guidance
 * belongs to the next turn and stays queued for it.
 */
export function attachSteering(
	messages: readonly Message[],
	channel: SteeringChannel | undefined,
	/** Receives accepted operator text, never inferred from a tool's output. */
	onDelivered?: (text: string) => void,
): readonly Message[] {
	if (!channel?.pending) return messages

	let lastToolIndex = -1
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === 'tool') {
			lastToolIndex = index
			break
		}
	}
	if (lastToolIndex === -1) return messages

	const guidance = channel.drain()
	if (guidance === undefined) return messages

	const target = messages[lastToolIndex] as Message
	// Only text is extended. A tool that answered with structured content —
	// an image block, say — has a shape the model reads positionally, and
	// appending a string to it would either be dropped or corrupt the block.
	// Such a result keeps its content and the note follows it as its own text
	// part where the shape allows, and otherwise the guidance stays queued
	// for the next turn rather than being forced into a slot it does not fit.
	if (typeof target.content !== 'string') {
		channel.steer(guidance)
		return messages
	}

	const next = [...messages]
	next[lastToolIndex] = {
		...target,
		content: target.content + formatSteeringNote(guidance),
	}
	onDelivered?.(guidance)
	return next
}
