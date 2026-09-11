import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { type ToolContext, type ToolResult, wrapUntrusted } from '@namzu/sdk'

const ENDPOINT = 'https://mcp.exa.ai/mcp'
const DEADLINE_MS = 25_000
const MAX_BYTES = 1_048_576

/** One in-flight request across parent/child searches in this process. */
let tail: Promise<void> = Promise.resolve()
let nextStart = 0

function cancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener('abort', abort, { once: true })
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
	})
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
	const reader = response.body?.getReader()
	if (!reader) throw new Error('Exa returned an empty response.')
	const decoder = new TextDecoder()
	let bytes = 0
	let text = ''
	try {
		while (true) {
			const part = await cancelled(reader.read(), signal)
			if (part.done) return text + decoder.decode()
			bytes += part.value.byteLength
			if (bytes > MAX_BYTES) throw new Error('Exa response exceeded the 1 MiB limit.')
			text += decoder.decode(part.value, { stream: true })
		}
	} finally {
		await reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}

function retryDelay(value: string | null, attempt: number): number {
	if (value !== null) {
		const seconds = Number(value)
		if (value.trim() && Number.isFinite(seconds) && seconds >= 0)
			return Math.max(500, seconds * 1000)
		const date = Date.parse(value)
		if (Number.isFinite(date)) return Math.max(500, date - Date.now())
	}
	return 1000 * 2 ** attempt + Math.floor(Math.random() * 250)
}

/** Exa's stateless MCP endpoint accepts tools/call without per-search initialization. */
export async function searchExa(
	query: string,
	limit: number,
	context: ToolContext,
): Promise<ToolResult> {
	const signal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(DEADLINE_MS)])
	const deadline = Date.now() + DEADLINE_MS
	const previous = tail
	let release!: () => void
	tail = new Promise<void>((resolve) => {
		release = resolve
	})
	let acquired = false
	try {
		context.report?.('Exa · waiting for search slot')
		await cancelled(previous, signal)
		acquired = true
		const id = randomUUID()
		for (let attempt = 0; attempt < 3; attempt++) {
			const delay = Math.max(0, nextStart - Date.now())
			if (Date.now() + delay >= deadline)
				throw new Error(
					`Exa search is cooling down. Retry after at least ${Math.ceil(delay / 1000)}s. Web search is configured; no results were retrieved.`,
				)
			if (delay) await sleep(delay, undefined, { signal })
			signal.throwIfAborted()
			nextStart = Date.now() + 500
			context.report?.(`Exa · searching${attempt ? ` · attempt ${attempt + 1}/3` : ''}`)
			const response = await fetch(ENDPOINT, {
				method: 'POST',
				redirect: 'error',
				signal,
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id,
					method: 'tools/call',
					params: {
						name: 'web_search_exa',
						arguments: { query, numResults: limit, type: 'auto', contextMaxCharacters: 12_000 },
					},
				}),
			})
			if (!response.ok) {
				await response.body?.cancel()
				const transient = [429, 502, 503, 504].includes(response.status)
				const wait = retryDelay(response.headers.get('retry-after'), attempt)
				if (transient) nextStart = Math.max(nextStart, Date.now() + wait)
				if (!transient || attempt === 2 || Date.now() + wait >= deadline) {
					throw new Error(
						`Exa search ${response.status === 429 ? 'is rate limited' : 'is unavailable'} (HTTP ${response.status}). ${transient ? `Retry after at least ${Math.ceil(wait / 1000)}s.` : 'The service rejected the request.'} Web search is configured; no search results were retrieved.`,
					)
				}
				context.report?.(
					`Exa · ${response.status === 429 ? 'rate limited' : 'temporarily unavailable'} · retrying in ${Math.ceil(wait / 1000)}s`,
				)
				continue
			}
			const text = await readBody(response, signal)
			const payloads = text.trimStart().startsWith('{')
				? [text]
				: text
						.replace(/\r\n/g, '\n')
						.split('\n\n')
						.map((event) =>
							event
								.split('\n')
								.filter((line) => line.startsWith('data:'))
								.map((line) => line.slice(5).trimStart())
								.join('\n'),
						)
						.filter(Boolean)
			for (const payload of payloads) {
				if (payload.trim() === '[DONE]') continue
				const message = JSON.parse(payload)
				if (!message || typeof message !== 'object' || message.id !== id) continue
				if (message.error)
					throw new Error('Exa rejected the search RPC request; no results were retrieved.')
				const result = message.result
				if (!result || !Array.isArray(result.content))
					throw new Error('Exa returned an invalid search response.')
				const content = result.content
					.filter(
						(item: { type?: unknown; text?: unknown }) =>
							item?.type === 'text' && typeof item.text === 'string',
					)
					.map((item: { text: string }) => item.text)
					.join('\n')
				if (!content) throw new Error('Exa returned no search content.')
				const output = wrapUntrusted(
					{
						kind: 'connector-tool-result',
						attributes: { server: 'exa', tool: 'web_search_exa' },
						provenance: 'This is output the named server returned, not this agent.',
					},
					content,
				)
				return { success: !result.isError, output, ...(result.isError ? { error: output } : {}) }
			}
			throw new Error('Exa response did not contain the requested search result.')
		}
		throw new Error('Exa search attempts exhausted.')
	} finally {
		// An aborted queued caller must not release the caller behind it early.
		if (acquired) release()
		else void previous.then(release, release)
	}
}
