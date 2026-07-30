import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../../types/tool/index.js'
import { EditTool } from '../edit.js'
import { getBuiltinTools } from '../index.js'
import { WriteFileTool } from '../write-file.js'

describe('filesystem tool payload budgeting', () => {
	it('does not hard-fail oversized write/edit payloads at schema validation', () => {
		const oversized = 'x'.repeat(12_500)

		expect(() =>
			WriteFileTool.inputSchema.parse({ path: 'outputs/long.md', content: oversized }),
		).not.toThrow()
		expect(() =>
			EditTool.inputSchema.parse({
				path: 'outputs/long.md',
				old_string: '{{SECTION}}',
				new_string: oversized,
				replace_all: false,
			}),
		).not.toThrow()
	})

	it('keeps append out of the default builtin toolset', () => {
		const names = getBuiltinTools().map((tool) => tool.name)

		expect(names).toContain('edit')
		expect(names).not.toContain('append')
	})

	it('assembles replay-safe long documents by advancing an exact marker', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-long-doc-'))
		const ctx: ToolContext = {
			runId: 'run_test' as ToolContext['runId'],
			workingDirectory: dir,
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
		}
		const opening = '# Long document regression\n\n{{CHUNK_001}}\n'
		const chunks = Array.from({ length: 6 }, (_, sectionIndex) => {
			const lines = Array.from({ length: 45 }, (_, lineIndex) => {
				const section = sectionIndex + 1
				const line = lineIndex + 1
				return `Section ${section}.${line}: this bounded paragraph proves long-form output grows through exact marker edits rather than one oversized JSON tool argument.`
			})
			const chunk = [`## Section ${sectionIndex + 1}`, ...lines, ''].join('\n')
			expect(chunk.length).toBeLessThan(12_000)
			return chunk
		})

		const writeResult = await WriteFileTool.execute(
			{ path: 'outputs/regression-long-document.md', content: opening },
			ctx,
		)
		expect(writeResult.success).toBe(true)

		for (const [index, chunk] of chunks.entries()) {
			const currentMarker = `{{CHUNK_${String(index + 1).padStart(3, '0')}}}`
			const nextMarker = `{{CHUNK_${String(index + 2).padStart(3, '0')}}}`
			const result = await EditTool.execute(
				{
					path: 'outputs/regression-long-document.md',
					old_string: currentMarker,
					new_string: `${chunk}\n${nextMarker}`,
					replace_all: false,
				},
				ctx,
			)
			expect(result.success).toBe(true)

			if (index === 0) {
				const beforeReplay = readFileSync(join(dir, 'outputs/regression-long-document.md'), 'utf-8')
				const replay = await EditTool.execute(
					{
						path: 'outputs/regression-long-document.md',
						old_string: currentMarker,
						new_string: `${chunk}\n${nextMarker}`,
						replace_all: false,
					},
					ctx,
				)
				expect(replay.success).toBe(false)
				expect(readFileSync(join(dir, 'outputs/regression-long-document.md'), 'utf-8')).toBe(
					beforeReplay,
				)
			}
		}

		const finalMarker = `{{CHUNK_${String(chunks.length + 1).padStart(3, '0')}}}`
		const finalize = await EditTool.execute(
			{
				path: 'outputs/regression-long-document.md',
				old_string: finalMarker,
				new_string: '',
				replace_all: false,
			},
			ctx,
		)
		expect(finalize.success).toBe(true)

		const final = readFileSync(join(dir, 'outputs/regression-long-document.md'), 'utf-8')
		expect(final).not.toContain('{{CHUNK_')
		expect(final.split('\n').length).toBeGreaterThan(250)
		expect(final).toContain('## Section 1')
		expect(final).toContain('## Section 6')
		expect(final).toContain('Section 6.45')
	})
})
