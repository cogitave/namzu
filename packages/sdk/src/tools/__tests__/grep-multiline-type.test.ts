import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { ToolContext } from '../../types/tool/index.js'
import { GrepTool } from '../builtins/grep.js'

const temporary: string[] = []
afterEach(() => {
	for (const path of temporary.splice(0)) removeTempDir(path)
})

async function project(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-grep-mt-'))
	temporary.push(root)
	for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text)
	return root
}

const args = (extra: object) => ({
	case_sensitive: true,
	context_lines: 0,
	output_mode: 'content' as const,
	offset: 0,
	multiline: false,
	...extra,
})
const run = (root: string, extra: object) =>
	GrepTool.execute(args(extra) as never, { workingDirectory: root } as ToolContext)

describe('grep multiline', () => {
	const source = 'function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n'

	it('does not cross a line without the flag', async () => {
		const root = await project({ 'a.ts': source })
		const result = await run(root, { pattern: 'a\\(\\) \\{.*return' })
		expect(result.output).toContain('No matches')
	})

	it('lets a pattern span lines and prints every covered line', async () => {
		const root = await project({ 'a.ts': source })
		const result = await run(root, { pattern: 'a\\(\\) \\{.*?return 1', multiline: true })
		expect(result.output).toContain('./a.ts:1:function a() {')
		expect(result.output).toContain('./a.ts:2:  return 1')
		expect(result.output).not.toContain('./a.ts:3:')
		expect(result.data).toMatchObject({ totalMatches: 1 })
	})

	it('keeps ^ and $ on line boundaries', async () => {
		const root = await project({ 'a.ts': source })
		const result = await run(root, { pattern: '^}$', multiline: true })
		expect(result.output).toContain('./a.ts:3:}')
		expect(result.output).toContain('./a.ts:6:}')
	})

	it('counts matching lines once in count mode', async () => {
		const root = await project({ 'a.ts': source })
		const result = await run(root, {
			pattern: 'a\\(\\) \\{.*?return 1',
			multiline: true,
			output_mode: 'count',
		})
		expect(result.output).toContain('./a.ts:2')
	})

	it('ends on an empty match without looping', async () => {
		const root = await project({ 'a.ts': 'x\n' })
		const result = await run(root, { pattern: 'y*', multiline: true })
		expect(result.success).toBe(true)
	})
})

describe('grep type', () => {
	it('searches only files of that kind', async () => {
		const root = await project({ 'a.ts': 'needle\n', 'b.py': 'needle\n', 'c.md': 'needle\n' })
		const result = await run(root, {
			pattern: 'needle',
			output_mode: 'files_with_matches',
			type: 'py',
		})
		expect(result.output).toContain('./b.py')
		expect(result.output).not.toContain('a.ts')
		expect(result.output).not.toContain('c.md')
	})

	it('takes a long alias and a leading dot', async () => {
		const root = await project({ 'a.tsx': 'needle\n', 'b.js': 'needle\n' })
		const result = await run(root, {
			pattern: 'needle',
			output_mode: 'files_with_matches',
			type: '.typescript',
		})
		expect(result.output).toContain('./a.tsx')
		expect(result.output).not.toContain('b.js')
	})

	it('names the known kinds for an unknown one', async () => {
		const root = await project({ 'a.ts': 'needle\n' })
		const result = await run(root, { pattern: 'needle', type: 'cobol9' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('Unknown file type "cobol9"')
		expect(result.error).toContain('rust')
	})
})
