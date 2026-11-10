import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { EditTool, dryRunEdit } from '../edit.js'
import { notebookRefusal } from '../notebook-guard.js'
import { WriteFileTool } from '../write-file.js'

function ctx(workingDirectory: string): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

const notebook = `${JSON.stringify(
	{
		cells: [
			{ cell_type: 'code', source: ['print("old")\\n'], outputs: [], metadata: {} },
			{ cell_type: 'markdown', source: 'hello', metadata: {} },
		],
		metadata: {},
		nbformat: 4,
		nbformat_minor: 5,
	},
	null,
	1,
)}\n`

function scratch(name: string, body: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), 'nb-guard-'))
	const path = join(dir, name)
	writeFileSync(path, body)
	return { dir, path }
}

describe('notebook-safe edits', () => {
	it('lets an edit inside a cell source through', async () => {
		const { dir, path } = scratch('a.ipynb', notebook)
		const result = await EditTool.execute(
			{ path, old_string: 'print(\\"old\\")', new_string: 'print(\\"new\\")' },
			ctx(dir),
		)
		expect(result.success).toBe(true)
		expect(readFileSync(path, 'utf-8')).toContain('print(\\"new\\")')
	})

	it('refuses an edit that breaks the JSON and leaves the file alone', async () => {
		const { dir, path } = scratch('a.ipynb', notebook)
		const result = await EditTool.execute(
			{ path, old_string: '"nbformat_minor": 5', new_string: '"nbformat_minor": ' },
			ctx(dir),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('no longer open')
		expect(result.error).toContain('The file is unchanged')
		expect(readFileSync(path, 'utf-8')).toBe(notebook)
	})

	it('refuses a batch where a later edit breaks the notebook, writing nothing', async () => {
		const { dir, path } = scratch('a.ipynb', notebook)
		const result = await EditTool.execute(
			{
				path,
				edits: [
					{ old_string: 'print(\\"old\\")', new_string: 'print(\\"new\\")' },
					{ old_string: '"cells"', new_string: '"cellz"' },
				],
			},
			ctx(dir),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('"cells" list')
		expect(readFileSync(path, 'utf-8')).toBe(notebook)
	})

	it('refuses a Write of non-notebook JSON to an .ipynb', async () => {
		const { dir, path } = scratch('b.ipynb', notebook)
		const result = await WriteFileTool.execute({ path, content: '{"a": 1}' }, ctx(dir))
		expect(result.success).toBe(false)
		expect(result.error).toContain('no longer open')
		expect(readFileSync(path, 'utf-8')).toBe(notebook)
	})

	it('refuses a Write of text that is not JSON, creating nothing', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'nb-guard-'))
		const path = join(dir, 'new.ipynb')
		const result = await WriteFileTool.execute({ path, content: 'not json' }, ctx(dir))
		expect(result.success).toBe(false)
		expect(() => readFileSync(path)).toThrow()
	})

	it('accepts a Write of a valid notebook', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'nb-guard-'))
		const path = join(dir, 'new.ipynb')
		const result = await WriteFileTool.execute({ path, content: notebook }, ctx(dir))
		expect(result.success).toBe(true)
		expect(readFileSync(path, 'utf-8')).toBe(notebook)
	})

	it('matches the extension in any letter case', async () => {
		const { dir, path } = scratch('C.IPYNB', notebook)
		const result = await WriteFileTool.execute({ path, content: '[]' }, ctx(dir))
		expect(result.success).toBe(false)
		expect(readFileSync(path, 'utf-8')).toBe(notebook)
	})

	it('leaves other files alone', async () => {
		const { dir, path } = scratch('a.json', '{"a": 1}')
		const result = await WriteFileTool.execute({ path, content: 'not json at all' }, ctx(dir))
		expect(result.success).toBe(true)
		expect(readFileSync(path, 'utf-8')).toBe('not json at all')
	})

	it('names the cell and field of a bad cell', () => {
		const bad = JSON.stringify({
			cells: [{ cell_type: 'code', source: 3 }],
			metadata: {},
			nbformat: 4,
		})
		expect(notebookRefusal('x.ipynb', bad)).toContain('cell 0 needs a "source"')
		const badType = JSON.stringify({
			cells: [{ cell_type: 'sheet', source: '' }],
			metadata: {},
			nbformat: 4,
		})
		expect(notebookRefusal('x.ipynb', badType)).toContain('cell_type')
		expect(notebookRefusal('x.ipynb', '[]')).toContain('JSON object')
		expect(notebookRefusal('x.txt', '[]')).toBeUndefined()
	})

	it('shows the same refusal in a dry run', () => {
		const result = dryRunEdit(notebook, {
			path: 'a.ipynb',
			old_string: ' "nbformat": 4,',
			new_string: '',
		})
		expect(result.success).toBe(false)
		if (!result.success) expect(result.error).toContain('no longer open')
	})

	it('refuses an edit that makes a cell source a number, and does not touch the read tracker', async () => {
		const { dir, path } = scratch('a.ipynb', notebook)
		const tracker = createFileReadTracker()
		const recordRead = vi.spyOn(tracker, 'recordRead')
		const recordWindow = vi.spyOn(tracker, 'recordReadWindow')
		tracker.recordRead(path, notebook, 'seed')
		recordRead.mockClear()
		const result = await EditTool.execute(
			{ path, oldStr: '"source": "hello"', newStr: '"source": 3' },
			{ ...ctx(dir), fileReadTracker: tracker },
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('cell 1 needs a "source"')
		expect(recordRead).not.toHaveBeenCalled()
		expect(recordWindow).not.toHaveBeenCalled()
		expect(readFileSync(path, 'utf-8')).toBe(notebook)
	})

	it('checks the real file behind a symlink, not the name typed', async () => {
		const { dir, path } = scratch('real.ipynb', notebook)
		symlinkSync(path, join(dir, 'x.txt'))
		const refused = await WriteFileTool.execute(
			{ path: join(dir, 'x.txt'), content: 'plain' },
			ctx(dir),
		)
		expect(refused.success).toBe(false)
		expect(readFileSync(path, 'utf-8')).toBe(notebook)

		const text = scratch('t.txt', 'plain')
		symlinkSync(text.path, join(text.dir, 'n.ipynb'))
		const allowed = await WriteFileTool.execute(
			{ path: join(text.dir, 'n.ipynb'), content: 'still plain' },
			ctx(text.dir),
		)
		expect(allowed.success).toBe(true)
	})

	describe('in a sandbox', () => {
		function sandboxCtx(body: string | null) {
			const writeFile = vi.fn(async () => {})
			const readFile = vi.fn(async () => {
				if (body === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
				return Buffer.from(body)
			})
			const context = {
				...ctx('/sandbox'),
				sandbox: { writeFile, readFile },
			} as unknown as ToolContext
			return { context, writeFile }
		}

		it('edit refuses a broken notebook and writes a valid one', async () => {
			const bad = sandboxCtx(notebook)
			const refused = await EditTool.execute(
				{ path: 'a.ipynb', old_string: '"cells"', new_string: '"cellz"' },
				bad.context,
			)
			expect(refused.success).toBe(false)
			expect(bad.writeFile).not.toHaveBeenCalled()

			const ok = sandboxCtx(notebook)
			const done = await EditTool.execute(
				{ path: 'a.ipynb', old_string: 'print(\\"old\\")', new_string: 'print(\\"new\\")' },
				ok.context,
			)
			expect(done.success).toBe(true)
			expect(ok.writeFile).toHaveBeenCalledTimes(1)
		})

		it('write refuses a broken notebook and writes a valid one', async () => {
			const bad = sandboxCtx(null)
			const refused = await WriteFileTool.execute({ path: 'a.ipynb', content: 'nope' }, bad.context)
			expect(refused.success).toBe(false)
			expect(bad.writeFile).not.toHaveBeenCalled()

			const ok = sandboxCtx(null)
			const done = await WriteFileTool.execute({ path: 'a.ipynb', content: notebook }, ok.context)
			expect(done.success).toBe(true)
			expect(ok.writeFile).toHaveBeenCalledWith('a.ipynb', notebook)
		})
	})
})
