/**
 * Tool servers connect without holding the session back.
 *
 * Real child processes speaking real JSON-RPC over stdio, as in `connect.test.ts`.
 * A server that "never answers" is given the longest deadline the config
 * allows, so nothing here decides its outcome by how long a machine takes: the
 * silent server stays unanswered until the test closes the connection.
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

import { type McpConnection, startMcpServers } from '../servers.js'

let dir: string
const open: McpConnection[] = []

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-mcp-bg-'))
})

afterEach(async () => {
	await Promise.all(open.splice(0).map((connection) => connection.close()))
	removeTempDir(dir)
})

const FOREVER = 2_147_483_647

/** Starts, records that it started, and never answers. */
const SILENT_SERVER = `
if (process.argv[2]) require('node:fs').writeFileSync(process.argv[2], 'up')
setInterval(() => {}, 1000)
`

const WORKING_SERVER = `
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
        { name: 'create', description: 'Open a ticket', inputSchema: { type: 'object', properties: {} } },
      ]}})
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
`

function script(name: string, body: string): string {
	const path = join(dir, name)
	writeFileSync(path, body)
	return path
}

/** Resolves when the server has settled; the listener is registered before anything can settle. */
function settled(connection: McpConnection, name: string): Promise<void> {
	return new Promise((resolve) => {
		const off = connection.onSettled((who) => {
			if (who !== name) return
			off()
			resolve()
		})
	})
}

const track = (connection: McpConnection): McpConnection => {
	open.push(connection)
	return connection
}

describe('starting tool servers', () => {
	it('returns at once, with the tools of each server joining as it answers', async () => {
		const quiet = script('quiet.js', SILENT_SERVER)
		const tickets = script('tickets.js', WORKING_SERVER)
		const connection = track(
			startMcpServers(
				{
					quiet: { command: process.execPath, args: [quiet], connectTimeoutMs: FOREVER },
					tickets: { command: process.execPath, args: [tickets] },
				},
				{ cwd: dir },
			),
		)
		const ticketsSettled = settled(connection, 'tickets')

		// Nothing has answered yet, and the caller already has the roster.
		expect(connection.pending).toEqual(['quiet', 'tickets'])
		expect(connection.tools).toEqual([])
		expect(connection.toolsets).toHaveLength(4)

		await ticketsSettled
		// The silent server is still being reached; the working one is not waiting for it.
		expect(connection.pending).toEqual(['quiet'])
		expect(connection.tools.map((tool) => tool.name)).toEqual(['mcp__tickets__create'])
		expect(connection.current().connected.map((server) => server.name)).toEqual(['tickets'])
		expect(connection.current().failed).toEqual([])
	}, 30_000)

	it('tells the tool manager to look again when a server joins', async () => {
		const tickets = script('tickets.js', WORKING_SERVER)
		const connection = track(
			startMcpServers({ tickets: { command: process.execPath, args: [tickets] } }, { cwd: dir }),
		)
		let changes = 0
		for (const entry of connection.toolsets) entry.onChange?.(() => changes++)
		await connection.ready
		expect(changes).toBeGreaterThan(0)
	}, 30_000)

	it('reports a server that cannot start as soon as it fails, while others carry on', async () => {
		const tickets = script('tickets.js', WORKING_SERVER)
		const connection = track(
			startMcpServers(
				{
					gone: { command: join(dir, 'no-such-program-here') },
					tickets: { command: process.execPath, args: [tickets] },
				},
				{ cwd: dir },
			),
		)
		await connection.ready
		const status = connection.current()
		expect(status.connected.map((server) => server.name)).toEqual(['tickets'])
		expect(status.failed.map((server) => server.name)).toEqual(['gone'])
		expect(status.pending).toEqual([])
	}, 30_000)

	it('reaches child-process servers a few at a time', async () => {
		const marks = [0, 1, 2, 3].map((n) => join(dir, `up-${n}`))
		const servers = Object.fromEntries(
			marks.map((mark, n) => [
				`s${n}`,
				{
					command: process.execPath,
					args: [script(`silent-${n}.js`, SILENT_SERVER), mark],
					connectTimeoutMs: FOREVER,
				},
			]),
		)
		const connection = track(startMcpServers(servers, { cwd: dir, localBatch: 3 }))
		// Await the starts themselves; the pool admits three and holds the fourth.
		for (const mark of marks.slice(0, 3)) {
			while (!existsSync(mark)) await new Promise<void>((resolve) => setImmediate(resolve))
		}
		expect(existsSync(marks[3] as string)).toBe(false)
		expect(connection.pending).toHaveLength(4)
	}, 30_000)

	it('leaves no child process waiting when it is closed before a server answered', async () => {
		const quiet = script('quiet.js', SILENT_SERVER)
		const connection = startMcpServers(
			{ quiet: { command: process.execPath, args: [quiet], connectTimeoutMs: FOREVER } },
			{ cwd: dir },
		)
		await connection.close()
		// The connection attempt ends because it was closed, not because a deadline passed.
		await connection.ready
		expect(connection.pending).toEqual([])
	}, 30_000)
})
