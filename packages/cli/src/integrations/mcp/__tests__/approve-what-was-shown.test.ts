/**
 * Accepting a folder approves the tool servers its screen listed, as the
 * entries were when the screen was built. A file that changes while the screen
 * is open must not be approved by an answer given to the old text.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { loadConfig, pendingProjectMcpServers } from '../../../config/load.js'
import { readFolderGrants } from '../../trust/folder-grants.js'
import { approveShownMcpServers, pendingServersMessage } from '../project-approval.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function project(servers: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-shown-'))
	roots.push(root)
	const home = join(root, 'namzu-home')
	const cwd = join(root, 'work')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	const write = (next: Record<string, unknown>) =>
		writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: next }))
	write(servers)
	return { home, cwd, write }
}

it('approves the entries that were shown', () => {
	const { home, cwd } = project({
		tickets: { command: 'node' },
		docs: { url: 'https://d.example/mcp' },
	})
	const shown = readFolderGrants(cwd).toolServers

	approveShownMcpServers(home, cwd, shown)

	expect(pendingProjectMcpServers({ cwd, env: { NAMZU_HOME: home } }).pending).toEqual([])
})

it('leaves an entry that changed after the screen was built waiting', () => {
	const { home, cwd, write } = project({
		tickets: { command: 'node' },
		docs: { url: 'https://d.example/mcp' },
	})
	const shown = readFolderGrants(cwd).toolServers

	// The file is rewritten while the question is on screen.
	write({
		tickets: { command: 'sh', args: ['-c', 'echo changed'] },
		docs: { url: 'https://d.example/mcp' },
	})
	approveShownMcpServers(home, cwd, shown)

	expect(pendingProjectMcpServers({ cwd, env: { NAMZU_HOME: home } }).pending).toEqual(['tickets'])
	expect(Object.keys(loadConfig({ cwd, env: { NAMZU_HOME: home } }).mcpServers ?? {})).toEqual([
		'docs',
	])
})

it('does not approve a server added after the screen was built', () => {
	const { home, cwd, write } = project({ tickets: { command: 'node' } })
	const shown = readFolderGrants(cwd).toolServers

	write({ tickets: { command: 'node' }, extra: { command: 'sh' } })
	approveShownMcpServers(home, cwd, shown)

	expect(pendingProjectMcpServers({ cwd, env: { NAMZU_HOME: home } }).pending).toEqual(['extra'])
})

it('says in one plain line which servers are waiting', () => {
	expect(pendingServersMessage(['tickets'])).toBe(
		'1 tool server from this project\'s .mcp.json is waiting for your approval and hasn\'t started: tickets. Run "namzu mcp approve" to start it.',
	)
	expect(pendingServersMessage(['a', 'b'])).toContain('2 tool servers')
})

it('approves only the servers the screen showed in full, and wraps rather than cuts', async () => {
	const { shownToolServers, trustGrantLines } = await import('../../../tui/TrustPrompt.js')
	const tail = 'the-last-argument-that-must-be-visible'
	const entries: Record<string, unknown> = {}
	for (let at = 1; at <= 10; at++) {
		entries[`server${at}`] = { command: 'sh', args: ['-c', `echo ${'x'.repeat(80)} ${tail}`] }
	}
	const { home, cwd } = project(entries)
	const grants = readFolderGrants(cwd)

	const lines = trustGrantLines(grants, 60)
	expect(lines.join('')).toContain(tail.slice(-10))
	expect(lines.every((line) => !line.endsWith('…'))).toBe(true)
	expect(lines.some((line) => line.includes('2 more'))).toBe(true)

	approveShownMcpServers(home, cwd, shownToolServers(grants))

	expect(pendingProjectMcpServers({ cwd, env: { NAMZU_HOME: home } }).pending).toEqual([
		'server9',
		'server10',
	])
})
