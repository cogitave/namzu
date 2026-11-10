import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ToolManager } from '../../../toolsets/manager.js'
import { toolset } from '../../../toolsets/toolset.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { type EditInput, EditTool } from '../edit.js'

/**
 * A task bench ran a small model through a four-file change and 4 of its 22
 * tool calls were edits refused at validation. The raw run keeps the error text
 * but not the arguments of a refused call, so the inputs below are the shape
 * each error names: `edits: []` beside a top-level edit (error "edits: Too small:
 * expected array to have >=1 items" plus the "not both" refusal, three calls)
 * and a list entry beside the same top-level edit ("not both" alone, one call;
 * this second fixture is ANTICIPATED, not seen: the run does not record its input).
 * The text is the real `docs/levels.md` change the bench task asked for.
 */

const LEVELS_DOC = [
	'# Levels',
	'',
	'From least to most severe:',
	'',
	'| level | meaning |',
	'|---|---|',
	'| debug | developer detail |',
	'| info | normal operation |',
	'| warn | something odd |',
	'| error | something failed |',
].join('\n')

const OLD = '| info | normal operation |\n| warn | something odd |'
const NEW =
	'| info | normal operation |\n| notice | noteworthy but expected |\n| warn | something odd |'

function context(workingDirectory: string, overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: 'd71ecfcb-287a-445a-a34e-48026d38d820' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...overrides,
	}
}

function workspace(name = 'levels.md', body = LEVELS_DOC) {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-forgive-'))
	writeFileSync(join(dir, name), body)
	return { dir, read: () => readFileSync(join(dir, name), 'utf-8') }
}

function manager(): ToolManager {
	return new ToolManager({ toolsets: [toolset('fs', [EditTool])], messages: () => [] })
}

