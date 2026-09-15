import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { predictReplayLength, replayEditCall } from '../edit-apply.js'
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
	// The projection charges its replay allowance against this BEFORE it
	// replays, so a prediction that is not the real length either refuses a
	// chain that was going to fit or admits one that was not.
	expect(
		predictReplayLength(originalContent, asRawArguments(rawArguments), Number.MAX_SAFE_INTEGER),
	).toBe(onDisk.length)
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

describe('predictReplayLength answers what the replay would cost, without paying it', () => {
	it('stops counting occurrences once no further match can fit the allowance', () => {
		const content = 'alpha '.repeat(5_000)
		const call = { old_string: 'alpha', new_string: 'alphax', replace_all: true }
		expect(predictReplayLength(content, call, Number.MAX_SAFE_INTEGER)).toBe(content.length + 5_000)
		// Counting all 5,000 out only to refuse them is the work the allowance
		// exists to avoid: past it, the number is a refusal and nothing more.
		const tight = predictReplayLength(content, call, content.length + 10)
		expect(tight).toBeGreaterThan(content.length + 10)
		expect(tight).toBeLessThan(content.length + 5_000)
	})

	it('predicts no growth for a shape the replay is going to throw on anyway', () => {
		expect(predictReplayLength('alpha\n', { insertLine: 'nowhere', new_string: 'x' }, 100)).toBe(6)
		expect(predictReplayLength('alpha\n', {}, 100)).toBe(6)
	})

	it('covers the largest string a batch builds, not the body it ends on', () => {
		// Each hunk works on what the one before it produced, so a batch can
		// blow far past its own result on the way there. Small enough here to
		// run for real: ten characters become twenty before the last hunk
		// deletes every one of them.
		const fold = {
			edits: [
				{ old_string: 'X', new_string: 'a'.repeat(10) },
				{ old_string: 'a', new_string: 'bb', replace_all: true },
				{ old_string: 'b', new_string: '', replace_all: true },
			],
		}
		expect(replayEditCall('X', asRawArguments(fold)).content).toBe('')
		expect(
			predictReplayLength('X', asRawArguments(fold), Number.MAX_SAFE_INTEGER),
		).toBeGreaterThanOrEqual(20)
	})

	it('refuses a fold that would out-grow the allowance before anything is built', () => {
		// The same shape at the scale a model can actually emit: a 12,165-unit
		// call — comfortably inside the 32,000 a visible call may carry — whose
		// middle hunk multiplies ten thousand characters into twenty million
		// and whose last hunk throws them away. Counted against the caller's
		// own content it predicts 10,000; folded forward it is refused.
		const call = asRawArguments({
			edits: [
				{ old_string: 'X', new_string: 'a'.repeat(10_000) },
				{ old_string: 'a', new_string: 'b'.repeat(2_000), replace_all: true },
				{ old_string: 'b', new_string: '', replace_all: true },
			],
		})
		expect(predictReplayLength('X', call, 262_144)).toBeGreaterThan(262_144)
	})

	it('never predicts a negative length, however impossible the call is', () => {
		// An anchor longer than the whole file: the replay throws, but only
		// after the caller has charged this — and a negative charge would hand
		// the request's allowance back room it never had.
		expect(predictReplayLength('ab', { old_string: 'abcdefghij', new_string: '' }, 100)).toBe(0)
	})
})
