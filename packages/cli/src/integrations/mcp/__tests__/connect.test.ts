/**
 * An external tool server declared in the config is actually reachable.
 *
 * The server here is a REAL child process speaking real JSON-RPC over stdio,
 * written to a temp file and spawned by the shipped transport. A stubbed
 * transport would prove the adapter agrees with itself and would say nothing
 * about the thing that actually breaks: a process that spawns, or does not, and
 * a handshake that answers, or does not.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { connectMcpServers, transportFor } from '../servers.js'

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-mcp-'))
})

afterEach(async () => {
	// A child's working directory is the temp directory, and `close()` sends
	// SIGTERM without waiting for the exit — so on Windows the directory is
	// still held for a moment after the last assertion. Retried rather than
	// ignored: a directory that never frees would mean a process that never
	// died, which is the failure `close()` exists to prevent.
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true })
			return
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	}
	rmSync(dir, { recursive: true, force: true })
})

/** Resolves once the process is gone, or throws after the deadline. */
async function waitForExit(pid: number, deadlineMs = 5_000): Promise<void> {
	const until = Date.now() + deadlineMs
	for (;;) {
		try {
			// Signal 0 tests for existence without delivering anything.
			process.kill(pid, 0)
		} catch {
			return
		}
		if (Date.now() > until) throw new Error(`process ${pid} was still alive after ${deadlineMs}ms`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

/**
 * The smallest server that satisfies the protocol: initialize, tools/list,
 * tools/call. Newline-delimited JSON-RPC on stdio, which is the wire the
 * shipped `StdioTransport` speaks.
 */
function writeServer(name: string, body: string): string {
	const path = join(dir, name)
	writeFileSync(path, body)
	return path
}

const WORKING_SERVER = `
if (process.argv[2]) require('node:fs').writeFileSync(process.argv[2], String(process.pid))
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        serverInfo: { name: 'tickets', version: '1' },
        capabilities: { tools: {} },
      }})
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'create', description: 'Open a ticket', inputSchema: {
          type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
        { name: 'close', description: 'Close a ticket', inputSchema: {
          type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      ]}})
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'opened ' + msg.params.arguments.title }],
      }})
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
`

/** Starts, and never answers. The case a request timeout cannot cover. */
const SILENT_SERVER = `setInterval(() => {}, 1000)\n`

describe('a declared server', () => {
	it('brings its tools, named after it', async () => {
		const server = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)
		try {
			expect(mcp.failed).toEqual([])
			expect(mcp.connected).toEqual([{ name: 'tickets', toolCount: 2 }])
			// Prefixed with the server name so two servers offering `create` do
			// not collide and the transcript says where a call went.
			expect(mcp.tools.map((t) => t.name)).toEqual(['mcp_tickets_create', 'mcp_tickets_close'])
		} finally {
			await mcp.close()
		}
	})

	it('produces tools that actually call the server', async () => {
		// The tool objects existing is not the feature. Registering something the
		// model can see and cannot successfully invoke is worse than having
		// nothing, because the failure arrives mid-task.
		const server = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)
		try {
			const create = mcp.tools.find((t) => t.name === 'mcp_tickets_create')
			const result = await create?.execute({ title: 'the build is red' }, {} as never)
			expect(result?.success).toBe(true)
			expect(JSON.stringify(result?.output)).toContain('opened the build is red')
		} finally {
			await mcp.close()
		}
	})

	it('leaves no child process behind when the session closes', async () => {
		// The reason `close()` exists. A stdio server is a child process and
		// nothing else in this package owns one, so before this there was no
		// shutdown path at all: every TUI session and every one-shot left its
		// servers running.
		const server = writeServer('tickets.js', WORKING_SERVER)
		const pidFile = join(dir, 'server.pid')

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server, pidFile] } },
			{ cwd: dir },
		)
		const pid = Number(readFileSync(pidFile, 'utf8'))
		expect(Number.isInteger(pid), 'the server must have actually started').toBe(true)
		expect(() => process.kill(pid, 0), 'and must be alive before the close').not.toThrow()

		await mcp.close()

		await waitForExit(pid)
	}, 20_000)

	it('is absent from the roster when nothing is configured', async () => {
		const mcp = await connectMcpServers(undefined, { cwd: dir })

		expect(mcp.tools).toEqual([])
		expect(mcp.connected).toEqual([])
		expect(mcp.failed).toEqual([])
		await mcp.close()
	})
})

describe('a server that does not work is named, never merely absent', () => {
	it('reports a command that cannot be spawned', async () => {
		const mcp = await connectMcpServers(
			{ tickets: { command: join(dir, 'no-such-executable') } },
			{ cwd: dir },
		)

		expect(mcp.connected).toEqual([])
		expect(mcp.failed).toHaveLength(1)
		expect(mcp.failed[0]?.name).toBe('tickets')
		expect(mcp.failed[0]?.reason.length).toBeGreaterThan(0)
		await mcp.close()
	})

	it('reports a server that starts and never answers, rather than hanging', async () => {
		// The client's per-request timeout cannot cover this: the process is up,
		// the pipe is open, and nothing is coming. Without the connect deadline a
		// single wedged server holds the whole session open before the first turn
		// — no error, no failure, just a namzu that does not start.
		const server = writeServer('silent.js', SILENT_SERVER)

		const started = Date.now()
		const mcp = await connectMcpServers(
			{ quiet: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)

		expect(mcp.failed[0]?.name).toBe('quiet')
		expect(mcp.failed[0]?.reason).toContain('did not answer')
		expect(Date.now() - started, 'the deadline has to actually bound it').toBeLessThan(30_000)
		await mcp.close()
	}, 40_000)

	it('does not let one broken server take the working ones with it', async () => {
		const good = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{
				broken: { command: join(dir, 'no-such-executable') },
				tickets: { command: process.execPath, args: [good] },
			},
			{ cwd: dir },
		)
		try {
			expect(mcp.failed.map((f) => f.name)).toEqual(['broken'])
			expect(mcp.connected.map((c) => c.name)).toEqual(['tickets'])
		} finally {
			await mcp.close()
		}
	})
})

describe('a spec that is not a server', () => {
	it('refuses one that names neither a command nor a url', () => {
		expect(transportFor({}, dir)).toContain('neither a command nor a url')
	})

	it('refuses one that names both, rather than picking', () => {
		// An operator who edited a url into an entry that already had a command
		// meant one of them. Choosing for them runs something they did not ask
		// to run.
		expect(transportFor({ command: 'x', url: 'https://y' }, dir)).toContain('both')
	})

	it('reports a bad spec by name, alongside the servers that worked', async () => {
		const good = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{ nonsense: {}, tickets: { command: process.execPath, args: [good] } },
			{ cwd: dir },
		)
		try {
			expect(mcp.failed[0]?.name).toBe('nonsense')
			expect(mcp.connected.map((c) => c.name)).toEqual(['tickets'])
		} finally {
			await mcp.close()
		}
	})

	it('defaults a stdio server to the agent working directory', () => {
		const transport = transportFor({ command: 'node' }, dir)

		expect(typeof transport).not.toBe('string')
		expect((transport as { cwd?: string }).cwd).toBe(dir)
	})
})
