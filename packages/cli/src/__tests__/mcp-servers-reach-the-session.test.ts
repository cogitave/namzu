/**
 * A tool server written into a config file ends up in the roster the model is
 * shown.
 *
 * The chain has three places to break, in series, and `packages/cli` has been
 * cut by two of them before:
 *
 *   namzu.config.json → loadConfig() → createAgentSession() → the tool registry
 *                     ↑ the reader              ↑ the connect  ↑ the register
 *
 * `permissions` was dropped by the loader for its whole existence and again by
 * the turn, and every test at the time sat on one side or the other of a break.
 * So this one starts at a real config file and ends at `session.toolNames` —
 * the list `/tools` prints and the registry the turn is built from.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../config/load.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: () => (async function* () {})(),
	}
})

let work: string

const SERVER = `
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
      ]}})
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
`

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'namzu-mcp-session-'))
})

afterEach(async () => {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(work, { recursive: true, force: true })
			return
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	}
	rmSync(work, { recursive: true, force: true })
})

const prefs = {
	version: 2,
	provider: 'anthropic',
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

describe('a tool server declared in namzu.config.json', () => {
	it('survives the config loader', () => {
		// The failure this pins: a public config field with no reader is parsed,
		// type-checks, and never arrives. It happened to `permissions`.
		writeFileSync(
			join(work, 'namzu.config.json'),
			JSON.stringify({ mcpServers: { tickets: { command: 'node', args: ['x.js'] } } }),
		)

		const cfg = loadConfig({ cwd: work, home: work, env: {} })

		expect(cfg.mcpServers?.tickets?.command).toBe('node')
		expect(cfg.mcpServers?.tickets?.args).toEqual(['x.js'])
	})

	it('is in the tool roster the session hands the model', async () => {
		const server = join(work, 'tickets.js')
		writeFileSync(server, SERVER)
		writeFileSync(
			join(work, 'namzu.config.json'),
			JSON.stringify({
				mcpServers: { tickets: { command: process.execPath, args: [server] } },
			}),
		)

		const cfg = loadConfig({ cwd: work, home: work, env: {} })
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: work,
			...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
		})
		try {
			expect(session.mcpFailed).toEqual([])
			expect(session.mcpConnected).toEqual([{ name: 'tickets', toolCount: 1 }])
			// The load-bearing one. Connecting and adapting is not the feature —
			// the model has to be able to see and call it.
			expect(session.toolNames).toContain('mcp_tickets_create')
		} finally {
			await session.close()
		}
	}, 20_000)

	it('does not take the builtin tools away', async () => {
		// Registering an extra set is the ordinary way to lose the existing one.
		const server = join(work, 'tickets.js')
		writeFileSync(server, SERVER)

		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: work,
			mcpServers: { tickets: { command: process.execPath, args: [server] } },
		})
		try {
			expect(session.toolNames).toContain('bash')
			expect(session.toolNames).toContain('read')
			expect(session.toolNames).toContain('mcp_tickets_create')
		} finally {
			await session.close()
		}
	}, 20_000)

	it('reports a server that failed, and adds no tools from it', async () => {
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: work,
			mcpServers: { tickets: { command: join(work, 'no-such-executable') } },
		})
		try {
			expect(session.mcpConnected).toEqual([])
			expect(session.mcpFailed.map((f) => f.name)).toEqual(['tickets'])
			expect(session.toolNames.some((n) => n.startsWith('mcp_'))).toBe(false)
		} finally {
			await session.close()
		}
	})

	it('adds nothing and reports nothing when none is configured', async () => {
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { cwd: work })
		try {
			expect(session.mcpConnected).toEqual([])
			expect(session.mcpFailed).toEqual([])
			expect(session.toolNames.some((n) => n.startsWith('mcp_'))).toBe(false)
		} finally {
			await session.close()
		}
	})
})
