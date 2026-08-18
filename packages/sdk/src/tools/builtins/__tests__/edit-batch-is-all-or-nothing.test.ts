import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { EditTool } from '../edit.js'

/**
 * A change that spans four places in a file is one change, and sending it as
 * four calls makes it four. Each call can fail after the last one succeeded,
 * and what is left on disk is a state nobody wrote and nobody is looking at —
 * a rename applied at two of its five call sites compiles nowhere and reads
 * like a bug in the code rather than an unfinished edit.
 *
 * So the assertion these are written around is not that a batch applies. It is
 * that a batch which does NOT apply leaves the file byte for byte as it was,
 * and says which entry stopped it.
 */

function context(workingDirectory: string): ToolContext {
	return {
		runId: 'run_batch' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function workspace(body: string): { dir: string; file: string; read: () => string } {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-batch-'))
	const file = join(dir, 'doc.ts')
	writeFileSync(file, body)
	return { dir, file, read: () => readFileSync(file, 'utf-8') }
}

const SOURCE = ['export const one = 1', 'export const two = 2', 'export const three = 3', ''].join(
	'\n',
)

describe('a batch that applies', () => {
	it('makes every replacement in one call', async () => {
		const { dir, read } = workspace(SOURCE)

		const result = await EditTool.execute(
			{
				path: 'doc.ts',
				edits: [
					{ old_string: 'const one = 1', new_string: 'const first = 1' },
					{ old_string: 'const three = 3', new_string: 'const third = 3' },
				],
			},
			context(dir),
		)

		expect(result.success).toBe(true)
		expect(read()).toContain('const first = 1')
		expect(read()).toContain('const third = 3')
		// Untouched between them, which is what makes this an edit rather than
		// a rewrite.
		expect(read()).toContain('const two = 2')
	})

	it('counts every replacement it made, not the number of entries', async () => {
		const { dir } = workspace('a\na\nb\n')

		const result = await EditTool.execute(
			{
				path: 'doc.ts',
				edits: [
					{ old_string: 'a', new_string: 'x', replace_all: true },
					{ old_string: 'b', new_string: 'y' },
				],
			},
			context(dir),
		)

		expect(result.data).toMatchObject({ replacements: 3 })
	})

	it('applies each entry to what the ones before it left', async () => {
		// The sequencing decision, pinned. Matching every anchor against the
		// ORIGINAL text would be more order-independent and would make this
		// impossible: the second entry is looking for text the first produced.
		const { dir, read } = workspace('alpha\n')

		const result = await EditTool.execute(
			{
				path: 'doc.ts',
				edits: [
					{ old_string: 'alpha', new_string: 'beta' },
					{ old_string: 'beta', new_string: 'gamma' },
				],
			},
			context(dir),
		)

		expect(result.success).toBe(true)
		expect(read()).toBe('gamma\n')
	})
})

describe('a batch that does not apply writes nothing at all', () => {
	it('leaves the file byte for byte when a later entry fails', async () => {
		// The load-bearing test. The first entry is perfectly good, so a
		// implementation that wrote as it went would leave it applied.
		const { dir, read } = workspace(SOURCE)

		const result = await EditTool.execute(
			{
				path: 'doc.ts',
				edits: [
					{ old_string: 'const one = 1', new_string: 'const first = 1' },
					{ old_string: 'const nine = 9', new_string: 'const ninth = 9' },
				],
			},
			context(dir),
		)

		expect(result.success).toBe(false)
		expect(read()).toBe(SOURCE)
	})

	it('names which entry stopped it, and how many there were', async () => {
		// Without the index the model re-checks the wrong entry: by the time a
		// later one fails, the text it wanted may have been consumed by an
		// earlier one, so "not found" alone is actively misleading.
		const { dir } = workspace(SOURCE)

		const result = await EditTool.execute(
			{
				path: 'doc.ts',
				edits: [
					{ old_string: 'const one = 1', new_string: 'const first = 1' },
					{ old_string: 'const nine = 9', new_string: 'const ninth = 9' },
				],
			},
			context(dir),
		)

		expect(result.error).toContain('edits[1] of 2')
		expect(result.error).toContain('Nothing was written')
	})

	it('refuses an ambiguous entry rather than replacing the first match', async () => {
		const { dir, read } = workspace('dup\ndup\n')

		const result = await EditTool.execute(
			{ path: 'doc.ts', edits: [{ old_string: 'dup', new_string: 'one' }] },
			context(dir),
		)

		expect(result.success).toBe(false)
		expect(read()).toBe('dup\ndup\n')
	})

	it('refuses a no-op entry by index instead of passing over it', async () => {
		// A batch whose third entry changes nothing is a mistake worth naming:
		// the model believed it was changing something there, and success
		// would leave it believing that.
		const { dir, read } = workspace(SOURCE)

		const result = await EditTool.execute(
			{
				path: 'doc.ts',
				edits: [
					{ old_string: 'const one = 1', new_string: 'const first = 1' },
					{ old_string: 'const two = 2', new_string: 'const two = 2' },
				],
			},
			context(dir),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('edits[1]')
		expect(read()).toBe(SOURCE)
	})
})

describe('the two shapes are kept apart', () => {
	it('refuses a call carrying both a batch and a top-level edit', async () => {
		// Two intentions in one object. Any precedence would be a guess about
		// which the caller meant, and the loser is an edit somebody believes
		// was made.
		const { dir, read } = workspace(SOURCE)

		const result = await EditTool.execute(
			{
				path: 'doc.ts',
				old_string: 'const two = 2',
				new_string: 'const second = 2',
				edits: [{ old_string: 'const one = 1', new_string: 'const first = 1' }],
			},
			context(dir),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('not both')
		expect(read()).toBe(SOURCE)
	})

	it('refuses an empty batch rather than reporting a successful no-op', async () => {
		const { dir } = workspace(SOURCE)

		const result = await EditTool.execute({ path: 'doc.ts', edits: [] }, context(dir))

		expect(result.success).toBe(false)
	})

	it('leaves the single-edit shape deciding exactly what it decided', async () => {
		const { dir, read } = workspace(SOURCE)

		const result = await EditTool.execute(
			{ path: 'doc.ts', old_string: 'const two = 2', new_string: 'const second = 2' },
			context(dir),
		)

		expect(result.success).toBe(true)
		expect(read()).toContain('const second = 2')
		// And its error message is unchanged — no index, because there is no
		// list to index into.
		const missing = await EditTool.execute(
			{ path: 'doc.ts', old_string: 'absent', new_string: 'x' },
			context(dir),
		)
		expect(missing.error).not.toContain('edits[')
	})
})

describe('an anchor that matches nothing in particular', () => {
	// Found by a mutation while testing the batch shape, and it is older than
	// the batch shape. Removing `.min(1)` from `old_string` passed the entire
	// suite — nothing pinned it — and an empty anchor with `replace_all` turns
	// `abc` into `aXbXcX`, because splitting a string on `''` yields every
	// character. Measured rather than reasoned about.
	//
	// The guard was already there. What was missing is any test that would
	// notice it leaving.
	it.each([
		['single', { path: 'doc.ts', old_string: '', new_string: 'X', replace_all: true }],
		['batch', { path: 'doc.ts', edits: [{ old_string: '', new_string: 'X', replace_all: true }] }],
	])('refuses an empty anchor in the %s shape', async (_name, input) => {
		const { dir, read } = workspace('abc\n')

		const result = await EditTool.execute(input, context(dir))

		expect(result.success).toBe(false)
		expect(read()).toBe('abc\n')
	})
})
