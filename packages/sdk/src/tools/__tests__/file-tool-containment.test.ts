import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../types/tool/index.js'
import { EditTool } from '../builtins/edit.js'
import { ReadFileTool } from '../builtins/read-file.js'
import { WriteFileTool } from '../builtins/write-file.js'

/**
 * `read`, `write` and `edit` all called `resolve(workingDirectory, input.path)`
 * bare. The search tools — `glob`, `grep`, `ls` — were contained; the three
 * that actually read and mutate user files were not, so `path: "../../.."`
 * reached whatever sits above the working directory with no sandbox involved.
 * `resolveWithin` existed the whole time, and its own docstring says the
 * filesystem tools never reached it.
 *
 * The second half is subtler and is why a lexical check alone was not the
 * answer. `atomicWriteFile` resolves its destination and writes THROUGH a
 * symlink on purpose, so that editing a linked file updates the target rather
 * than replacing the link with a regular file. Paired with a lexical check
 * that is check-then-follow: `./escape -> /elsewhere` climbs nothing on paper
 * and the write lands outside anyway. CWE-59; the ordering fix is CWE-22's
 * stated mitigation — canonicalize, then validate the canonical form.
 *
 * The over-rejection cases matter as much as the escapes. A containment check
 * that refuses legitimate paths is not a safer version of one that works, and
 * the trap is real: `os.tmpdir()` is itself a symlink on macOS, so
 * canonicalizing the candidate while comparing against a raw root would refuse
 * every path in a temp directory — including every path in this file.
 */

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-contain-'))
	const outside = mkdtempSync(join(tmpdir(), 'namzu-outside-'))
	writeFileSync(join(outside, 'secret.txt'), 'SECRET')
	writeFileSync(join(root, 'inside.txt'), 'inside content')
	return { root, outside }
}

const ctx = (root: string): ToolContext =>
	({
		runId: 'run_test' as ToolContext['runId'],
		workingDirectory: root,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}) as unknown as ToolContext

/**
 * Whether this host can create a symlink at all.
 *
 * Windows refuses without elevation or Developer Mode (`EPERM`), and the
 * first version of this file swallowed that per-test and returned early — so
 * three symlink tests reported PASSED on a machine where they had exercised
 * nothing. A test that cannot run must say so; a green tick for work that
 * did not happen is the failure this whole file exists to catch, one level
 * up. `skipIf` makes the reporter print it as skipped, and CI runs on Linux
 * where the probe succeeds and the cases actually execute.
 */
const CAN_SYMLINK = (() => {
	try {
		const probeRoot = mkdtempSync(join(tmpdir(), 'namzu-symprobe-'))
		symlinkSync(probeRoot, join(probeRoot, 'self'), 'dir')
		return true
	} catch {
		return false
	}
})()

describe('the file tools stay inside the working directory', () => {
	it('read refuses a traversal', async () => {
		const { root, outside } = workspace()
		const climb = join('..', join(outside).split(/[\\/]/).pop() as string, 'secret.txt')

		const result = await ReadFileTool.execute({ path: climb } as never, ctx(root))

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})

	it('write refuses a traversal', async () => {
		const { root } = workspace()

		const result = await WriteFileTool.execute(
			{ path: '../escaped.txt', content: 'nope' } as never,
			ctx(root),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})

	it('edit refuses a traversal', async () => {
		const { root } = workspace()

		const result = await EditTool.execute(
			{ path: '../escaped.txt', old_string: 'a', new_string: 'b' } as never,
			ctx(root),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})

	it.skipIf(!CAN_SYMLINK)('write refuses a path that climbs out THROUGH a symlink', async () => {
		const { root, outside } = workspace()
		symlinkSync(outside, join(root, 'escape'), 'dir')

		const result = await WriteFileTool.execute(
			{ path: 'escape/planted.txt', content: 'nope' } as never,
			ctx(root),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
		// The whole point: nothing was written outside.
		expect(() => readFileSync(join(outside, 'planted.txt'))).toThrow()
	})

	it.skipIf(!CAN_SYMLINK)(
		'read refuses a file reached through a symlink out of the root',
		async () => {
			const { root, outside } = workspace()
			symlinkSync(outside, join(root, 'escape'), 'dir')

			const result = await ReadFileTool.execute({ path: 'escape/secret.txt' } as never, ctx(root))

			expect(result.success).toBe(false)
			expect(result.error).toMatch(/escapes the working directory/)
		},
	)

	it.skipIf(!CAN_SYMLINK)(
		'edit refuses a file reached through a symlink out of the root',
		async () => {
			const { root, outside } = workspace()
			symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'), 'file')

			const result = await EditTool.execute(
				{ path: 'linked.txt', old_string: 'SECRET', new_string: 'REPLACED' } as never,
				ctx(root),
			)

			expect(result.success).toBe(false)
			expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('SECRET')
		},
	)
})

describe('the containment check does not over-reject', () => {
	it('reads a file inside the root, whose temp root is itself a symlink on some platforms', async () => {
		const { root } = workspace()

		const result = await ReadFileTool.execute({ path: 'inside.txt' } as never, ctx(root))

		expect(result.success).toBe(true)
		expect(result.output).toContain('inside content')
	})

	it('creates a file that does not exist yet, in a directory that does not either', async () => {
		const { root } = workspace()

		const result = await WriteFileTool.execute(
			{ path: 'nested/deeper/fresh.txt', content: 'hello' } as never,
			ctx(root),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(root, 'nested', 'deeper', 'fresh.txt'), 'utf-8')).toBe('hello')
	})

	it.skipIf(!CAN_SYMLINK)('still follows a symlink that stays inside the root', async () => {
		const { root } = workspace()
		mkdirSync(join(root, 'real'))
		writeFileSync(join(root, 'real', 'target.txt'), 'original')
		symlinkSync(join(root, 'real', 'target.txt'), join(root, 'alias.txt'), 'file')

		const result = await EditTool.execute(
			{ path: 'alias.txt', old_string: 'original', new_string: 'updated' } as never,
			ctx(root),
		)

		expect(result.success).toBe(true)
		// Written THROUGH the link, so the link survives and the target moved —
		// the behaviour `atomicWriteFile` exists to preserve.
		expect(readFileSync(join(root, 'real', 'target.txt'), 'utf-8')).toBe('updated')
	})
})
