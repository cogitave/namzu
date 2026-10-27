/**
 * A headless run cannot ask whether to start a project's tool servers, so it
 * says once, in one plain line, that they are waiting. Without it a server
 * that never started looks like a server that was never declared.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { approveProjectMcpServers } from '../../integrations/mcp/project-approval.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { execCommand } from '../exec.js'
import type { CommandContext } from '../types.js'
import { execJsonCommand } from './exec-json-command.js'

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: vi.fn(async () => ({}) as never),
	resolveConversation: vi.fn(async () => 'conv-1' as never),
	loadConversation: vi.fn(async () => []),
	closeSessions: vi.fn(),
}))
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } },
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	})),
	createAgentSession: vi.fn(async () => fakeAgentSession()),
}))

const roots: string[] = []
let stdinWasTTY: boolean | undefined
const servers = { tickets: { command: 'node' }, docs: { url: 'https://d.example/mcp' } }

function folder(): { cwd: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), 'namzu-exec-pending-'))
	roots.push(root)
	const cwd = join(root, 'work')
	mkdirSync(cwd, { recursive: true })
	mkdirSync(join(root, 'namzu-home'), { recursive: true })
	writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
	return { cwd, home: join(root, 'namzu-home') }
}

beforeEach(() => {
	stdinWasTTY = process.stdin.isTTY
	Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
})

afterEach(() => {
	Object.defineProperty(process.stdin, 'isTTY', { value: stdinWasTTY, configurable: true })
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function plainContext(info: string[]): CommandContext {
	return {
		formatter: {
			name: 'text' as const,
			print: () => {},
			info: (line: string) => info.push(line),
			error: () => {},
		},
		config: {},
	} as unknown as CommandContext
}

it('exec prints one line naming the servers that are waiting', async () => {
	const { cwd, home } = folder()
	vi.stubEnv('NAMZU_HOME', home)
	const info: string[] = []

	await execCommand.handler({ rawArgs: ['--cwd', cwd, 'hello'], ctx: plainContext(info) } as never)

	const waiting = info.filter((line) => line.includes('waiting for your approval'))
	expect(waiting).toHaveLength(1)
	expect(waiting[0]).toContain('2 tool servers')
	expect(waiting[0]).toContain('tickets, docs')
	expect(waiting[0]).toContain('namzu mcp approve')
})

it('exec says nothing once they are approved', async () => {
	const { cwd, home } = folder()
	vi.stubEnv('NAMZU_HOME', home)
	approveProjectMcpServers(home, cwd, servers as never)
	const info: string[] = []

	await execCommand.handler({ rawArgs: ['--cwd', cwd, 'hello'], ctx: plainContext(info) } as never)

	expect(info.filter((line) => line.includes('waiting for your approval'))).toEqual([])
})

it('exec --json reports it as one notice on the stream', async () => {
	const { cwd, home } = folder()
	vi.stubEnv('NAMZU_HOME', home)
	const lines: string[] = []
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		lines.push(String(chunk))
		return true
	})

	await execJsonCommand.handler({
		rawArgs: ['--cwd', cwd, 'hello'],
		ctx: { config: {} },
	} as never)

	const events = lines
		.join('')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { kind: string; message?: string })
	const notices = events.filter(
		(event) => event.kind === 'notice' && event.message?.includes('waiting for your approval'),
	)
	expect(notices).toHaveLength(1)
	expect(notices[0]?.message).toContain('tickets, docs')
})
