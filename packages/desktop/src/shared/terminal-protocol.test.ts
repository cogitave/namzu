import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
	TERMINAL_LIMITS,
	TERMINAL_METHODS,
	TERMINAL_NOTIFICATIONS,
	checkTerminalCreate,
	readTerminalAttach,
	readTerminalCreated,
	readTerminalData,
	readTerminalExit,
	readTerminalList,
	readTerminalStatus,
} from './terminal-protocol.js'

const ID = '0b1e8a0e-5c1e-4a4b-9c3f-2f1a5d0c7e11'
const info = (over: Record<string, unknown> = {}) => ({
	id: ID,
	pid: 42,
	title: 'bash',
	cwd: '/p',
	command: '/bin/bash',
	args: [],
	cols: 80,
	rows: 24,
	status: 'running',
	createdAt: 1,
	offset: 0,
	writerHeld: false,
	...over,
})

describe('the two ends of the protocol agree', () => {
	const host = readFileSync(
		fileURLToPath(new URL('../../../cli/src/terminal/protocol.ts', import.meta.url)),
		'utf8',
	)
	const block = (name: string) =>
		host.slice(
			host.indexOf(`export const ${name}`),
			host.indexOf('} as const', host.indexOf(`export const ${name}`)),
		)

	it('use the same method and notification names', () => {
		const names = (name: string) =>
			[...block(name).matchAll(/'(namzu\/terminal\/[a-z]+)'/g)].map((m) => m[1])
		expect(names('TERMINAL_METHODS').sort()).toEqual(Object.values(TERMINAL_METHODS).sort())
		expect(names('TERMINAL_NOTIFICATIONS').sort()).toEqual(
			Object.values(TERMINAL_NOTIFICATIONS).sort(),
		)
	})

	it('use the same limits for everything the desktop sends or reads', () => {
		const limits = Object.fromEntries(
			[...block('TERMINAL_LIMITS').matchAll(/^\s*(\w+): ([\d_]+),/gm)].map((m) => [
				m[1],
				Number(m[2]?.replaceAll('_', '')),
			]),
		)
		for (const [name, value] of Object.entries(TERMINAL_LIMITS))
			expect(limits[name], name).toBe(value)
	})
})

describe('reading the host', () => {
	it('accepts a complete description and rejects drift in it', () => {
		expect(readTerminalCreated({ terminal: info() }).id).toBe(ID)
		expect(
			readTerminalCreated({ terminal: info({ status: 'exited', exitCode: 3, signal: 15 }) }),
		).toMatchObject({
			exitCode: 3,
			signal: 15,
		})
		for (const bad of [
			info({ id: 'x' }),
			info({ status: 'paused' }),
			info({ cols: 0 }),
			info({ extra: 1 }),
			info({ args: [1] }),
			info({ offset: -1 }),
			info({ writerHeld: 'no' }),
		])
			expect(() => readTerminalCreated({ terminal: bad })).toThrow()
		expect(() => readTerminalCreated({ terminals: [] })).toThrow()
	})

	it('reads a list without duplicates and within the limit', () => {
		expect(readTerminalList({ terminals: [info()] })).toHaveLength(1)
		expect(() => readTerminalList({ terminals: [info(), info()] })).toThrow(/Duplicate/)
		expect(() =>
			readTerminalList({ terminals: new Array(TERMINAL_LIMITS.maxTerminals + 1).fill(info()) }),
		).toThrow()
	})

	it('reads status', () => {
		const limits = {
			maxTerminals: 16,
			maxCols: 500,
			maxRows: 200,
			maxWrite: 65_536,
			maxChunk: 16_384,
		}
		expect(
			readTerminalStatus({ available: false, reason: 'not installed', platform: 'win32', limits }),
		).toMatchObject({
			available: false,
		})
		expect(() => readTerminalStatus({ available: 'yes', platform: 'x', limits })).toThrow()
	})

	it('holds an attachment to its offsets', () => {
		const good = {
			terminal: info(),
			mode: 'replay',
			screen: '',
			data: 'abc',
			start: 5,
			end: 8,
			writer: true,
			truncated: false,
		}
		expect(readTerminalAttach(good).end).toBe(8)
		expect(() => readTerminalAttach({ ...good, end: 9 })).toThrow(/offsets/)
		expect(() => readTerminalAttach({ ...good, screen: 'x' })).toThrow(/replay/)
		expect(readTerminalAttach({ ...good, mode: 'snapshot', screen: '\u001b[H' }).mode).toBe(
			'snapshot',
		)
		expect(() => readTerminalAttach({ ...good, mode: 'other' })).toThrow()
	})

	it('reads output and exit notifications strictly', () => {
		expect(readTerminalData({ terminalId: ID, offset: 4, data: 'x' })).toEqual({
			terminalId: ID,
			offset: 4,
			data: 'x',
		})
		expect(() => readTerminalData({ terminalId: ID, offset: 4, data: '' })).toThrow()
		expect(() =>
			readTerminalData({
				terminalId: ID,
				offset: 4,
				data: 'x'.repeat(TERMINAL_LIMITS.maxChunk + 1),
			}),
		).toThrow()
		expect(readTerminalExit({ terminalId: ID, exitCode: -1073741510 })).toEqual({
			terminalId: ID,
			exitCode: -1073741510,
		})
		expect(() => readTerminalExit({ terminalId: ID, exitCode: 0, extra: true })).toThrow()
	})
})

describe('checking what the desktop sends', () => {
	it('passes a good request through and refuses one the host would refuse', () => {
		const good = {
			cols: 80,
			rows: 24,
			command: 'cmd.exe',
			args: ['/k', 'chcp 65001'],
			env: { A: 'b', B: null },
		}
		expect(checkTerminalCreate(good)).toBe(good)
		for (const bad of [
			{ cols: 0, rows: 24 },
			{ cols: 80, rows: 24, env: { 'A=B': 'c' } },
			{ cols: 80, rows: 24, command: '' },
			{ cols: 80, rows: 24, args: new Array(TERMINAL_LIMITS.maxArgs + 1).fill('a') },
		])
			expect(() => checkTerminalCreate(bad)).toThrow()
	})
})
