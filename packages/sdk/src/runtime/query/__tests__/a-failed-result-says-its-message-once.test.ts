import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { screenToolResult } from '../../../registry/tool/screen.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { formatFailedToolOutput } from '../executor/tool-call-admission.js'

describe('a failed tool result carries its own message once', () => {
	it('adds no generic suffix when the tool explained itself in its output', () => {
		expect(formatFailedToolOutput('It is not readable as text.', undefined)).toBe(
			'It is not readable as text.',
		)
	})

	it('still appends a named error to the output, and falls back when there is nothing', () => {
		expect(formatFailedToolOutput('partial', 'boom')).toBe('partial\n\nError: boom')
		expect(formatFailedToolOutput('', 'boom')).toBe('Error: boom')
		expect(formatFailedToolOutput('  ', undefined)).toBe('Error: Tool execution failed')
		expect(formatFailedToolOutput(undefined, undefined)).toBe('Error: Tool execution failed')
	})

	it('shows a guardrail the same text the model gets', async () => {
		let seen = ''
		await screenToolResult(
			[
				async (ctx: { output: string }) => {
					seen = ctx.output
					return { action: 'allow' }
				},
			] as never,
			{ success: false, output: 'It is not readable as text.' },
			{ toolName: 'read' } as never,
			{ warn() {}, error() {}, info() {}, debug() {} } as never,
		)
		expect(seen).toBe('It is not readable as text.')
	})

	it('a file with NUL bytes reaches the model with one message', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-nul-'))
		writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x61, 0, 0x62, 0, 0x63, 0, 1, 2]))
		const result = await ReadFileTool.execute({ path: 'bin.dat' }, {
			sessionId: 's',
			turnId: 't',
			workingDirectory: dir,
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
		} as unknown as ToolContext)
		expect(result.success).toBe(false)
		const modelText = formatFailedToolOutput(result.output, result.error)
		expect(modelText).toContain('not readable as text')
		expect(modelText).not.toContain('Tool execution failed')
		expect(modelText.match(/Error:/g) ?? []).toHaveLength(0)
	})
})
