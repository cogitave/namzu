import { describe, expect, it } from 'vitest'
import {
	TERMINAL_LIMITS,
	TERMINAL_METHODS,
	readAck,
	readAttach,
	readCreate,
	readDetach,
	readResize,
	readTerminalOnly,
	readWrite,
} from '../protocol.js'

const ID = '0b1e8a0e-5c1e-4a4b-9c3f-2f1a5d0c7e11'

describe('method names', () => {
	it('are namespaced extensions the protocol server accepts', () => {
		for (const name of Object.values(TERMINAL_METHODS))
			expect(name).toMatch(/^namzu\/[a-z][a-z0-9_/-]*$/)
	})
})

describe('create', () => {
	it('reads a complete request', () => {
		const read = readCreate({
			cwd: '/p',
			command: 'pwsh.exe',
			args: ['-NoLogo'],
			env: { A: 'b', GONE: null },
			cols: 120,
			rows: 30,
			title: 'Shell',
		})
		expect(read).toMatchObject({
			cwd: '/p',
			command: 'pwsh.exe',
			args: ['-NoLogo'],
			cols: 120,
			rows: 30,
			title: 'Shell',
		})
		expect({ ...read.env }).toEqual({ A: 'b', GONE: null })
	})

	it('needs only a size', () => {
		expect(readCreate({ cols: 80, rows: 24 })).toMatchObject({ args: [], cols: 80, rows: 24 })
	})

	it.each([
		['a string', 'x'],
		['an array', []],
		['an unknown field', { cols: 80, rows: 24, shell: 'sh' }],
		['no size', { command: 'sh' }],
		['zero columns', { cols: 0, rows: 24 }],
		['too many columns', { cols: TERMINAL_LIMITS.maxCols + 1, rows: 24 }],
		['a fractional row count', { cols: 80, rows: 2.5 }],
		['an empty command', { cols: 80, rows: 24, command: '' }],
		['a command with NUL', { cols: 80, rows: 24, command: 'a\0b' }],
		['an argument that is not text', { cols: 80, rows: 24, args: [1] }],
		[
			'too many arguments',
			{ cols: 80, rows: 24, args: new Array(TERMINAL_LIMITS.maxArgs + 1).fill('a') },
		],
		['an environment name with =', { cols: 80, rows: 24, env: { 'A=B': 'c' } }],
		['a numeric environment value', { cols: 80, rows: 24, env: { A: 1 } }],
		[
			'a title that is too long',
			{ cols: 80, rows: 24, title: 'x'.repeat(TERMINAL_LIMITS.maxTitle + 1) },
		],
	])('refuses %s', (_name, value) => {
		expect(() => readCreate(value)).toThrow()
	})

	it('keeps a variable named __proto__ as data', () => {
		const read = readCreate({ cols: 1, rows: 1, env: JSON.parse('{"__proto__":"x"}') })
		expect(Object.getPrototypeOf(read.env)).toBeNull()
		expect(read.env.__proto__).toBe('x')
	})
})

describe('the other requests', () => {
	it('read a terminal id strictly', () => {
		expect(readTerminalOnly({ terminalId: ID }, 'terminal kill')).toBe(ID)
		expect(() => readTerminalOnly({ terminalId: 'nope' }, 'terminal kill')).toThrow(/terminalId/)
		expect(() => readTerminalOnly({ terminalId: ID, extra: 1 }, 'terminal kill')).toThrow(
			/Unexpected/,
		)
	})

	it('attach reads the offset and the keyboard flags', () => {
		expect(readAttach({ terminalId: ID, viewerId: 'win:1', fromOffset: 12, writer: true })).toEqual(
			{
				terminalId: ID,
				viewerId: 'win:1',
				fromOffset: 12,
				writer: true,
				force: false,
			},
		)
		expect(() => readAttach({ terminalId: ID, viewerId: 'a b' })).toThrow(/viewerId/)
		expect(() => readAttach({ terminalId: ID, viewerId: 'a', fromOffset: -1 })).toThrow()
		expect(() => readAttach({ terminalId: ID, viewerId: 'a', writer: 'yes' })).toThrow(/writer/)
	})

	it('detach, write, resize and ack are closed shapes', () => {
		expect(readDetach({ terminalId: ID, viewerId: 'a' })).toEqual({ terminalId: ID, viewerId: 'a' })
		expect(readWrite({ terminalId: ID, viewerId: 'a', data: '\0' }).data).toBe('\0')
		expect(() => readWrite({ terminalId: ID, viewerId: 'a', data: '' })).toThrow()
		expect(() =>
			readWrite({ terminalId: ID, viewerId: 'a', data: 'x'.repeat(TERMINAL_LIMITS.maxWrite + 1) }),
		).toThrow()
		expect(readResize({ terminalId: ID, viewerId: 'a', cols: 90, rows: 20 })).toMatchObject({
			cols: 90,
			rows: 20,
		})
		expect(() => readResize({ terminalId: ID, viewerId: 'a', cols: 90 })).toThrow()
		expect(readAck({ terminalId: ID, offset: 5 })).toEqual({ terminalId: ID, offset: 5 })
		expect(() => readAck({ terminalId: ID, offset: 1.5 })).toThrow()
	})
})
