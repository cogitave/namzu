import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'

/**
 * That the atomic writer works is tested next door. This tests the thing
 * that actually regressed: whether the TOOL goes through it.
 *
 * `edit` and `write` were reverted to a bare `writeFile`, and the existing
 * atomicity test kept passing because it called `atomicWriteFile` directly —
 * proving the module, never the caller. A write that fails partway then
 * truncates the user's file, which is the one outcome `edit` exists to
 * avoid.
 */

const atomicWriteFile = vi.fn(async () => {})
vi.mock('../atomic-write-file.js', () => ({ atomicWriteFile }))

function makeContext(workingDirectory: string): ToolContext {
	return {
		runId: 'run_atomic' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('the file-mutating tools commit through the atomic writer', () => {
	it('edit routes its local write through it', async () => {
		const { EditTool } = await import('../edit.js')
		atomicWriteFile.mockClear()

		const dir = mkdtempSync(join(tmpdir(), 'namzu-atomic-tool-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(atomicWriteFile).toHaveBeenCalledTimes(1)
		expect(atomicWriteFile).toHaveBeenCalledWith(resolve(dir, 'doc.md'), 'alpha\ngamma\n')
		// The mock swallowed the write, so the file is untouched — which is
		// itself the proof that nothing else wrote it.
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\nbeta\n')
	})

	it('write routes its local write through it', async () => {
		const { WriteFileTool } = await import('../write-file.js')
		atomicWriteFile.mockClear()

		const dir = mkdtempSync(join(tmpdir(), 'namzu-atomic-tool-'))

		const result = await WriteFileTool.execute(
			{ path: 'out.md', content: 'a complete body' },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(atomicWriteFile).toHaveBeenCalledTimes(1)
		expect(atomicWriteFile).toHaveBeenCalledWith(resolve(dir, 'out.md'), 'a complete body')
	})

	it('edit does not use it for a sandboxed write, which the sandbox owns', async () => {
		const { EditTool } = await import('../edit.js')
		atomicWriteFile.mockClear()

		let body = 'alpha\nbeta\n'
		const sandbox = {
			id: 'sbx',
			status: 'ready',
			rootDir: '/workspace',
			environment: 'basic',
			async readFile() {
				return Buffer.from(body)
			},
			async writeFile(_path: string, content: string | Buffer) {
				body = content.toString()
			},
			async exec() {
				throw new Error('not used')
			},
			async listFiles() {
				return []
			},
			async destroy() {},
		}

		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			{ ...makeContext('/workspace'), sandbox } as ToolContext,
		)

		expect(result.success).toBe(true)
		expect(body).toBe('alpha\ngamma\n')
		expect(atomicWriteFile).not.toHaveBeenCalled()
	})
})
