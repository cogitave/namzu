import { describe, expect, it } from 'vitest'
import { readTerminalAttachOptions, readTerminalOpenRequest } from './terminal-view.js'

const base = { projectId: 'p1', groupId: 'g1', cols: 100, rows: 30 }

describe('readTerminalOpenRequest', () => {
	it('reads a shell request and an engine request', () => {
		expect(readTerminalOpenRequest({ ...base, kind: 'shell' })).toEqual({ ...base, kind: 'shell' })
		expect(
			readTerminalOpenRequest({
				...base,
				kind: 'engine',
				engine: 'codex-cli',
				provider: 'codex-cli',
				model: 'gpt-5',
				effort: 'high',
				permissionMode: 'accept-edits',
			}),
		).toEqual({
			...base,
			kind: 'engine',
			engine: 'codex-cli',
			provider: 'codex-cli',
			model: 'gpt-5',
			effort: 'high',
			permissionMode: 'accept-edits',
		})
	})

	it('reads the composer message of an engine request and refuses a bad one', () => {
		const engine = { ...base, kind: 'engine', engine: 'claude-code', permissionMode: 'plan' }
		expect(readTerminalOpenRequest({ ...engine, prompt: 'fix it' })).toMatchObject({
			prompt: 'fix it',
		})
		expect(readTerminalOpenRequest({ ...engine, prompt: '   ' })).not.toHaveProperty('prompt')
		for (const prompt of [7, 'a\0b', 'x'.repeat(8001)])
			expect(() => readTerminalOpenRequest({ ...engine, prompt })).toThrow(/prompt/)
		expect(() => readTerminalOpenRequest({ ...base, kind: 'shell', prompt: 'x' })).toThrow(
			/Unexpected/,
		)
	})

	it('refuses a provider or model that is an option or holds a control character', () => {
		const engine = { ...base, kind: 'engine', engine: 'codex-cli', permissionMode: 'plan' }
		for (const bad of ['--config', '-x', 'a\nb', 'a\rb', 'a\u001bb', 'a\u0085b'])
			for (const field of ['provider', 'model'])
				expect(() => readTerminalOpenRequest({ ...engine, [field]: bad })).toThrow(field)
		expect(readTerminalOpenRequest({ ...engine, model: 'gpt-5.1-codex' })).toMatchObject({
			model: 'gpt-5.1-codex',
		})
	})

	it('drops nothing silently: unknown fields, engines, modes and efforts are refused', () => {
		for (const bad of [
			undefined,
			null,
			[],
			'shell',
			{ ...base },
			{ ...base, kind: 'other' },
			{ ...base, kind: 'shell', command: 'rm' },
			{ ...base, kind: 'shell', env: {} },
			{ ...base, kind: 'engine', engine: 'bash', permissionMode: 'plan' },
			{ ...base, kind: 'engine', engine: 'namzu', permissionMode: 'root' },
			{ ...base, kind: 'engine', engine: 'namzu', permissionMode: 'plan', effort: 'huge' },
			{ ...base, kind: 'engine', engine: 'namzu', permissionMode: 'plan', model: '' },
			{ ...base, kind: 'engine', engine: 'namzu', permissionMode: 'plan', args: [] },
			{ ...base, projectId: '', kind: 'shell' },
			{ ...base, groupId: 7, kind: 'shell' },
		])
			expect(() => readTerminalOpenRequest(bad)).toThrow()
	})
})

describe('readTerminalAttachOptions', () => {
	it('reads the three options and nothing else', () => {
		expect(readTerminalAttachOptions(undefined)).toEqual({})
		expect(readTerminalAttachOptions({ fromOffset: 4, writer: true, force: true })).toEqual({
			fromOffset: 4,
			writer: true,
			force: true,
		})
		expect(readTerminalAttachOptions({ writer: false })).toEqual({})
		for (const bad of [null, [], { fromOffset: -1 }, { fromOffset: 1.5 }, { writer: 1 }, { x: 1 }])
			expect(() => readTerminalAttachOptions(bad)).toThrow()
	})
})
