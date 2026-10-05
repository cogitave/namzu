import type {
	SandboxStdioChannel,
	SandboxStdioEvent,
	SandboxStdioOperation,
	SandboxStdioOptions,
} from '@namzu/sdk'
import { workerAuthorization } from '../backends/http-worker-client.js'

interface GuestStdioHost {
	readonly executionUrl: string
	readonly token: string
	readonly acquire: (signal?: AbortSignal) => Promise<() => void>
	readonly uncertain: () => void
}

const MAX_FRAME_BYTES = 2 * 1024 * 1024
const MAX_QUEUED_BYTES = 4 * 1024 * 1024

export interface OwnedGuestStdioChannel extends SandboxStdioChannel {
	/** Host-only: the owning engine has positively confirmed allocation removal. */
	allocationEnded(): void
}

/** Private allocation token stays inside this host channel, never in guest argv/env. */
export async function openGuestStdio(
	host: GuestStdioHost,
	command: string,
	args: readonly string[],
	options?: SandboxStdioOptions,
): Promise<OwnedGuestStdioChannel> {
	if (!command || typeof command !== 'string' || args.some((arg) => typeof arg !== 'string'))
		throw new Error('Guest stdio requires a command and literal argv')
	const headers = { 'content-type': 'application/json', ...workerAuthorization(host.token) }
	const post = async (route: string, body: unknown, signal?: AbortSignal) => {
		const response = await fetch(`${host.executionUrl}${route}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
				: AbortSignal.timeout(30_000),
		})
		if (!response.ok) throw new Error(`Guest stdio request refused (${response.status})`)
		return (await response.json()) as Record<string, unknown>
	}
	const reservation = await post('/executions/reserve', {}, options?.signal)
	const executionId = reservation.executionId
	if (typeof executionId !== 'string' || !/^exec_[0-9a-f-]{36}$/.test(executionId))
		throw new Error('Guest did not return an execution reservation')
	const cancel = async () => {
		const result = await post('/cancel', { executionId })
		if (result.ok !== true || !['completed', 'cancelled', 'failed'].includes(String(result.state)))
			throw new Error('Guest stdio process-group termination was not confirmed')
	}
	const capability = reservation.stdio as { version?: unknown; maxLifetimeMs?: unknown } | undefined
	if (
		capability?.version !== 1 ||
		!Number.isSafeInteger(capability.maxLifetimeMs) ||
		typeof capability.maxLifetimeMs !== 'number' ||
		capability.maxLifetimeMs < 1 ||
		capability.maxLifetimeMs > 2_147_000_000
	) {
		await cancel()
		throw new Error(
			'This guest worker does not support owned interactive stdio; rebuild the Pal image',
		)
	}
	const controller = new AbortController()
	let confirmed = false
	let closing: Promise<void> | undefined
	let terminal = false
	let failure: Error | undefined
	let resolveClosed!: () => void
	let rejectClosed!: (error: Error) => void
	const closed = new Promise<void>((resolve, reject) => {
		resolveClosed = resolve
		rejectClosed = reject
	})
	// An embedding transport may attach only after connect resolves.
	void closed.catch(() => {})
	const operations = new Set<{ unknown: () => void }>()
	const unknown = () => {
		host.uncertain()
		for (const operation of operations) operation.unknown()
	}
	const queue: SandboxStdioEvent[] = []
	let queuedBytes = 0
	let consumerWake: (() => void) | undefined
	let producerWake: (() => void) | undefined
	let claimed = false
	const finish = (error?: Error) => {
		if (terminal) return
		terminal = true
		failure = error
		options?.signal?.removeEventListener('abort', onAbort)
		consumerWake?.()
		producerWake?.()
		if (error) rejectClosed(error)
		else resolveClosed()
	}
	const close = (): Promise<void> => {
		if (confirmed) return Promise.resolve()
		if (closing) return closing
		// Closing MCP does not prove an external editor command stopped.
		if (operations.size) unknown()
		closing = cancel()
			.then(() => {
				confirmed = true
				controller.abort()
				finish()
			})
			.catch((error: unknown) => {
				unknown()
				closing = undefined
				throw error
			})
		return closing
	}
	const onAbort = () => {
		void close().catch(() => {})
	}
	let response: Response
	const handshakeTimeout = setTimeout(
		() => controller.abort(new Error('Guest stdio startup timed out')),
		30_000,
	)
	try {
		options?.signal?.throwIfAborted()
		await options?.assertExecutionAllowed?.()
		options?.signal?.throwIfAborted()
		response = await fetch(`${host.executionUrl}/execute`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				executionId,
				command,
				args,
				cwd: options?.cwd,
				env: options?.env,
				stdio: true,
				timeoutMs: capability.maxLifetimeMs,
				normalExitPolicy: 'strict',
			}),
			signal: AbortSignal.any([controller.signal, ...(options?.signal ? [options.signal] : [])]),
		})
		if (!response.ok || !response.body) throw new Error('Guest stdio admission was not confirmed')
	} catch (error) {
		clearTimeout(handshakeTimeout)
		try {
			await close()
		} catch {
			host.uncertain()
		}
		throw error
	}
	const frames = readFrames(response.body)
	try {
		const first = await frames.next()
		if (first.done || first.value.type !== 'stdio_started' || first.value.version !== 1)
			throw new Error('Guest stdio startup acknowledgement is missing')
	} catch (error) {
		try {
			await close()
		} catch {
			host.uncertain()
		}
		throw error
	} finally {
		clearTimeout(handshakeTimeout)
	}
	options?.signal?.addEventListener('abort', onAbort, { once: true })
	if (options?.signal?.aborted) onAbort()
	void (async () => {
		try {
			for await (const frame of frames) {
				if (frame.type === 'stdio_heartbeat') {
					if (frame.version !== 1 || Object.keys(frame).length !== 2)
						throw new Error('Invalid guest stdio heartbeat')
					// Transport liveness is not stdout, an RPC reply or device admission.
					continue
				}
				if (frame.type === 'result') {
					confirmed = true
					// The consumer may still have an exact reply in its queue. Its RPC
					// adapter settles that reply before classifying remaining EOF calls.
					finish()
					return
				}
				if (
					frame.type !== 'stdio_data' ||
					!['stdout', 'stderr'].includes(String(frame.stream)) ||
					typeof frame.data !== 'string'
				)
					throw new Error('Invalid guest stdio stream frame')
				const bytes = Buffer.from(frame.data, 'base64')
				if (bytes.toString('base64') !== frame.data)
					throw new Error('Invalid guest stdio stream bytes')
				while (!terminal && queuedBytes >= MAX_QUEUED_BYTES)
					await new Promise<void>((resolve) => {
						producerWake = resolve
					})
				if (terminal) return
				queue.push({ stream: frame.stream as 'stdout' | 'stderr', data: bytes })
				queuedBytes += bytes.length
				consumerWake?.()
			}
			if (!confirmed) throw new Error('Guest stdio stream ended without process-group confirmation')
		} catch (error) {
			if (confirmed) return
			if (operations.size) unknown()
			try {
				await cancel()
				confirmed = true
			} catch {
				unknown()
			}
			finish(error instanceof Error ? error : new Error('Guest stdio stream failed'))
		}
	})()
	return {
		closed,
		close,
		allocationEnded() {
			confirmed = true
			controller.abort()
			finish()
		},
		events: {
			async *[Symbol.asyncIterator]() {
				if (claimed) throw new Error('Guest stdio supports one stream consumer')
				claimed = true
				while (true) {
					if (queue.length) {
						const event = queue.shift()
						if (!event) continue
						queuedBytes -= event.data.length
						producerWake?.()
						yield event
					} else if (terminal) {
						if (failure) throw failure
						return
					} else
						await new Promise<void>((resolve) => {
							consumerWake = resolve
						})
				}
			},
		},
		async beginOperation(signal): Promise<SandboxStdioOperation> {
			if (terminal || closing) throw new Error('Guest stdio channel has ended')
			const release = await host.acquire(signal)
			if (terminal || closing) {
				release()
				throw new Error('Guest stdio channel has ended')
			}
			let ended = false
			const operation = {
				unknown: () => {
					if (!ended) {
						ended = true
						host.uncertain()
						operations.delete(operation)
					}
				},
			}
			operations.add(operation)
			return {
				complete() {
					if (!ended) {
						ended = true
						operations.delete(operation)
						release()
					}
				},
				outcomeUnknown: operation.unknown,
			}
		},
		async write(data, signal) {
			if (terminal || closing) throw new Error('Guest stdio channel has ended')
			const bytes = Buffer.from(data)
			if (bytes.length > 1024 * 1024)
				throw new Error('Guest stdio write exceeds 1 MiB; split the byte stream')
			const release = await host.acquire(signal)
			let issued = false
			try {
				if (terminal || closing) throw new Error('Guest stdio channel has ended')
				signal?.throwIfAborted()
				issued = true
				const result = await post(
					'/executions/write',
					{ executionId, data: bytes.toString('base64') },
					signal,
				)
				if (result.ok !== true || result.bytesWritten !== bytes.length)
					throw new Error('Guest stdin delivery was not confirmed')
			} catch (error) {
				if (issued) unknown()
				throw error
			} finally {
				release()
			}
		},
	}
}

async function* readFrames(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader()
	let pending = ''
	const decoder = new TextDecoder()
	try {
		while (true) {
			const next = await reader.read()
			if (next.done) break
			pending += decoder.decode(next.value, { stream: true })
			let newline = pending.indexOf('\n')
			while (newline >= 0) {
				if (newline > MAX_FRAME_BYTES) throw new Error('Guest stdio frame exceeds its bound')
				const frame = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>
				pending = pending.slice(newline + 1)
				newline = pending.indexOf('\n')
				if (!frame || typeof frame !== 'object') throw new Error('Invalid guest stdio frame')
				yield frame
			}
			if (pending.length > MAX_FRAME_BYTES) throw new Error('Guest stdio frame exceeds its bound')
		}
		if (pending.trim()) throw new Error('Truncated guest stdio frame')
	} finally {
		reader.releaseLock()
	}
}
