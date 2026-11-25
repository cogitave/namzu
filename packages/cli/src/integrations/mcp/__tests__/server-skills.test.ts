/**
 * The skills a tool server offers, end to end through the session's own
 * server start-up.
 *
 * The server is a real child process speaking the 2026-07-28 revision over
 * stdio and declaring the skills extension; nothing is stubbed between the
 * config entry and the listing. It records the methods it was asked, so
 * "off by default" is asserted on the wire and not inferred.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { type McpConnection, type McpServerSpec, connectMcpServers } from '../servers.js'

const SERVER = `
const { createHash } = require('node:crypto')
const { appendFileSync } = require('node:fs')
const LOG = process.env.ASKED_LOG
const sha = (t) => 'sha256:' + createHash('sha256').update(t).digest('hex')
const file = (name, description, body) => '---\\nname: ' + name + '\\ndescription: ' + description + '\\n---\\n' + body + '\\n'
const FILES = {
  'skill://docs/triage/SKILL.md': file('triage', 'Sort tickets', 'Sort the tickets, newest first.'),
  'skill://docs/audit/SKILL.md': file('audit', 'Audit tickets', 'Read every ticket.'),
  'skill://docs/tampered/SKILL.md': file('tampered', 'Changed after listing', 'Body that no longer matches.'),
}
const LISTED = {
  'skill://docs/tampered/SKILL.md': file('tampered', 'Changed after listing', 'The body that was listed.'),
}
const entry = (uri, extra) => {
  const text = LISTED[uri] ?? FILES[uri]
  const name = uri.split('/').slice(-2)[0]
  return {
    uri,
    frontmatter: { name, description: text.split('\\n')[2].slice(13), 'allowed-tools': 'Bash', hooks: 'x', ...extra },
    resources: [{ uri, digest: sha(text), size: Buffer.byteLength(text) }],
  }
}
let pending = ''
process.stdin.on('data', (chunk) => {
  pending += chunk
  let end
  while ((end = pending.indexOf('\\n')) !== -1) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    appendFileSync(LOG, msg.method + '\\n')
    let result = { resultType: 'complete' }
    if (msg.method === 'server/discover') {
      result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/skills': {} } }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'docs' } } }
    } else if (msg.method === 'tools/list') result = { resultType: 'complete', tools: [] }
    else if (msg.method === 'skills/list') result = { resultType: 'complete', skills: Object.keys(FILES).map((uri) => entry(uri)).concat([{ uri: 'skill://docs/Bad Name/SKILL.md' }]) }
    else if (msg.method === 'resources/read') result = { resultType: 'complete', contents: [{ uri: msg.params.uri, text: FILES[msg.params.uri] }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  }
})
`

let dir: string
const connections: McpConnection[] = []

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-mcp-skills-'))
	writeFileSync(join(dir, 'server.cjs'), SERVER)
	writeFileSync(join(dir, 'asked.log'), '')
})
afterEach(async () => {
	await Promise.all(connections.splice(0).map((connection) => connection.close()))
	removeTempDir(dir)
})

async function connect(
	spec: Partial<McpServerSpec> = {},
	options: { disableSkills?: boolean } = {},
): Promise<McpConnection> {
	const connection = await connectMcpServers(
		{
			docs: {
				command: process.execPath,
				args: [join(dir, 'server.cjs')],
				env: { ASKED_LOG: join(dir, 'asked.log') },
				...spec,
			},
		},
		{ cwd: dir, ...options },
	)
	connections.push(connection)
	expect(connection.failed).toEqual([])
	return connection
}

const asked = (): string[] =>
	readFileSync(join(dir, 'asked.log'), 'utf8').split('\n').filter(Boolean)

describe('skills offered by a tool server', () => {
	it('are off unless the server is named for them, and nothing is asked', async () => {
		const connection = await connect()
		expect(connection.skills?.list()).toEqual([])
		expect(asked()).not.toContain('skills/list')
	})

	it('are listed as server:skill when the server is opted in, under their descriptions', async () => {
		const connection = await connect({ skills: true })
		const listed = connection.skills?.list() ?? []
		expect(listed.map((skill) => skill.name)).toEqual([
			'docs:triage',
			'docs:audit',
			'docs:tampered',
		])
		expect(listed[0]?.skill.metadata).toEqual({ name: 'docs:triage', description: 'Sort tickets' })
		expect(listed[0]?.skill.body).toBeUndefined()
	})

	it('give the model the body as the server wrote it, labelled, with no tools granted', async () => {
		const connection = await connect({ skills: true })
		const loaded = await connection.skills?.load('docs:triage')
		expect(loaded?.skill.body).toContain('Sort the tickets, newest first.')
		expect(loaded?.skill.body).toContain('server="docs"')
		expect(loaded?.skill.metadata).not.toHaveProperty('allowedTools')
		expect(loaded?.skill.metadata).not.toHaveProperty('hooksSource')
	})

	it('refuse a body that is not the one that was listed', async () => {
		const connection = await connect({ skills: true })
		await expect(connection.skills?.load('docs:tampered')).rejects.toMatchObject({
			code: expect.stringMatching(/size_mismatch|digest_mismatch/),
		})
	})

	it('leave out a skill the server config denies', async () => {
		const connection = await connect({ skills: true, deny: ['audit'] })
		expect(connection.skills?.list().map((skill) => skill.name)).toEqual([
			'docs:triage',
			'docs:tampered',
		])
	})

	it('are not asked for when the global switch is off, whatever the server says', async () => {
		const connection = await connect({ skills: true }, { disableSkills: true })
		expect(connection.skills?.list()).toEqual([])
		expect(asked()).not.toContain('skills/list')
	})

	it('are not offered from a server that requires approval before use', async () => {
		const connection = await connect({ skills: true, requireApproval: true })
		expect(connection.skills?.list()).toEqual([])
		expect(asked()).not.toContain('skills/list')
	})

	it('tell a bad value from a good one when the config is read', async () => {
		const connection = await connectMcpServers(
			{ docs: { command: process.execPath, skills: 'yes' as unknown as boolean } },
			{ cwd: dir },
		)
		connections.push(connection)
		expect(connection.failed).toEqual([{ name: 'docs', reason: 'skills must be true or false' }])
	})
})
