/**
 * Client for clawtool's `POST /v1/send_message` — the canonical agent
 * dispatcher. Returns an async iterable of normalized text frames so the
 * TUI can stream tokens into the transcript without caring about the
 * upstream CLI's exact wire format.
 *
 * The clawtool server passes through the upstream agent's NDJSON frames
 * verbatim. Different families (claude, codex, gemini, …) emit different
 * shapes. We do **best-effort normalization**: extract any `text` /
 * `content` string fields as visible deltas; collapse `error` lines into
 * error events; everything else (tool_use, tool_result, ping, message
 * envelopes) is silently consumed for now — tool-call surfacing lands
 * with the tool permission overlay.
 */

import { type EnsureDaemonOptions, ensureDaemon } from './daemon.js'

export type DispatchEvent =
	| { readonly kind: 'delta'; readonly text: string }
	| { readonly kind: 'done' }
	| { readonly kind: 'error'; readonly message: string }

export interface SendMessageOptions extends EnsureDaemonOptions {
	readonly instance: string
	readonly prompt: string
	/** Pass-through dispatch options (e.g. session_id, model, format). */
	readonly opts?: Record<string, unknown>
	readonly signal?: AbortSignal
}

export async function* sendMessage(opts: SendMessageOptions): AsyncIterable<DispatchEvent> {
	const endpoint = await ensureDaemon(opts)
	const fetchFn = opts.fetch ?? globalThis.fetch

	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (endpoint.token.length > 0) {
		headers.Authorization = `Bearer ${endpoint.token}`
	}

	const body: Record<string, unknown> = {
		instance: opts.instance,
		prompt: opts.prompt,
	}
	if (opts.opts) body.opts = opts.opts

	let res: Response
	try {
		res = await fetchFn(`${endpoint.baseUrl}/v1/send_message`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: opts.signal,
		})
	} catch (err) {
		yield {
			kind: 'error',
			message: `clawtool /v1/send_message request failed: ${err instanceof Error ? err.message : String(err)}`,
		}
		return
	}

	if (!res.ok) {
		// Best-effort: server may have returned a JSON error body.
		let detail = `HTTP ${res.status}`
		try {
			const errBody = (await res.json()) as { error?: string }
			if (errBody?.error) detail += `: ${errBody.error}`
		} catch {
			// non-JSON body, ignore
		}
		yield { kind: 'error', message: `clawtool /v1/send_message ${detail}` }
		return
	}

	if (!res.body) {
		yield { kind: 'error', message: 'clawtool /v1/send_message returned no body' }
		return
	}

	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			let nl = buffer.indexOf('\n')
			while (nl !== -1) {
				const line = buffer.slice(0, nl).trim()
				buffer = buffer.slice(nl + 1)
				const event = parseFrame(line)
				if (event) yield event
				nl = buffer.indexOf('\n')
			}
		}
		const tail = buffer.trim()
		if (tail.length > 0) {
			const event = parseFrame(tail)
			if (event) yield event
		}
		yield { kind: 'done' }
	} catch (err) {
		if ((err as { name?: string }).name === 'AbortError') {
			yield { kind: 'error', message: 'aborted' }
			return
		}
		yield {
			kind: 'error',
			message: `dispatch stream failed: ${err instanceof Error ? err.message : String(err)}`,
		}
	} finally {
		try {
			await reader.cancel()
		} catch {
			// reader already closed by the runtime — ignore
		}
	}
}

function parseFrame(line: string): DispatchEvent | null {
	if (line.length === 0) return null
	let frame: Record<string, unknown>
	try {
		frame = JSON.parse(line) as Record<string, unknown>
	} catch {
		// Some upstreams emit plain-text lines; treat them as deltas.
		return { kind: 'delta', text: `${line}\n` }
	}
	if (typeof frame.error === 'string' && frame.error.length > 0) {
		return { kind: 'error', message: frame.error }
	}
	// Best-effort text extraction across known frame shapes (text_delta,
	// content_block_delta, message_start, etc.). Tool-call / tool-result
	// frames are silently dropped here; the tool permission overlay
	// will surface them when it lands.
	const text = extractText(frame)
	if (text !== null && text.length > 0) {
		return { kind: 'delta', text }
	}
	return null
}

function extractText(frame: Record<string, unknown>): string | null {
	if (typeof frame.text === 'string') return frame.text
	if (typeof frame.content === 'string') return frame.content
	// Anthropic streaming shape: { type: 'content_block_delta', delta: { text: '...' } }
	if (frame.delta && typeof frame.delta === 'object') {
		const delta = frame.delta as Record<string, unknown>
		if (typeof delta.text === 'string') return delta.text
		if (typeof delta.content === 'string') return delta.content
	}
	// OpenAI-compatible: { choices: [{ delta: { content: '...' } }] }
	const choices = frame.choices as Array<{ delta?: { content?: unknown } }> | undefined
	if (Array.isArray(choices) && choices[0]?.delta?.content) {
		const v = choices[0].delta.content
		if (typeof v === 'string') return v
	}
	return null
}
