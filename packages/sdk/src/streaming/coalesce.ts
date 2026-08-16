import type { ToolUseId } from '../types/ids/index.js'
import type { RunEvent } from '../types/run/events.js'

export interface CoalesceOptions {
	/**
	 * Sliding merge window. 16ms is roughly one animation frame at 60fps,
	 * which is the point past which a human cannot see the difference and
	 * below which the consumer pays for deltas nobody perceives.
	 */
	windowMs: number
}

/**
 * Coalesces high-frequency `text_delta` and `tool_input_delta` events into
 * fewer, larger events to relieve downstream backpressure (typically a
 * Server-Sent Events adapter writing to a slow client).
 *
 * Within a sliding `windowMs` window, consecutive `text_delta` events for
 * the same `messageId` are merged by string concatenation; consecutive
 * `tool_input_delta` events for the same `toolUseId` are likewise merged.
 * All other event types pass through immediately and flush any buffered
 * deltas first to preserve ordering.
 *
 * The orchestrator does NOT use this — it emits raw deltas, and nothing
 * inside the kernel calls this function. That is deliberate and is why it
 * is exported: the consumer this exists for is a host's HTTP route, and a
 * kernel with no UI and no hosted service has no in-process caller to
 * offer. `bridge/sse/` maps an event to the wire; deciding how OFTEN to
 * write to a slow client is the host's policy, because only the host
 * knows what is on the other end of its socket.
 *
 * `streaming/` owns coalescing and nothing else. SSE mapping lives in
 * `bridge/sse/`, provider chunk assembly in the provider drivers, and the
 * run event stream in `runtime/query/` — none of them belong here, and a
 * second occupant of this directory should be another rate policy or
 * nothing.
 *
 * Backpressure semantics: this helper does not drop events. If the
 * upstream produces faster than the consumer drains, the helper still
 * yields every coalesced batch; the consumer must apply its own bound or
 * accept queue growth.
 */
export async function* coalesce(
	stream: AsyncIterable<RunEvent>,
	options: CoalesceOptions = { windowMs: 16 },
): AsyncGenerator<RunEvent, void, unknown> {
	const { windowMs } = options
	let textBuf: { event: Extract<RunEvent, { type: 'text_delta' }>; deadline: number } | null = null
	const toolBufs = new Map<
		ToolUseId,
		{ event: Extract<RunEvent, { type: 'tool_input_delta' }>; deadline: number }
	>()

	function* flushAll(): Generator<RunEvent> {
		if (textBuf) {
			yield textBuf.event
			textBuf = null
		}
		for (const buf of toolBufs.values()) {
			yield buf.event
		}
		toolBufs.clear()
	}

	const now = () => Date.now()

	for await (const event of stream) {
		if (event.type === 'text_delta') {
			if (textBuf && textBuf.event.messageId === event.messageId && textBuf.deadline > now()) {
				textBuf.event = {
					...textBuf.event,
					text: textBuf.event.text + event.text,
				}
			} else {
				if (textBuf) yield textBuf.event
				textBuf = { event, deadline: now() + windowMs }
			}
			continue
		}

		if (event.type === 'tool_input_delta') {
			const existing = toolBufs.get(event.toolUseId)
			if (existing && existing.deadline > now()) {
				existing.event = {
					...existing.event,
					partialJson: existing.event.partialJson + event.partialJson,
				}
			} else {
				if (existing) yield existing.event
				toolBufs.set(event.toolUseId, {
					event,
					deadline: now() + windowMs,
				})
			}
			continue
		}

		yield* flushAll()
		yield event
	}

	yield* flushAll()
}
