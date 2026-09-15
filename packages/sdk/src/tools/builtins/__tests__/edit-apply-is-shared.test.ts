import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { replayEditCall } from '../edit-apply.js'
import { EditTool } from '../edit.js'

/**
 * `replayEditCall` exists so a second caller can reconstruct what an `edit`
 * call did without touching the filesystem — and the only thing that makes
 * that reconstruction trustworthy is that it runs the SAME code `edit.ts`
 * runs at mutation time, not a parallel copy that could quietly drift (most
 * easily on the CRLF reconciliation, which depends on the real file's
 * line-ending mix).
 *
 * So every case here does the same two things and compares them: run the
 * real tool against a real file on disk, then run `replayEditCall` against
 * the original in-memory string with the same (JSON-round-tripped, as a
 * live tool call's arguments would arrive) arguments, and assert the two
 * bodies are byte for byte the same.
 */

function makeContext(workingDirectory: string): ToolContext {
	return {
		runId: 'b2f2f7b0-6a51-4f8b-9b9f-2a7e6f9c9f21' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

/** Round-trips through JSON, the same shape a visible tool call's arguments arrive in. */
function asRawArguments(value: Record<string, unknown>): unknown {
	return JSON.parse(JSON.stringify(value))
}

async function expectSameBody(
	originalContent: string,
	rawArguments: Record<string, unknown>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-apply-shared-'))
	const file = join(dir, 'doc.md')
	writeFileSync(file, originalContent)

	const result = await EditTool.execute(
		{ path: 'doc.md', ...rawArguments } as never,
		makeContext(dir),
	)
	expect(result.success, JSON.stringify({ rawArguments, error: result.error })).toBe(true)
	const onDisk = readFileSync(file, 'utf-8')

	const replayed = replayEditCall(originalContent, asRawArguments(rawArguments))

	expect(replayed.content).toBe(onDisk)
	const data = result.data as { replacements?: number } | undefined
	if (typeof data?.replacements === 'number') {
		expect(replayed.replacements).toBe(data.replacements)
	}
}

describe('replayEditCall reproduces EditTool.execute byte for byte', () => {
	it('a single old_string/new_string replacement', async () => {
		await expectSameBody('alpha\nbeta\nomega\n', {
			old_string: 'beta',
			new_string: 'gamma',
		})
	})

	it('the oldStr/newStr aliases', async () => {
		await expectSameBody('alpha\nbeta\nomega\n', {
			oldStr: 'beta',
			newStr: 'gamma',
		})
	})

	it('an edits[] batch, applied in order', async () => {
		await expectSameBody(['const one = 1', 'const two = 2', 'const three = 3', ''].join('\n'), {
			edits: [
				{ old_string: 'const one = 1', new_string: 'const first = 1' },
				{ old_string: 'const three = 3', new_string: 'const third = 3' },
			],
		})
	})

	// Liberal aliases for "end of file" — strict in the model schema, loose
	// here for the hosts and providers that do not constrain.
	for (const alias of ['end', 'eof', 'append', 'last', 'end_of_file', 'end-of-file', 'EOF']) {
		it(`insertLine with the "${alias}" synonym`, async () => {
			await expectSameBody('alpha\nbeta\n', {
				insertLine: alias,
				new_string: 'omega',
			})
		})
	}

	it('insertLine at a specific 1-indexed line', async () => {
		await expectSameBody('alpha\nbeta\nomega\n', {
			insertLine: 1,
			new_string: 'inserted',
		})
	})

	it('replace_all across every occurrence', async () => {
		await expectSameBody('alpha alpha alpha', {
			old_string: 'alpha',
			new_string: 'beta',
			replace_all: true,
		})
	})

	it('a CRLF file, reconciling the caller’s LF anchor', async () => {
		await expectSameBody('alpha\r\nbeta\r\nomega\r\n', {
			old_string: 'alpha\nbeta',
			new_string: 'gamma\ndelta',
		})
	})

	it('a file with no trailing newline', async () => {
		await expectSameBody('alpha\nbeta', {
			insertLine: 'end',
			new_string: 'omega',
		})
	})

	it('a file with embedded tabs', async () => {
		await expectSameBody('alpha\n\tbeta\tgamma\n', {
			old_string: '\tbeta\tgamma',
			new_string: '\tdelta\tepsilon',
		})
	})
})
