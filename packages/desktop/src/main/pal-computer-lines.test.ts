import { describe, expect, it } from 'vitest'
import { ComputerLineParser, parseComputerLine } from './pal-computer-lines.js'

const plan = {
	id: 'p1',
	state: 'wsl-missing',
	steps: [
		{
			kind: 'download-wsl',
			elevated: false,
			downloadBytes: 10,
			estimatedSeconds: 5,
			mayRequireRestart: false,
		},
	],
	elevationPrompts: 0,
	mayRequireRestart: false,
}
const status = JSON.stringify({ version: 1, readiness: { state: 'wsl-missing' }, plan })

describe('parseComputerLine', () => {
	it('reads the four kinds of line', () => {
		expect(parseComputerLine(status)).toMatchObject({
			kind: 'status',
			readiness: { state: 'wsl-missing' },
			plan: { id: 'p1', steps: [{ kind: 'download-wsl', downloadBytes: 10 }] },
		})
		expect(
			parseComputerLine(
				'{"version":1,"progress":{"step":"download-wsl","phase":"progress","done":5,"total":10,"unit":"bytes"}}',
			),
		).toEqual({
			kind: 'progress',
			progress: { step: 'download-wsl', phase: 'progress', done: 5, total: 10, unit: 'bytes' },
		})
		expect(parseComputerLine('{"version":1,"result":{"outcome":"restart-required"}}')).toEqual({
			kind: 'result',
			result: { outcome: 'restart-required' },
		})
		expect(parseComputerLine('{"version":1,"outcome":"busy"}')).toEqual({
			kind: 'stop-idle',
			outcome: 'busy',
		})
		expect(parseComputerLine('{"version":1,"error":{"code":"check-failed"}}')).toEqual({
			kind: 'error',
			code: 'check-failed',
		})
	})

	it('skips garbage, other versions and shapes it does not know', () => {
		for (const text of [
			'',
			'WARN something',
			'{not json',
			'[1,2]',
			'{"version":2,"outcome":"busy"}',
			'{"outcome":"busy"}',
			'{"version":1}',
			'{"version":1,"progress":{"phase":"started"}}',
			'{"version":1,"result":{"outcome":"exploded"}}',
			'{"version":1,"result":{"outcome":"failed","step":"load-image"}}',
			'{"version":1,"readiness":{"state":"ready"},"plan":{"id":1}}',
		])
			expect(parseComputerLine(text)).toBeUndefined()
	})

	it('ignores fields it does not know', () => {
		expect(
			parseComputerLine(
				'{"version":1,"later":true,"result":{"outcome":"blocked","blocked":"virtualization-off","extra":1}}',
			),
		).toEqual({ kind: 'result', result: { outcome: 'blocked', blocked: 'virtualization-off' } })
		const read = parseComputerLine(
			JSON.stringify({
				version: 1,
				readiness: { state: 'ready', surprise: 1 },
				plan: { ...plan, steps: [], extra: 1 },
			}),
		)
		expect(read).toMatchObject({ kind: 'status', plan: { steps: [] } })
	})
})

describe('ComputerLineParser', () => {
	it('waits for whole lines across chunks', () => {
		const parser = new ComputerLineParser()
		const whole = `${status}\n{"version":1,"outcome":"stopped"}\n`
		const seen = []
		for (let i = 0; i < whole.length; i += 7) seen.push(...parser.push(whole.slice(i, i + 7)))
		expect(seen.map((line) => line.kind)).toEqual(['status', 'stop-idle'])
	})

	it('drops noise between lines and reads a last line without a newline', () => {
		const parser = new ComputerLineParser()
		expect(parser.push('banner\r\n{"version":1,"outcome":"stopped"}\r\nhalf')).toEqual([
			{ kind: 'stop-idle', outcome: 'stopped' },
		])
		expect(parser.end()).toEqual([])
		expect(parser.push('{"version":1,"outcome":"busy"}')).toEqual([])
		expect(parser.end()).toEqual([{ kind: 'stop-idle', outcome: 'busy' }])
	})
})