describe('an empty edits list beside a top-level edit', () => {
	const input = { path: 'levels.md', old_string: OLD, new_string: NEW, edits: [] }

	it('is the top-level edit', async () => {
		const { dir, read } = workspace()
		const result = await EditTool.execute(input, context(dir))
		expect(result.success).toBe(true)
		expect(read()).toBe(LEVELS_DOC.replace(OLD, NEW))
	})

	it('reaches review and execution as the one canonical shape', () => {
		const prepared = manager().prepareExecution('edit', input)
		expect(prepared.success).toBe(true)
		if (!prepared.success) return
		expect(prepared.prepared.input).toEqual({ path: 'levels.md', old_string: OLD, new_string: NEW })
	})

	it('also carries an insertion', async () => {
		const { dir, read } = workspace()
		const result = await EditTool.execute(
			{ path: 'levels.md', insertLine: 'end', new_string: '\nlast', edits: [] },
			context(dir),
		)
		expect(result.success).toBe(true)
		expect(read().endsWith('\nlast')).toBe(true)
	})

	it('still names the missing half when the top-level edit is incomplete', async () => {
		const { dir, read } = workspace()
		const result = await EditTool.execute(
			{ path: 'levels.md', old_string: OLD, edits: [] },
			context(dir),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('Either new_string or newStr is required.')
		expect(read()).toBe(LEVELS_DOC)
	})
})

describe('a one-entry batch that restates the top-level edit', () => {
	const input = {
		path: 'levels.md',
		old_string: OLD,
		new_string: NEW,
		edits: [{ old_string: OLD, new_string: NEW }],
	}

	it('is that edit, applied once', async () => {
		const { dir, read } = workspace()
		const result = await EditTool.execute(input, context(dir))
		expect(result.success).toBe(true)
		expect(read()).toBe(LEVELS_DOC.replace(OLD, NEW))
	})

	it('reaches review as the batch, with the duplicate top-level half gone', () => {
		const prepared = manager().prepareExecution('edit', input)
		expect(prepared.success).toBe(true)
		if (!prepared.success) return
		expect(prepared.prepared.input).toEqual({
			path: 'levels.md',
			edits: [{ old_string: OLD, new_string: NEW }],
		})
	})

	it('accepts the alias spellings of the same edit', async () => {
		const { dir, read } = workspace()
		const result = await EditTool.execute(
			{
				path: 'levels.md',
				oldStr: OLD,
				newStr: NEW,
				edits: [{ old_string: OLD, new_string: NEW }],
			},
			context(dir),
		)
		expect(result.success).toBe(true)
		expect(read()).toBe(LEVELS_DOC.replace(OLD, NEW))
	})
})

describe('a genuinely conflicting pair stays refused', () => {
	const conflicts: [string, EditInput][] = [
		[
			'a different top-level edit',
			{
				path: 'levels.md',
				old_string: 'debug',
				new_string: 'trace',
				edits: [{ old_string: OLD, new_string: NEW }],
			},
		],
		[
			'a longer list',
			{
				path: 'levels.md',
				old_string: OLD,
				new_string: NEW,
				edits: [
					{ old_string: OLD, new_string: NEW },
					{ old_string: 'debug', new_string: 'trace' },
				],
			},
		],
		[
			'a different replace_all',
			{
				path: 'levels.md',
				old_string: OLD,
				new_string: NEW,
				replace_all: true,
				edits: [{ old_string: OLD, new_string: NEW }],
			},
		],
		[
			'an insertion beside a list',
			{
				path: 'levels.md',
				insertLine: 'end',
				new_string: NEW,
				edits: [{ old_string: OLD, new_string: NEW }],
			},
		],
	]

	it.each(conflicts)('%s', async (_name, input) => {
		const { dir, read } = workspace()
		const result = await EditTool.execute(input, context(dir))
		expect(result.success).toBe(false)
		expect(read()).toBe(LEVELS_DOC)
		// Both accepted shapes, one line each, and nothing else to decode.
		const lines = (result.error ?? '').split('\n')
		expect(lines.some((line) => line.startsWith('Single edit: {"path"'))).toBe(true)
		expect(lines.some((line) => line.startsWith('Several edits: {"path"'))).toBe(true)
	})

	it('is refused at validation with the same two lines', () => {
		const prepared = manager().prepareExecution('edit', conflicts[0]?.[1])
		expect(prepared.success).toBe(false)
		if (prepared.success) return
		expect(prepared.result.error).toContain('Single edit: {"path"')
		expect(prepared.result.error).toContain('Several edits: {"path"')
	})

	it('ends the `Several edits:` line in JSON, with the required-fields hint on its own line', () => {
		const prepared = manager().prepareExecution('edit', conflicts[0]?.[1])
		expect(prepared.success).toBe(false)
		if (prepared.success) return
		const lines = (prepared.result.error ?? '').split('\n')
		const line = lines.find((l) => l.startsWith('Several edits: '))
		expect(line).toBeDefined()
		expect(() => JSON.parse((line ?? '').slice('Several edits: '.length))).not.toThrow()
		expect(lines[lines.length - 1]).toContain('Required')
	})
})

describe('an empty list with nothing beside it', () => {
	it('says what to send next instead of "Too small"', () => {
		const prepared = manager().prepareExecution('edit', { path: 'levels.md', edits: [] })
		expect(prepared.success).toBe(false)
		if (prepared.success) return
		expect(prepared.result.error).toContain('`edits` is an empty list')
		expect(prepared.result.error).toContain('Single edit: {"path"')
		expect(prepared.result.error).not.toContain('Too small')
	})
})

describe('a schema error is a plain sentence naming the field', () => {
	it('an empty old_string inside a batch entry', () => {
		const prepared = manager().prepareExecution('edit', {
			path: 'levels.md',
			edits: [{ old_string: '', new_string: 'x' }],
		})
		expect(prepared.success).toBe(false)
		if (prepared.success) return
		expect(prepared.result.error).toContain('"edits[0].old_string" must not be empty')
		expect(prepared.result.error).not.toContain('Too small')
	})

	it('a missing path', () => {
		const prepared = manager().prepareExecution('edit', { old_string: 'a', new_string: 'b' })
		expect(prepared.success).toBe(false)
		if (prepared.success) return
		expect(prepared.result.error).toContain('"path" is missing; send it as a string')
		expect(prepared.result.error).not.toContain('Invalid input')
	})
})

describe('what is unchanged', () => {
	it('refuses an edit to a file the session has not read, and shows it', async () => {
		const { dir, read } = workspace()
		const tracker = createFileReadTracker()
		const result = await EditTool.execute(
			{ path: 'levels.md', old_string: OLD, new_string: NEW, edits: [] },
			context(dir, { fileReadTracker: tracker }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('had not been read in this session')
		expect(read()).toBe(LEVELS_DOC)
	})

	it('still requires old_string to be unique', async () => {
		const { dir, read } = workspace('dup.md', 'alpha\nalpha\n')
		const result = await EditTool.execute(
			{ path: 'dup.md', old_string: 'alpha', new_string: 'beta', edits: [] },
			context(dir),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('is not unique')
		expect(read()).toBe('alpha\nalpha\n')
	})

	it('still refuses a path outside the roots', async () => {
		const { dir } = workspace()
		const outside = mkdtempSync(join(tmpdir(), 'namzu-edit-outside-'))
		writeFileSync(join(outside, 'x.md'), 'secret\n')
		const result = await EditTool.execute(
			{ path: join(outside, 'x.md'), old_string: 'secret', new_string: 'open', edits: [] },
			context(dir),
		)
		expect(result.success).toBe(false)
		expect(readFileSync(join(outside, 'x.md'), 'utf-8')).toBe('secret\n')
	})

	it('still refuses an edit that leaves a notebook as invalid JSON', async () => {
		const body = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })
		const { dir, read } = workspace('n.ipynb', body)
		const result = await EditTool.execute(
			{ path: 'n.ipynb', old_string: '"cells": []', new_string: '"cells": [', edits: [] },
			context(dir),
		)
		expect(result.success).toBe(false)
		expect(read()).toBe(body)
	})
})
