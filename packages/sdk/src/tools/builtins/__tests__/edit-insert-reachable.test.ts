import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { EditTool } from '../edit.js'
import { WriteFileTool } from '../write-file.js'

/**
 * The tool's description ordered an idiom its own schema forbade.
 *
 * `edit`'s description says "For insertions, pass insertLine … use
 * insertLine: 'end' to extend a file at the end". `modelInputSchema` listed
 * only path/old_string/new_string/replace_all with
 * `additionalProperties: false`, and `enforceModelInput: true` — so under
 * constrained decoding the append idiom the prompt recommends was the one
 * idiom a model could not emit.
 *
 * A consuming host measured the consequence over 7 days on one tenant: 94 of
 * 159 tool failures were `edit` rejecting an `insertLine` the model had
 * guessed a spelling for. That number is theirs and not reproducible here;
 * the contradiction below is reproducible and is what these pin.
 */

let dirs: string[] = []

afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
	dirs = []
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-edit-insert-'))
	dirs.push(dir)
	return dir
}

const ctx = (workingDirectory: string): ToolContext =>
	({
		runId: 'run_e',
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => undefined,
	}) as unknown as ToolContext

const schema = () =>
	(EditTool as unknown as { modelInputSchema: Record<string, unknown> }).modelInputSchema

describe('the model can emit the idiom the description recommends', () => {
	it('advertises insertLine at all', () => {
		const props = schema().properties as Record<string, unknown>

		expect(props.insertLine).toBeDefined()
	})

	it('keeps the closed shape, so an invented field is still refused', () => {
		expect(schema().additionalProperties).toBe(false)
	})

	it('does not require old_string, which an insert cannot supply', () => {
		// Requiring it is what made the append idiom unexpressible: an insert
		// has no text to match.
		expect(schema().required).not.toContain('old_string')
	})

	it('still requires the two fields every operation needs', () => {
		expect(schema().required).toEqual(expect.arrayContaining(['path', 'new_string']))
	})

	it('admits only "end" as a string, so a synonym cannot be generated', () => {
		const insert = (schema().properties as Record<string, { anyOf?: unknown[] }>).insertLine

		// The schema is where the synonym problem is solved for a provider that
		// constrains: `"EOF"` is not emittable because `"end"` is the only
		// string the union admits.
		//
		// `anyOf`, not `oneOf`: strict tool use validates against a subset of
		// JSON Schema that excludes `oneOf`, and the vendor rejects the whole
		// request rather than one field — so the spelling here is load-bearing,
		// not stylistic. The two are equivalent for disjoint branches.
		// `minimum` is gone for the same reason; the execution schema keeps it.
		expect(insert?.anyOf).toEqual([{ type: 'integer' }, { const: 'end' }])
	})
})

describe('an insert actually works end to end', () => {
	it('appends with insertLine "end"', async () => {
		const dir = await workdir()
		await writeFile(join(dir, 'a.md'), 'first\n', 'utf-8')

		const result = await EditTool.execute(
			{ path: 'a.md', insertLine: 'end', new_string: 'second', replace_all: false },
			ctx(dir),
		)

		expect(result.success).toBe(true)
		expect(await readFile(join(dir, 'a.md'), 'utf-8')).toContain('second')
	})

	it('inserts after a numbered line', async () => {
		const dir = await workdir()
		await writeFile(join(dir, 'a.md'), 'one\ntwo\n', 'utf-8')

		await EditTool.execute(
			{ path: 'a.md', insertLine: 1, new_string: 'inserted', replace_all: false },
			ctx(dir),
		)

		const lines = (await readFile(join(dir, 'a.md'), 'utf-8')).split('\n')
		expect(lines[1]).toBe('inserted')
	})
})

describe('a synonym for the end of the file is accepted, not charged for', () => {
	it.each(['EOF', 'append', 'last', 'End_Of_File'])('accepts %s', async (spelling) => {
		const dir = await workdir()
		await writeFile(join(dir, 'a.md'), 'first\n', 'utf-8')

		const result = await EditTool.execute(
			{ path: 'a.md', insertLine: spelling, new_string: 'second', replace_all: false },
			ctx(dir),
		)

		// Liberal here and strict in the schema, which is the right way round.
		// None of these is ambiguous; refusing one costs a full model round
		// trip to be told a synonym.
		expect(result.success).toBe(true)
	})

	it('still refuses something that is not a line and not the end', async () => {
		const dir = await workdir()
		await writeFile(join(dir, 'a.md'), 'first\n', 'utf-8')

		const result = await EditTool.execute(
			{ path: 'a.md', insertLine: 'somewhere in the middle', new_string: 'x', replace_all: false },
			ctx(dir),
		)

		expect(result.success).toBe(false)
		// The rejection names what was received, so the retry is informed.
		expect(result.error).toContain('somewhere in the middle')
	})

	it('still refuses a negative line', async () => {
		const dir = await workdir()
		await writeFile(join(dir, 'a.md'), 'first\n', 'utf-8')

		const result = await EditTool.execute(
			{ path: 'a.md', insertLine: -3, new_string: 'x', replace_all: false },
			ctx(dir),
		)

		expect(result.success).toBe(false)
	})
})

describe('the two mutating tools agree on what a path is', () => {
	it('write refuses a whitespace-only path, as edit already did', async () => {
		const dir = await workdir()

		const w = await WriteFileTool.execute({ path: '   ', content: 'x' }, ctx(dir))
		const e = await EditTool.execute(
			{ path: '   ', old_string: 'a', new_string: 'b', replace_all: false },
			ctx(dir),
		)

		expect(w.success).toBe(false)
		expect(e.success).toBe(false)
	})
})
