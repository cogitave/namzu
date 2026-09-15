import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { normalizeEditInput, replayEditCallWithin } from '../edit-apply.js'
import { EditTool } from '../edit.js'

/**
 * `replayEditCallWithin` exists so a second caller can reconstruct what an `edit`
 * call did without touching the filesystem — and the only thing that makes
 * that reconstruction trustworthy is that it runs the SAME code `edit.ts`
 * runs at mutation time, not a parallel copy that could quietly drift (most
 * easily on the CRLF reconciliation, which depends on the real file's
 * line-ending mix).
 *
 * So every case here does the same two things and compares them: run the
 * real tool against a real file on disk, then run `replayEditCallWithin` against
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

	const replayed = replayEditCallWithin(
		originalContent,
		asRawArguments(rawArguments),
		Number.MAX_SAFE_INTEGER,
	)
	expect(replayed.outcome).toBe('replayed')
	if (replayed.outcome !== 'replayed') return

	expect(replayed.content).toBe(onDisk)
	// The caller charges its replay allowance against this, so a charge that is
	// not the real length either refuses a chain that was going to fit or admits
	// one that was not. For the single-operation shape — the one almost every
	// call has — it is the post-image length exactly; a batch is charged for the
	// largest body it builds on the way, which may be longer than the one it
	// ends on.
	const normalized = normalizeEditInput({ ...rawArguments } as never)
	expect(normalized.success).toBe(true)
	if (normalized.success && normalized.operations.length === 1) {
		expect(replayed.charged).toBe(onDisk.length)
	} else {
		expect(replayed.charged).toBeGreaterThanOrEqual(onDisk.length)
	}
	const data = result.data as { replacements?: number } | undefined
	if (typeof data?.replacements === 'number') {
		expect(replayed.replacements).toBe(data.replacements)
	}
}

describe('replayEditCallWithin reproduces EditTool.execute byte for byte', () => {
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

describe('the allowance is honoured one operation at a time', () => {
	function replay(content: string, call: Record<string, unknown>, allowance: number) {
		return replayEditCallWithin(content, asRawArguments(call), allowance)
	}

	it('charges a single replacement exactly what it builds', () => {
		const content = 'alpha '.repeat(5_000)
		const call = {
			old_string: 'alpha',
			new_string: 'alphax',
			replace_all: true,
		}
		const replayed = replay(content, call, Number.MAX_SAFE_INTEGER)
		expect(replayed.outcome).toBe('replayed')
		expect(replayed.charged).toBe(content.length + 5_000)
	})

	it('refuses before building, and counts no further than the refusal needs', () => {
		// Counting all 5,000 matches out only to refuse them is the work the
		// allowance exists to avoid, so the occurrence scan stops as soon as one
		// more match cannot fit. Nothing is built either way, so nothing is
		// charged.
		const content = 'alpha '.repeat(5_000)
		const call = {
			old_string: 'alpha',
			new_string: 'alphax',
			replace_all: true,
		}
		const refused = replay(content, call, content.length + 10)
		expect(refused.outcome).toBe('refused')
		expect(refused.charged).toBe(0)
	})

	it('reports a shape it cannot normalize as a failure that built nothing', () => {
		expect(replay('alpha\n', { insertLine: 'nowhere', new_string: 'x' }, 100)).toMatchObject({
			outcome: 'failed',
			charged: 0,
		})
		expect(replay('alpha\n', {}, 100)).toMatchObject({
			outcome: 'failed',
			charged: 0,
		})
	})

	it('charges the largest string a batch builds, not the body it ends on', () => {
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
		const replayed = replay('X', fold, Number.MAX_SAFE_INTEGER)
		expect(replayed.outcome).toBe('replayed')
		if (replayed.outcome !== 'replayed') return
		expect(replayed.content).toBe('')
		expect(replayed.charged).toBe(20)
	})

	it('stops a fold at the operation that would out-grow the allowance', () => {
		// The same shape at the scale a model can actually emit: a 12,165-unit
		// call — comfortably inside the 32,000 a visible call may carry — whose
		// middle hunk would multiply ten thousand characters into twenty
		// million. The first hunk really does build its ten thousand and is
		// charged for them; the second is refused before anything of it exists.
		const call = {
			edits: [
				{ old_string: 'X', new_string: 'a'.repeat(10_000) },
				{ old_string: 'a', new_string: 'b'.repeat(2_000), replace_all: true },
				{ old_string: 'b', new_string: '', replace_all: true },
			],
		}
		expect(replay('X', call, 262_144)).toMatchObject({
			outcome: 'refused',
			charged: 10_000,
		})
	})

	it('admits a later rename hunk for what it builds rather than what it might', () => {
		// The case the per-operation walk exists for. Folding this forward
		// without the intermediate in hand had to assume one match per
		// anchor-length window — 2,627 renames of a four-character identifier
		// in a 10,510-unit file, for a bound of 13,137 — and refused the batch
		// at an allowance the 11,210 it really builds fits inside comfortably.
		const body = `${'const name = 1\n'.repeat(700)}// header\n`
		const call = {
			edits: [
				{ old_string: '// header', new_string: '// HEADER' },
				{ old_string: 'name', new_string: 'label', replace_all: true },
			],
		}
		const replayed = replay(body, call, 12_000)
		expect(replayed.outcome).toBe('replayed')
		if (replayed.outcome !== 'replayed') return
		expect(replayed.content.length).toBe(11_210)
		expect(replayed.charged).toBe(11_210)
	})

	it('never charges a negative length, however impossible the call is', () => {
		// An anchor longer than the whole file: the replay fails, and a negative
		// charge would hand the caller back room it never had.
		expect(replay('ab', { old_string: 'abcdefghij', new_string: '' }, 100)).toMatchObject({
			outcome: 'failed',
			charged: 0,
		})
	})
})
