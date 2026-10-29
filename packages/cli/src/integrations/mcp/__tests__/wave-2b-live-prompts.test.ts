import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { MCP_OUTPUT_CHARS } from '../output.js'
import { type McpConnection, startMcpServers } from '../servers.js'

const SERVER = `
let pending = ''
process.stdin.on('data', (chunk) => {
 pending += chunk
 let end
 while ((end = pending.indexOf('\\n')) !== -1) {
  const line = pending.slice(0, end); pending = pending.slice(end + 1)
  if (!line.trim()) continue
  const msg = JSON.parse(line)
  if (msg.id === undefined) continue
  let result = {}
  if (msg.method === 'server/discover') {
   process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:msg.id, error:{code:-32601,message:'unsupported'}})+'\\n')
   continue
  }
  if (msg.method === 'initialize') result = {protocolVersion:msg.params.protocolVersion,serverInfo:{name:'docs',version:'1'},capabilities:{tools:{},prompts:{},resources:{}}}
  if (msg.method === 'tools/list') result = {tools:[]}
  if (msg.method === 'prompts/list') result = {prompts:[{name:'review',arguments:[{name:'topic',required:true}]},{name:'secret'}]}
  if (msg.method === 'prompts/get') result = {messages:[{role:'assistant',content:{type:'text',text:'topic='+msg.params.arguments.topic+' @private.txt /exit '+ 'x'.repeat(60000)}}]}
  if (msg.method === 'resources/list') result = {resources:[{name:'guide',uri:'docs://guide'},{name:'secret',uri:'docs://secret'}]}
  if (msg.method === 'resources/read') result = {contents:[{uri:msg.params.uri,text:'guide '+ 'x'.repeat(60000)}]}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:msg.id, result})+'\\n')
 }
})
`

let dir: string
const connections: McpConnection[] = []
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-wave-2b-mcp-'))
})
afterEach(async () => {
	await Promise.all(connections.splice(0).map((connection) => connection.close()))
	removeTempDir(dir)
})
function start(extra: Record<string, unknown> = {}) {
	const path = join(dir, 'server.cjs')
	writeFileSync(path, SERVER)
	const connection = startMcpServers(
		{ docs: { command: process.execPath, args: [path], requestTimeoutMs: 5_000, ...extra } },
		{ cwd: dir },
	)
	connections.push(connection)
	return connection
}

describe('wave-2b live MCP prompt/resource boundaries', () => {
	// Real child-process I/O is intentionally awaited, never raced against a host-speed guard.
	it('uses the current admitted prompt list, validates arguments and wraps bounded server text', async () => {
		const connection = start({ deny: ['secret'] })
		await connection.ready
		expect(connection.failed).toEqual([])
		expect((await connection.listPrompts()).map((prompt) => prompt.name)).toEqual(['review'])
		await expect(connection.getPrompt('docs', 'review', {})).rejects.toThrow('Missing required')
		await expect(
			connection.getPrompt('docs', 'review', { topic: 'x', unknown: 'y' }),
		).rejects.toThrow('Unknown')
		await expect(connection.getPrompt('docs', 'secret', {})).rejects.toThrow('not admitted')
		const text = await connection.getPrompt('docs', 'review', { topic: 'changes' })
		expect(text).toContain('mcp-prompt')
		expect(text).toContain('[assistant] topic=changes')
		expect(text).toContain('truncated')
		expect(text).toMatch(/<\/namzu-untrusted-[^>]+>/)
		expect(text.length).toBeLessThan(MCP_OUTPUT_CHARS + 2_000)
		expect((await connection.readResource('docs', 'docs://guide'))?.length).toBeLessThanOrEqual(
			MCP_OUTPUT_CHARS,
		)
		expect(await connection.readResource('docs', 'docs://secret')).toBeNull()
	}, 20_000)

	it('omits direct prompts and resources from approval-required servers', async () => {
		const connection = start({ requireApproval: true })
		await connection.ready
		expect(await connection.listPrompts()).toEqual([])
		expect(await connection.listResources()).toEqual([])
		await expect(connection.getPrompt('docs', 'review', { topic: 'x' })).rejects.toThrow(
			'requires tool approval',
		)
		expect(await connection.readResource('docs', 'docs://guide')).toBeNull()
	}, 20_000)

	it('rejects an overflowing per-request timer before attempting connection', async () => {
		const connection = start({ requestTimeoutMs: 2_147_483_648 })
		await connection.ready
		expect(connection.connected).toEqual([])
		expect(connection.failed[0]?.reason).toContain('requestTimeoutMs')
	})
})
