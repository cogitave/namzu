/**
 * What a connected tool server lets the `@` picker offer and a mention read.
 * A real child process speaking JSON-RPC over stdio, as in `connect.test.ts`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

import { type McpConnection, startMcpServers } from '../servers.js'

let dir: string
const open: McpConnection[] = []

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-mcp-res-'))
})

afterEach(async () => {
	await Promise.all(open.splice(0).map((connection) => connection.close()))
	removeTempDir(dir)
})

/** Publishes two resources; `secret://x` is listed but the config denies it. */
const DOCS_SERVER = `
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
        serverInfo: { name: 'docs', version: '1' },
        capabilities: { tools: {}, resources: {} },
      }})
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
    } else if (msg.method === 'resources/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { resources: [
        { uri: 'docs://guide', name: 'guide', description: 'The setup guide' },
        { uri: 'docs://secret', name: 'secret' },
      ]}})
    } else if (msg.method === 'resources/read') {
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: [
        { uri: msg.params.uri, mimeType: 'text/plain', text: 'text of ' + msg.params.uri },
      ]}})
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
`

function start(extra: Record<string, unknown> = {}): McpConnection {
	const path = join(dir, 'docs.js')
	writeFileSync(path, DOCS_SERVER)
	const connection = startMcpServers(
		{ docs: { command: process.execPath, args: [path], ...extra } },
		{ cwd: dir },
	)
	open.push(connection)
	return connection
}

describe('resources a tool server publishes', () => {
	it('lists what the server publishes and reads one it listed', async () => {
		const connection = start()
		await connection.ready
		expect(await connection.listResources()).toEqual([
			{ server: 'docs', uri: 'docs://guide', name: 'guide', description: 'The setup guide' },
			{ server: 'docs', uri: 'docs://secret', name: 'secret' },
		])
		expect(await connection.readResource('docs', 'docs://guide')).toBe('text of docs://guide')
	})

	it('does not read an address the server never listed, or from a server that is not connected', async () => {
		const connection = start()
		await connection.ready
		expect(await connection.readResource('docs', 'docs://unlisted')).toBeNull()
		expect(await connection.readResource('other', 'docs://guide')).toBeNull()
	})

	it('leaves out what the server config denies, and cannot read it either', async () => {
		const connection = start({ deny: ['secret'] })
		await connection.ready
		expect((await connection.listResources()).map((r) => r.uri)).toEqual(['docs://guide'])
		expect(await connection.readResource('docs', 'docs://secret')).toBeNull()
	})

	it('offers nothing from a server that asks for approval before use', async () => {
		const connection = start({ requireApproval: true })
		await connection.ready
		expect(await connection.listResources()).toEqual([])
		expect(await connection.readResource('docs', 'docs://guide')).toBeNull()
	})
})
