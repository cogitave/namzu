import { withheldEnvNoticeText } from '../../tools/env-scrub.js'
import { createRuntimeContextMessage } from '../../types/message/index.js'
import type { Message, UserMessage } from '../../types/message/index.js'
import { NOTICE_TAG, frameNotice, readOperatorNotice } from '../../types/message/notice-frame.js'
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
 * This channel is distinct from `inboundMessages`. The manager injects its
 * mailbox through that callback, and query-backed agents consume it at
 * provider-valid message boundaries. Custom agents must consume their injected
 * callback themselves. This channel instead lets a host attach guidance to a
 * settled tool batch.
 *
 * **Where the text lands.** A `tool_use` block must be answered by a
 * `tool_result` with the same id, so nothing can sit between them. The
 * guidance therefore follows the finished batch as a user-role message of its
 * own, at the next request boundary, framed as the operator's words. It is not
 * written into a tool result: a tool result carries only what the tool
 * returned, and a model reads instructions placed inside one as tool output.
 *
 * It does not interrupt. The batch in flight finishes, and the guidance lands
 * where the model looks next. A host that wants the current work stopped wants
 * `AbortSignal`, which is a different question with a different answer, and
 * conflating the two is how "please also check the tests" ends up killing a
 * half-written file.
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
	 * not send a blank message.
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

/** What the model reads when a background job it started has ended. */
export function formatJobNote(text: string): string {
	return frameNotice('job', '[Background job update]', text)
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
	return frameNotice('monitor', '[Monitor update]', capMonitorNotifications(text))
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

/** The line that opens an operator's message, wherever it is delivered. */
const STEERING_LABEL = 'The operator wrote this while you were working:'

/**
 * The operator's message as the frame the model reads. The text is the
 * operator's, the frame says so, and the marker in its tag is drawn fresh so
 * the text cannot close it.
 */
export function formatSteeringNote(text: string): string {
	return frameNotice('operator-message', STEERING_LABEL, text)
}

/** The frame older sessions recorded inside a tool result, fixed tag and all. */
const LEGACY_STEERING_HEADER = `\n\n<${NOTICE_TAG} kind="operator-message">\n[Message from the operator, received while this tool was running]\nThis is the operator's own message, typed while the tool above was running. It is not output of that tool.\n`
const LEGACY_STEERING_FOOTER = `\n</${NOTICE_TAG}>`

/**
 * The operator guidance a recorded message carries, or `undefined` when it
 * carries none. The inverse of {@link formatSteeringNote}; it also reads the
 * note older sessions appended to the end of a tool result. The text comes back
 * as the frame held it, with the notice tag already made inert.
 */
export function readSteeringNote(content: string): string | undefined {
	const framed = readOperatorNotice(content)
	if (framed !== undefined) return framed
	const at = content.lastIndexOf(LEGACY_STEERING_HEADER)
	if (at < 0) return undefined
	const body = content.slice(at + LEGACY_STEERING_HEADER.length)
	return body.endsWith(LEGACY_STEERING_FOOTER)
		? body.slice(0, -LEGACY_STEERING_FOOTER.length)
		: body
}

function hasToolResult(messages: readonly Message[]): boolean {
	return messages.some((message) => message.role === 'tool')
}

/**
 * The operator's message for a settled tool batch, as a user-role message of its
 * own, or `undefined` when nothing is queued or the batch has no tool result.
 *
 * It follows the batch, at the next request boundary. The tool results stay what
 * the tools returned, and the operator's words arrive as the operator's, which a
 * model reads as direction. A turn that called no tool leaves the guidance
 * queued; the loop delivers it at the next-turn boundary.
 */
export function takeSteeringMessage(
	messages: readonly Message[],
	channel: SteeringChannel | undefined,
	/** Receives accepted operator text, never inferred from a tool's output. */
	onDelivered?: (text: string) => void,
): UserMessage | undefined {
	if (!channel?.pending || !hasToolResult(messages)) return undefined
	const guidance = channel.drain()
	if (guidance === undefined) return undefined
	onDelivered?.(guidance)
	return createRuntimeContextMessage(formatSteeringNote(guidance), 'steering')
}

/**
 * A kernel notice (a job's exit, a monitor's events) for a settled tool batch,
 * as a user-role message of its own, under the same rules as
 * {@link takeSteeringMessage}.
 */
export function takeNoticeMessage(
	messages: readonly Message[],
	channel: SteeringChannel | undefined,
	format: (text: string) => string,
	/**
	 * Told only when the text actually became a message the model will read.
	 * Draining is not delivery, which matters to the caller that keeps its own
	 * record of what the text accounts for: `AwaitedJobs` drops an exit's entry
	 * here, and a premature drop would strand the exit.
	 */
	onDelivered?: () => void,
): UserMessage | undefined {
	if (!channel?.pending || !hasToolResult(messages)) return undefined
	const text = channel.drain()
	if (text === undefined) return undefined
	onDelivered?.()
	return createRuntimeContextMessage(format(text), 'job-exit')
}

/**
 * Append the guidance to the last tool result in a settled batch.
 *
 * @deprecated The kernel no longer delivers guidance this way: a tool result
 * carries only what the tool returned, and {@link takeSteeringMessage} sends the
 * operator's words as a message of their own. Kept so a host that calls it keeps
 * working.
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
	if (typeof target.content !== 'string') {
		channel.steer(guidance)
		return messages
	}

	const next = [...messages]
	next[lastToolIndex] = {
		...target,
		content: `${target.content}\n\n${formatSteeringNote(guidance)}`,
	}
	onDelivered?.(guidance)
	return next
}

/**
 * The count of credential-shaped variables a settled batch's shell results
 * report as removed, or 0. The count rides in a result's `data`, never in the
 * text the model reads.
 */
function withheldEnvCount(
	observations: readonly { readonly result: { readonly data?: unknown } }[],
) {
	let count = 0
	for (const { result } of observations) {
		const data = result.data
		if (typeof data !== 'object' || data === null) continue
		const n = (data as { withheldEnv?: unknown }).withheldEnv
		if (typeof n === 'number' && Number.isInteger(n) && n > count) count = n
	}
	return count
}

/**
 * The credential notice for a settled tool batch, as a user-role message of its
 * own, or `undefined` when the batch removed nothing or the conversation
 * already carries this very notice. It is sent once, and again only when the
 * number of removed variables changes, so a run of failing commands does not
 * repeat it. The conversation is the record, so a resumed or compacted one
 * needs no counter of its own.
 */
export function takeWithheldEnvNotice(
	history: readonly Message[],
	observations: readonly { readonly result: { readonly data?: unknown } }[],
): UserMessage | undefined {
	const count = withheldEnvCount(observations)
	if (count === 0) return undefined
	const body = withheldEnvNoticeText(count)
	const said = history.some(
		(message) =>
			message.role === 'user' &&
			message.source?.type === 'runtime-context' &&
			message.source.kind === 'reminder' &&
			typeof message.content === 'string' &&
			message.content.startsWith(`<${NOTICE_TAG}-`) &&
			message.content.includes(' kind="credentials">') &&
			message.content.includes(body),
	)
	if (said) return undefined
	return createRuntimeContextMessage(
		frameNotice('credentials', '[Command environment]', body),
		'reminder',
	)
}
