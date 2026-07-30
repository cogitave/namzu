import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { EditTool } from '../edit.js'

function makeContext(workingDirectory: string): ToolContext {
	return {
		runId: 'run_test' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('EditTool', () => {
	it('accepts oldStr/newStr aliases for string replacement', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', oldStr: 'beta', newStr: 'gamma', replace_all: false },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\ngamma\n')
	})

	it('inserts content after a 1-indexed line number', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', insertLine: 1, newStr: 'inserted', replace_all: false },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\ninserted\nbeta\n')
	})

	it('inserts content at the end with insertLine=end', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', insertLine: 'end', newStr: 'omega', replace_all: false },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\nomega\n')
	})

	it('publishes only the insertLine values the executor can apply', () => {
		for (const insertLine of ['## Progress', null, '', '1', -1]) {
			const parsed = EditTool.inputSchema.safeParse({
				path: 'doc.md',
				insertLine,
				newStr: 'inserted',
			})
			expect(parsed.success, JSON.stringify(insertLine)).toBe(false)
		}

		for (const insertLine of [0, 1, 'end']) {
			const parsed = EditTool.inputSchema.safeParse({
				path: 'doc.md',
				insertLine,
				newStr: 'inserted',
			})
			expect(parsed.success, JSON.stringify(insertLine)).toBe(true)
		}

		const json = zodToJsonSchema(EditTool.inputSchema, {
			target: 'jsonSchema7',
			$refStrategy: 'none',
		}) as {
			properties?: {
				insertLine?: {
					anyOf?: Record<string, unknown>[]
				}
			}
		}
		expect(json.properties?.insertLine?.anyOf).toEqual([
			{ type: 'integer', minimum: 0 },
			{ type: 'string', const: 'end' },
		])
	})

	it('refuses invalid insertLine values even when a caller bypasses the schema', async () => {
		for (const insertLine of ['## Progress', null, '', '1']) {
			const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
			writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

			const result = await EditTool.execute(
				{
					path: 'doc.md',
					insertLine,
					newStr: 'inserted',
					replace_all: false,
				} as never,
				makeContext(dir),
			)

			expect(result.success, JSON.stringify(insertLine)).toBe(false)
			expect(result.error).toBe('insertLine must be a non-negative line number or "end".')
			expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\nbeta\n')
		}
	})

	it('returns complete recovery shapes when path is missing and insertLine is invalid', async () => {
		const registry = new ToolRegistry()
		registry.register(EditTool)

		const result = await registry.execute(
			'edit',
			{ insertLine: '## Progress' },
			makeContext('/tmp'),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('Validation failed for "edit":')
		expect(result.error).toContain('insertLine: Invalid input')
		expect(result.error).toContain('Required: path: string — Path to the file to edit.')
		expect(result.error).toContain('{"path":"file.md","insertLine":"end","new_string":"text"}')
		expect(result.error).toContain('{"path":"file.md","old_string":"old","new_string":"new"}')
	})
})
