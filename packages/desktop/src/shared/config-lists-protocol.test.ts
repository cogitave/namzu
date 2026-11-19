import { describe, expect, it } from 'vitest'
import {
	commandConfirmation,
	commandLine,
	readInstalledSkills,
	readUserMcpServerChange,
	readUserMcpServersView,
	startsNewCommand,
} from './config-lists-protocol.js'

describe('reading the installed skills', () => {
	it('keeps the name and where it lives, once per name, and nothing else', () => {
		expect(
			readInstalledSkills({
				skills: [
					{ name: 'a', where: 'built-in', path: '/secret', description: 'x' },
					{ name: 'a', where: 'built-in' },
					{ name: '', where: 'x' },
					{ name: 'b' },
					'x',
				],
			}),
		).toEqual({ skills: [{ name: 'a', where: 'built-in' }] })
		expect(readInstalledSkills(undefined)).toEqual({ skills: [] })
		expect(readInstalledSkills({ skills: 'a' })).toEqual({ skills: [] })
	})
})

describe('reading the user’s tool servers', () => {
	it('keeps what the form edits and drops variables, headers and anything else', () => {
		const view = readUserMcpServersView({
			file: '/h/config.yaml',
			servers: [
				{ name: 'n', kind: 'command', command: 'run', args: ['a'], env: { K: 'v' } },
				{ name: 'r', kind: 'address', url: 'https://e.com/mcp', headers: { A: 'b' } },
				{ name: 'o', kind: 'other', command: 'x' },
				{ name: '', kind: 'command' },
				{ kind: 'command' },
			],
		})
		expect(view).toEqual({
			file: '/h/config.yaml',
			servers: [
				{ name: 'n', kind: 'command', command: 'run', args: ['a'] },
				{ name: 'r', kind: 'address', url: 'https://e.com/mcp' },
				{ name: 'o', kind: 'other' },
			],
		})
		expect(JSON.stringify(view)).not.toMatch(/"K"|headers|"env"/)
	})
})

describe('reading a change from the window', () => {
	it('takes a command with arguments or an address, and refuses any other shape', () => {
		expect(
			readUserMcpServerChange({ mode: 'add', name: 'n', command: 'run', args: ['a'] }),
		).toEqual({ mode: 'add', name: 'n', command: 'run', args: ['a'] })
		expect(readUserMcpServerChange({ mode: 'edit', name: 'n', url: 'https://e.com' })).toEqual({
			mode: 'edit',
			name: 'n',
			url: 'https://e.com',
		})
		// Variables and headers can never be sent through here.
		expect(
			readUserMcpServerChange({ mode: 'add', name: 'n', command: 'x', env: { A: 'b' } }),
		).toEqual({ mode: 'add', name: 'n', command: 'x' })
		for (const bad of [
			null,
			'x',
			{ mode: 'replace', name: 'n' },
			{ mode: 'add' },
			{ mode: 'add', name: 'n', command: 3 },
			{ mode: 'add', name: 'n', args: [1] },
			{ mode: 'add', name: 'n', args: Array(201).fill('a') },
			{ mode: 'add', name: 'n'.repeat(65) },
		])
			expect(() => readUserMcpServerChange(bad)).toThrow()
	})
})

describe('the question before a command is saved', () => {
	it('names the whole command line on one line, clipped', () => {
		expect(commandLine({ command: 'npx', args: ['-y', ' pkg ', ''] })).toBe('npx -y pkg')
		expect(commandLine({ command: 'a\nb' })).toBe('a b')
		expect(commandLine({ command: 'x'.repeat(300) }).length).toBe(300)
		expect(() =>
			readUserMcpServerChange({ mode: 'add', name: 'a', command: 'npx', args: ['y'.repeat(1200)] }),
		).toThrow(/longer than/)
		expect(commandConfirmation({ command: 'npx', args: ['-y'] })).toBe(
			'This server starts npx -y when a conversation starts.',
		)
	})

	it('asks for a new command or a changed one, never for an address or no change', () => {
		const held = { name: 'n', kind: 'command' as const, command: 'run', args: ['a'] }
		expect(startsNewCommand({ mode: 'add', name: 'n', command: 'run' }, undefined)).toBe(true)
		expect(startsNewCommand({ mode: 'edit', name: 'n', command: 'run', args: ['a'] }, held)).toBe(
			false,
		)
		expect(
			startsNewCommand({ mode: 'edit', name: 'n', command: 'run', args: [' a ', ''] }, held),
		).toBe(false)
		expect(startsNewCommand({ mode: 'edit', name: 'n', command: 'run' }, held)).toBe(true)
		expect(startsNewCommand({ mode: 'edit', name: 'n', command: 'other', args: ['a'] }, held)).toBe(
			true,
		)
		expect(startsNewCommand({ mode: 'add', name: 'n', url: 'https://e.com' }, undefined)).toBe(
			false,
		)
		expect(
			startsNewCommand(
				{ mode: 'edit', name: 'r', command: 'run' },
				{ name: 'r', kind: 'address', url: 'https://e.com' },
			),
		).toBe(true)
		expect(startsNewCommand({ mode: 'add', name: 'n', command: '  ' }, undefined)).toBe(false)
	})
})

describe('the server list carries no arguments or address path', () => {
	it('reads only the argument count and the origin the host sent', () => {
		const view = readUserMcpServersView({
			file: '/h/c.yaml',
			servers: [
				{ name: 'a', kind: 'command', command: 'npx', argCount: 2 },
				{ name: 'b', kind: 'address', origin: 'https://e.com' },
			],
		})
		expect(view.servers).toEqual([
			{ name: 'a', kind: 'command', command: 'npx', argCount: 2 },
			{ name: 'b', kind: 'address', origin: 'https://e.com' },
		])
	})
})
