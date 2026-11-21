import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../../types/tool/index.js'
import { EditTool } from '../edit.js'
import { notebookRefusal, withoutByteOrderMark } from '../notebook-guard.js'
import { ReadFileTool } from '../read-file.js'
import { WriteFileTool } from '../write-file.js'

/**
 * A notebook saved by an editor that leads the file with a byte order mark was
 * read as "not valid JSON" and refused as a notebook that never opened by
 * `edit` and `write`, while a notebook program opens the same file. The mark is
 * legal in the file and not in JSON, so a notebook read or checked now drops
 * one at the very start of the text and touches nothing else.
 */

const BOM = '\uFEFF'

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
			{ cell_type: 'code', source: ['print("old")\n'], outputs: [], metadata: {} },
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
	const dir = mkdtempSync(join(tmpdir(), 'nb-bom-'))
	const path = join(dir, name)
	writeFileSync(path, body)
	return { dir, path }
}

describe('a notebook that leads with a byte order mark', () => {
	it('reads as cells instead of as invalid JSON', async () => {
		const { dir, path } = scratch('a.ipynb', BOM + notebook)
		const result = await ReadFileTool.execute({ path }, ctx(dir))
		expect(result.success).toBe(true)
		expect(result.output).toContain('<cell id="cell-0">print("old")')
		expect(result.output).not.toContain('not valid JSON')
	})

	it('is edited rather than refused as a notebook that never opened', async () => {
		const { dir, path } = scratch('a.ipynb', BOM + notebook)
		const result = await EditTool.execute(
			{ path, old_string: 'print(\\"old\\")', new_string: 'print(\\"new\\")' },
			ctx(dir),
		)
		expect(result.success).toBe(true)
		expect(readFileSync(path, 'utf-8')).toContain('print(\\"new\\")')
	})

	it('is accepted when written with the mark', async () => {
		const { dir } = scratch('seed.ipynb', notebook)
		const target = join(dir, 'new.ipynb')
		const result = await WriteFileTool.execute({ path: target, content: BOM + notebook }, ctx(dir))
		expect(result.success).toBe(true)
		expect(readFileSync(target, 'utf-8')).toBe(BOM + notebook)
	})

	it('passes the notebook check, and the mark is the only thing dropped', () => {
		expect(notebookRefusal('x.ipynb', BOM + notebook)).toBeUndefined()
		expect(withoutByteOrderMark(`${BOM}{}`)).toBe('{}')
		// A mark inside the text, and a body with no mark, are left exactly as they are.
		expect(withoutByteOrderMark('{"a": "\uFEFF"}')).toBe('{"a": "\uFEFF"}')
		expect(withoutByteOrderMark(notebook)).toBe(notebook)
	})

	it('still refuses a body that is not JSON even with the mark in front of it', () => {
		expect(notebookRefusal('x.ipynb', `${BOM}not json`)).toContain('not valid JSON')
	})
})
