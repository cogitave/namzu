import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { atomicWriteFile } from '../atomic-write-file.js'
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
	it('publishes one closed contract covering both operations', () => {
		const schema = EditTool.modelInputSchema
		expect(schema).toEqual({
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path to the file to edit. Must not be empty.',
				},
				old_string: {
					type: 'string',
					description:
						'Exact unique text from the file, without read-tool line-number prefixes. Must not be empty.',
				},
				new_string: {
					type: 'string',
					description:
						'Exact replacement text. May be empty to delete old_string. Keep under 12000 characters.',
				},
				insertLine: {
					anyOf: [{ type: 'integer' }, { const: 'end' }],
					description:
						'Insert instead of replacing. The new_string goes after this 1-indexed line; 0 inserts before the first line; "end" appends. Omit for a find-and-replace.',
				},
				replace_all: {
					type: 'boolean',
					description: 'Replace every occurrence instead of requiring one unique match.',
				},
				edits: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							old_string: {
								type: 'string',
								description: 'Exact text from the file at this point in the sequence.',
							},
							new_string: { type: 'string', description: 'Exact replacement text.' },
							replace_all: {
								type: 'boolean',
								description: 'Replace every occurrence of this old_string.',
							},
						},
						required: ['old_string', 'new_string'],
						additionalProperties: false,
					},
					description:
						'Several replacements in one file, applied in order and committed together. Nothing is written unless every one applies. Use this instead of several edit calls when the changes only make sense together.',
				},
			},
			// `old_string` left out on purpose: an insert has no text to match,
			// and requiring it is what made the append idiom the tool's own
			// description recommends unexpressible under constrained decoding.
			// `new_string` left for the same reason one shape later — a batch
			// carries its replacements inside `edits` and has none at the top
			// level. Which fields a given shape needs is decided by the
			// refinements on the execution schema, which name what is missing.
			required: ['path'],
			additionalProperties: false,
		})

		expect(
			EditTool.inputSchema.safeParse({
				path: 'doc.md',
				old_string: 'old',
				new_string: 'new',
				replace_all: true,
			}).success,
		).toBe(true)

		// The MODEL schema above is the closed canonical one. The HOST schema
		// is wider on purpose — aliases and line insertion are declared — and
		// the point of `.strict()` is that wider still is not open.
		for (const supported of [
			{ path: 'doc.md', oldStr: 'old', newStr: 'new' },
			{ path: 'doc.md', insertLine: 'end', new_string: 'append' },
			{ path: 'doc.md', old_string: 'old', new_string: 'new', newStr: 'legacy' },
		]) {
			expect(EditTool.inputSchema.safeParse(supported).success, JSON.stringify(supported)).toBe(
				true,
			)
		}

		for (const unknown of [
			{ path: 'doc.md', old_str: 'old', new_string: 'new' },
			{ path: 'doc.md', old_string: 'old', new_string: 'new', replaceAll: true },
		]) {
			expect(EditTool.inputSchema.safeParse(unknown).success, JSON.stringify(unknown)).toBe(false)
		}
		expect(
			EditTool.inputSchema.safeParse({
				path: '   ',
				old_string: 'old',
				new_string: 'new',
			}).success,
		).toBe(false)
	})

	it('replaces one exact unique string', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{
				path: 'doc.md',
				old_string: 'beta',
				new_string: 'gamma',
				replace_all: false,
			},
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\ngamma\n')
	})

	it('validates a path without rewriting edge whitespace', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, ' doc.md '), 'alpha\n')

		const result = await EditTool.execute(
			{
				path: ' doc.md ',
				old_string: 'alpha',
				new_string: 'beta',
				replace_all: false,
			},
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, ' doc.md '), 'utf-8')).toBe('beta\n')
		expect(existsSync(join(dir, 'doc.md'))).toBe(false)
	})

	it('allows deletion with an empty new_string', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nremove me\nomega\n')

		const result = await EditTool.execute(
			{
				path: 'doc.md',
				old_string: 'remove me\n',
				new_string: '',
				replace_all: false,
			},
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\nomega\n')
	})

	it('replaces every exact occurrence only when replace_all is true', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha alpha alpha')

		const result = await EditTool.execute(
			{
				path: 'doc.md',
				old_string: 'alpha',
				new_string: 'beta',
				replace_all: true,
			},
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(result.data).toMatchObject({ replacements: 3 })
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('beta beta beta')
	})

	it('refuses ambiguous exact matches instead of guessing', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nalpha\n')

		const result = await EditTool.execute(
			{
				path: 'doc.md',
				old_string: 'alpha',
				new_string: 'beta',
				replace_all: false,
			},
			makeContext(dir),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('is not unique')
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\nalpha\n')
	})

	it('normalizes consistent CRLF/LF boundaries without fuzzy matching', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\r\nbeta\r\nomega\r\n')

		const result = await EditTool.execute(
			{
				path: 'doc.md',
				old_string: 'alpha\nbeta',
				new_string: 'gamma\ndelta',
				replace_all: false,
			},
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('gamma\r\ndelta\r\nomega\r\n')
	})

	it('rejects a field it does not accept, even when execute is called directly', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\n')

		// Without `.strict()` zod STRIPS an unrecognised key, so each of these
		// would run as if the caller had never written it — a misspelling
		// becomes a silent no-op rather than an error anyone can act on.
		for (const input of [
			{ path: 'doc.md', old_str: 'alpha', new_string: 'beta' },
			{ path: 'doc.md', old_string: 'alpha', new_string: 'beta', overwrite: true },
			{ path: 'doc.md', old_string: 'alpha', new_string: 'beta', replaceAll: true },
		]) {
			const result = await EditTool.execute(input as never, makeContext(dir))
			expect(result.success, JSON.stringify(input)).toBe(false)
			expect(result.error).toContain('Invalid edit input')
		}

		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\n')
	})

	it('accepts the host aliases the schema does declare', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\n')

		// The contract is closed, not narrow. `oldStr`/`newStr` and
		// `insertLine` are in the schema for hosts that speak those names, so
		// strictness must reject the unknown without rejecting these.
		const result = await EditTool.execute(
			{ path: 'doc.md', oldStr: 'alpha', newStr: 'beta' } as never,
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('beta\n')
	})

	it('returns one canonical recovery shape after registry validation fails', async () => {
		const registry = new ToolRegistry()
		registry.register(EditTool)

		const result = await registry.execute(
			'edit',
			{ insertLine: '"end"', newStr: 'content' },
			makeContext('/tmp'),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('Validation failed for "edit":')
		expect(result.error).toContain('Required: path: string')
		expect(result.error).toContain(
			'{"path":"file.md","old_string":"exact unique text","new_string":"replacement text"}',
		)
		expect(result.error).not.toContain('Accepted shapes')
	})

	it('serializes independent EditTool read-modify-write cycles for one sandbox path', async () => {
		let body = Buffer.from('alpha')
		let reads = 0
		let writes = 0
		let releaseFirstWrite = () => {}
		let markFirstWriteStarted = () => {}
		const firstWriteStarted = new Promise<void>((resolve) => {
			markFirstWriteStarted = resolve
		})
		const firstWriteGate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve
		})
		const sandbox = {
			id: fixtureId.sandbox('edit_lock'),
			status: 'ready',
			rootDir: '/workspace',
			environment: 'basic',
			async readFile() {
				reads += 1
				return Buffer.from(body)
			},
			async writeFile(_path: string, content: string | Buffer) {
				writes += 1
				if (writes === 1) {
					markFirstWriteStarted()
					await firstWriteGate
				}
				body = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content)
			},
			async exec() {
				throw new Error('not used')
			},
			async listFiles() {
				return []
			},
			async destroy() {},
		} as Sandbox
		const firstContext = { ...makeContext('/workspace'), sandbox }
		const secondContext = { ...makeContext('/workspace'), sandbox }

		const first = EditTool.execute(
			{
				path: 'doc.md',
				old_string: 'alpha',
				new_string: 'beta',
				replace_all: false,
			},
			firstContext,
		)
		await firstWriteStarted
		const second = EditTool.execute(
			{
				path: 'doc.md',
				old_string: 'beta',
				new_string: 'gamma',
				replace_all: false,
			},
			secondContext,
		)
		await Promise.resolve()
		expect(reads).toBe(1)

		releaseFirstWrite()
		const results = await Promise.all([first, second])
		expect(results.every((result) => result.success)).toBe(true)
		expect(reads).toBe(2)
		expect(writes).toBe(2)
		expect(body.toString('utf-8')).toBe('gamma')
	})

	it('leaves the original intact when an atomic local write fails before commit', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-atomic-write-'))
		const filePath = join(dir, 'doc.md')
		writeFileSync(filePath, 'original')

		await expect(
			atomicWriteFile(filePath, 'replacement', {
				beforeCommit: async () => {
					throw new Error('injected pre-commit failure')
				},
			}),
		).rejects.toThrow('injected pre-commit failure')

		expect(readFileSync(filePath, 'utf-8')).toBe('original')
		expect(readdirSync(dir).filter((entry) => entry.includes('.namzu-'))).toEqual([])
	})

	// ── the alias + insertion surface this build adds on top ──────────

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
})
