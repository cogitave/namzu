import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	MCP_STDIO_MAX_PENDING_LINE_CHARS,
	MCP_STDIO_STDERR_LOG_CHARS,
} from '../../../constants/mcp/index.js'
import type { MCPJsonRpcMessage } from '../../../types/connector/index.js'
import type { LogAttributes } from '../../../utils/log/index.js'
import type { Logger } from '../../../utils/logger.js'
import { StdioTransport } from '../stdio.js'

/**
 * `StdioTransport` appended every stdout read to its buffer and kept the part
 * after the last newline as the pending line, with nothing bounding that
 * tail. A local server that writes one very long line — or simply never
 * terminates one — therefore grew the session's memory for as long as it kept
 * writing, and the transport said nothing while it did.
 *
 * These drive a real child through the real transport, so what they measure
 * is the buffer the transport actually held, not what a fake reported.
 */

const FIXTURE = fileURLToPath(new URL('../__fixtures__/floods-its-output.mjs', import.meta.url))

const cleanupPids = new Set<number>()

afterEach(() => {
	for (const pid of cleanupPids) {
		try {
			process.kill(pid, 'SIGKILL')
		} catch {
			// Already gone; nothing to clean.
		}
	}
	cleanupPids.clear()
})

/** A logger that keeps every `warn` body and bag, and swallows the rest. */
function recordingLogger(): { logger: Logger; warnings: [string, LogAttributes?][] } {
	const warnings: [string, LogAttributes?][] = []
	const sink = {
		debug: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		warn: (message: string, attributes?: LogAttributes) => {
			warnings.push([message, attributes])
		},
	}
	const logger = { ...sink, child: () => logger } as unknown as Logger
	return { logger, warnings }
}

/** The child the transport spawned, read before `close()` clears the field. */
function childOf(transport: StdioTransport): ChildProcess {
	const child = (transport as unknown as { process: ChildProcess | null }).process
	if (!child) throw new Error('transport spawned no process')
	return child
}

function pidOf(transport: StdioTransport): number {
	const pid = childOf(transport).pid
	if (pid === undefined) throw new Error('transport spawned no process')
	return pid
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** The transport's pending line, read where the class holds it. */
function pendingLine(transport: StdioTransport): string {
	return (transport as unknown as { buffer: string }).buffer
}

// No wall-clock deadline: a condition that never holds is a hang, which the
// per-test timeout reports. A deadline here would only measure how fast the
// host drains a real child's pipe.
async function waitUntil(predicate: () => boolean): Promise<void> {
	while (!predicate()) {
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

describe('a server that floods its output', () => {
	it('drops an unterminated line past the ceiling, says so once, and reads the frame after it', async () => {
		const { logger, warnings } = recordingLogger()
		const transport = new StdioTransport(
			{
				type: 'stdio',
				command: process.execPath,
				args: [FIXTURE, String(MCP_STDIO_MAX_PENDING_LINE_CHARS * 2)],
			},
			logger,
		)
		const seen: MCPJsonRpcMessage[] = []
		transport.onMessage((message) => seen.push(message))
		await transport.connect()

		const child = childOf(transport)
		const pid = pidOf(transport)
		cleanupPids.add(pid)

		// Sampled after every read the transport handled. Its own `data`
		// listener was registered first, so this one runs once the buffer for
		// that read has been decided — the peak is measured where the flood
		// used to be held, rather than by polling a clock and hoping.
		let peakPending = 0
		child.stdout?.on('data', () => {
			peakPending = Math.max(peakPending, pendingLine(transport).length)
		})

		await waitUntil(() => seen.length > 0)

		const refusals = warnings.filter(([message]) => message.includes('pending-line ceiling'))
		expect(refusals).toHaveLength(1)
		expect(refusals[0]?.[1]?.['namzu.mcp.line_ceiling']).toBe(MCP_STDIO_MAX_PENDING_LINE_CHARS)
		expect(peakPending).toBeLessThanOrEqual(MCP_STDIO_MAX_PENDING_LINE_CHARS)
		// Refused, not parsed as garbage: the rest of that line is dropped up
		// to its terminator instead of being re-buffered and re-reported once
		// per read.
		expect(warnings.filter(([message]) => message.includes('invalid JSON-RPC'))).toHaveLength(0)
		expect((seen[0] as { method?: string }).method).toBe('notifications/flooded')

		// The refusal must not cost the child: teardown still reaps it.
		expect(isAlive(pid)).toBe(true)
		await transport.close()
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
		expect(isAlive(pid)).toBe(false)
		cleanupPids.delete(pid)
	})

	it('reports a stderr flood in bounded records instead of the whole read', async () => {
		const stderrBytes = MCP_STDIO_STDERR_LOG_CHARS * 400
		const { logger, warnings } = recordingLogger()
		const transport = new StdioTransport(
			{ type: 'stdio', command: process.execPath, args: [FIXTURE, '0', String(stderrBytes)] },
			logger,
		)
		await transport.connect()
		const pid = pidOf(transport)
		cleanupPids.add(pid)

		const records = () => warnings.filter(([message]) => message === 'MCP server stderr')
		const reported = () =>
			records().reduce(
				(total, [, attributes]) => total + Number(attributes?.['namzu.mcp.stderr_chars'] ?? 0),
				0,
			)

		await waitUntil(() => reported() >= stderrBytes)

		expect(reported()).toBe(stderrBytes)
		expect(records().length).toBeGreaterThan(0)
		const shown = records().map(([, attributes]) => String(attributes?.['namzu.mcp.stderr']))
		for (const text of shown) {
			expect(text.length).toBeLessThanOrEqual(MCP_STDIO_STDERR_LOG_CHARS)
		}
		// The record says how much it is not showing, so the head is not
		// mistaken for the whole read.
		expect(Math.max(...shown.map((text) => text.length))).toBeLessThan(stderrBytes)
		expect(
			Math.max(
				...records().map(([, attributes]) => Number(attributes?.['namzu.mcp.stderr_chars'])),
			),
		).toBeGreaterThan(MCP_STDIO_STDERR_LOG_CHARS)

		await transport.close()
		expect(isAlive(pid)).toBe(false)
		cleanupPids.delete(pid)
	})
})
