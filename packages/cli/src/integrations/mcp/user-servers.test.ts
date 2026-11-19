import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { userConfigPath } from '../../config/user-config.js'
import {
	MCP_NAME_RULE,
	checkUserMcpServerSave,
	mcpAddressProblem,
	readUserMcpServerForms,
	saveUserMcpServer,
} from './user-config.js'
import { removeUserMcpServer } from './user-config.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-mcpf-'))
})
afterEach(() => removeTempDir(home))
const opts = () => ({ home, env: {} as NodeJS.ProcessEnv })
const file = () => userConfigPath(opts())
const put = (text: string) => {
	mkdirSync(dirname(file()), { recursive: true })
	writeFileSync(file(), text)
}
const doc = () => parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
const servers = () => doc().mcpServers as Record<string, Record<string, unknown>>

describe('adding a tool server from the Settings form', () => {
	it('writes a command with its arguments, and trims what was typed', () => {
		saveUserMcpServer('add', 'notes', { command: ' npx ', args: ['-y', ' notes-mcp ', ''] }, opts())
		expect(servers().notes).toEqual({ command: 'npx', args: ['-y', 'notes-mcp'] })
	})

	it('writes an address alone', () => {
		saveUserMcpServer('add', 'remote', { url: 'https://example.com/mcp' }, opts())
		expect(servers().remote).toEqual({ url: 'https://example.com/mcp' })
	})

	it('refuses a name the engine would not accept, in words', () => {
		for (const name of ['1abc', 'has space', '', 'x'.repeat(65)])
			expect(() => saveUserMcpServer('add', name, { command: 'x' }, opts())).toThrow(MCP_NAME_RULE)
	})

	it('refuses both or neither of a command and an address', () => {
		expect(() =>
			saveUserMcpServer('add', 'a', { command: 'x', url: 'https://e.com' }, opts()),
		).toThrow('Give a command or an address, not both.')
		expect(() => saveUserMcpServer('add', 'a', {}, opts())).toThrow('Give a command or an address.')
		expect(() =>
			saveUserMcpServer('add', 'a', { url: 'https://e.com', args: ['x'] }, opts()),
		).toThrow('Arguments go with a command, not an address.')
	})

	it('refuses an address the engine refuses', () => {
		expect(mcpAddressProblem('ftp://example.com')).toBe(
			'The address must start with http or https.',
		)
		expect(mcpAddressProblem('nonsense')).toContain('full web address')
		expect(mcpAddressProblem('https://user:pw@example.com')).toContain('user name')
		expect(mcpAddressProblem('http://example.com/x?token=1')).toContain('https')
		expect(mcpAddressProblem('http://localhost:3000/x?a=1')).toBeUndefined()
		expect(mcpAddressProblem('https://example.com/x?a=1')).toBeUndefined()
	})

	it('never replaces a server that exists', () => {
		saveUserMcpServer('add', 'notes', { command: 'a' }, opts())
		expect(() => saveUserMcpServer('add', 'notes', { command: 'b' }, opts())).toThrow(
			'There is already a server called notes.',
		)
		expect(servers().notes).toEqual({ command: 'a' })
	})
})

describe('editing a tool server keeps what the form does not show', () => {
	const seed = [
		'# my servers',
		'mcpServers:',
		'  notes:',
		'    command: old',
		'    args: [one, two]',
		'    env:',
		'      TOKEN: secret-value',
		'    inheritEnv: [HOME]',
		'    cwd: /work',
		'  remote:',
		'    url: https://example.com/mcp',
		'    headers:',
		'      Authorization: Bearer ${API_TOKEN}',
		'  weird: 5',
		'',
	].join('\n')
	beforeEach(() => put(seed))

	it('changes the command and arguments and leaves variables and every other field as they were', () => {
		saveUserMcpServer('edit', 'notes', { command: 'new', args: ['x'] }, opts())
		expect(servers().notes).toEqual({
			command: 'new',
			args: ['x'],
			env: { TOKEN: 'secret-value' },
			inheritEnv: ['HOME'],
			cwd: '/work',
		})
		expect(servers().remote).toEqual({
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer ${API_TOKEN}' },
		})
		expect(readFileSync(file(), 'utf8')).toContain('# my servers')
	})

	it('drops the arguments when none are given', () => {
		saveUserMcpServer('edit', 'notes', { command: 'new' }, opts())
		expect(servers().notes?.args).toBeUndefined()
		expect(servers().notes?.env).toEqual({ TOKEN: 'secret-value' })
	})

	it('changes an address and keeps the headers', () => {
		saveUserMcpServer('edit', 'remote', { url: 'https://other.example.com/mcp' }, opts())
		expect(servers().remote).toEqual({
			url: 'https://other.example.com/mcp',
			headers: { Authorization: 'Bearer ${API_TOKEN}' },
		})
	})

	it('moves between a command and an address by replacing only the two kinds', () => {
		saveUserMcpServer('edit', 'notes', { url: 'https://example.com/n' }, opts())
		expect(servers().notes).toEqual({
			url: 'https://example.com/n',
			env: { TOKEN: 'secret-value' },
			inheritEnv: ['HOME'],
			cwd: '/work',
		})
		saveUserMcpServer('edit', 'remote', { command: 'run' }, opts())
		expect(servers().remote).toEqual({
			command: 'run',
			headers: { Authorization: 'Bearer ${API_TOKEN}' },
		})
	})

	it('refuses to edit what does not exist or cannot be read as a server', () => {
		expect(() => saveUserMcpServer('edit', 'gone', { command: 'x' }, opts())).toThrow(
			'There is no server called gone here.',
		)
		expect(() => saveUserMcpServer('edit', 'weird', { command: 'x' }, opts())).toThrow(
			'Edit this server in the config file.',
		)
	})

	it('checks a save without writing it', () => {
		const before = readFileSync(file(), 'utf8')
		expect(checkUserMcpServerSave('edit', 'notes', { command: 'z' }, opts())).toEqual({
			command: 'z',
		})
		expect(() => checkUserMcpServerSave('edit', 'notes', {}, opts())).toThrow()
		expect(readFileSync(file(), 'utf8')).toBe(before)
	})

	it('removes a server and the block when it was the last one', () => {
		removeUserMcpServer('notes', opts())
		removeUserMcpServer('remote', opts())
		removeUserMcpServer('weird', opts())
		expect(doc().mcpServers).toBeUndefined()
	})
})

describe('reading the user file for the form', () => {
	it('gives the command, arguments and address, and never a variable or a header', () => {
		put(
			[
				'mcpServers:',
				'  notes: { command: run, args: [a], env: { K: v } }',
				'  remote: { url: "https://example.com/mcp", headers: { A: b } }',
				'  both: { command: x, url: "https://e.com" }',
				'  odd: 3',
				'',
			].join('\n'),
		)
		const forms = readUserMcpServerForms(opts())
		expect(forms).toEqual([
			{ name: 'notes', kind: 'command', command: 'run', args: ['a'] },
			{ name: 'remote', kind: 'address', url: 'https://example.com/mcp' },
			{ name: 'both', kind: 'other' },
			{ name: 'odd', kind: 'other' },
		])
		expect(JSON.stringify(forms)).not.toMatch(/"K"|"A"|"v"|headers|env/)
	})

	it('is empty with no file', () => {
		expect(readUserMcpServerForms(opts())).toEqual([])
	})
})
