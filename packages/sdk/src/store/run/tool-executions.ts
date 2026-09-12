import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { ToolExecutionRecord, ToolExecutionSnapshot } from '../../types/run/store.js'

const MAX_LOG_BYTES = 256 * 1024 * 1024
const MAX_RECORD_BYTES = 4 * 1024 * 1024

/** Scan metadata only; compaction attachments and retained output bodies are never loaded. */
export class ToolExecutionCollector {
	private seq = 0
	private readonly wanted: Set<string>
	private readonly records = new Map<string, ToolExecutionRecord>()
	constructor(
		private readonly runId: string,
		ids: readonly string[],
	) {
		if (ids.length > 4096) throw new Error('Tool recovery exceeds the 4096-call scan limit.')
		this.wanted = new Set(ids)
	}
	accept(value: unknown): void {
		const event = value as Record<string, unknown> | null
		if (
			!event ||
			typeof event !== 'object' ||
			typeof event.type !== 'string' ||
			event.runId !== this.runId ||
			event.seq !== this.seq + 1
		) {
			throw new Error('Tool recovery requires a complete, ordered log owned by this run.')
		}
		if (this.seq === 0 && event.type !== 'run_started')
			throw new Error('Tool recovery cannot establish the beginning of this run.')
		this.seq++
		if (event.type !== 'tool_executing' && event.type !== 'tool_completed') return
		if (typeof event.toolUseId !== 'string' || typeof event.toolName !== 'string')
			throw new Error('Tool recovery found an invalid tool identity.')
		if (!this.wanted.has(event.toolUseId)) return
		const identity = { toolUseId: event.toolUseId, toolName: event.toolName }
		if (event.type === 'tool_executing') {
			// A later start invalidates an earlier completion, including retries.
			this.records.set(event.toolUseId, { ...identity, status: 'started' })
		} else {
			if (typeof event.result !== 'string' || typeof event.isError !== 'boolean')
				throw new Error('Tool recovery found an invalid completion.')
			this.records.set(event.toolUseId, {
				...identity,
				status: 'completed',
				result: event.result,
				isError: event.isError,
			})
		}
	}
	finish(complete = true): ToolExecutionSnapshot {
		return { complete: complete && this.seq > 0, records: this.records }
	}
}

export async function readToolExecutionsIn(
	path: string,
	runId: string,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<ToolExecutionSnapshot> {
	signal?.throwIfAborted()
	const collector = new ToolExecutionCollector(runId, ids)
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		const before = await file.stat()
		if (!before.isFile() || before.size > MAX_LOG_BYTES)
			throw new Error('Tool recovery requires a regular transcript within the 256 MiB scan limit.')
		let offset = 0
		let pending = Buffer.alloc(0)
		const buffer = Buffer.alloc(64 * 1024)
		while (offset < before.size) {
			signal?.throwIfAborted()
			const { bytesRead } = await file.read(
				buffer,
				0,
				Math.min(buffer.length, before.size - offset),
				offset,
			)
			if (bytesRead === 0) throw new Error('Tool recovery transcript was shortened.')
			offset += bytesRead
			pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)])
			let start = 0
			for (;;) {
				const end = pending.indexOf(10, start)
				if (end < 0) break
				if (end - start > MAX_RECORD_BYTES) throw new Error('Tool recovery record exceeds 4 MiB.')
				collector.accept(
					JSON.parse(
						new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(start, end)),
					),
				)
				start = end + 1
			}
			pending = Buffer.from(pending.subarray(start))
			if (pending.length > MAX_RECORD_BYTES) throw new Error('Tool recovery record exceeds 4 MiB.')
		}
		signal?.throwIfAborted()
		const after = await file.stat()
		if (
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error('Tool recovery transcript changed during the scan.')
		return collector.finish(pending.length === 0)
	} finally {
		await file.close()
	}
}
