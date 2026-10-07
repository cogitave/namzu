import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { EditTool, dryRunEdit } from '../edit.js'

/**
 * The approval card shows `dryRunEdit`'s answer and the tool then runs
 * `execute`. Each case runs both on the same body and compares them, so a
 * shape or a line-ending mix that one reads differently fails here.
 */
function context(workingDirectory: string): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: 'b2f2f7b0-6a51-4f8b-9b9f-2a7e6f9c9f21' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

async function same(original: string, args: Record<string, unknown>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-dry-run-'))
	writeFileSync(join(dir, 'f.txt'), original)
	const input = { path: 'f.txt', ...args }
	const dry = dryRunEdit(original, input)
	const real = await EditTool.execute(input as never, context(dir))
	expect(dry.success).toBe(real.success)
	if (dry.success) expect(dry.content).toBe(readFileSync(join(dir, 'f.txt'), 'utf-8'))
	else expect(readFileSync(join(dir, 'f.txt'), 'utf-8')).toBe(original)
}

describe('dryRunEdit equals a real edit', () => {
	const cases: [string, string, Record<string, unknown>][] = [
		['single', 'a\nb\nc\n', { old_string: 'b', new_string: 'B' }],
		['aliases', 'a\nb\nc\n', { oldStr: 'b', newStr: 'B' }],
		['replace_all', 'x x x\n', { old_string: 'x', new_string: 'y', replace_all: true }],
		['ambiguous', 'x x\n', { old_string: 'x', new_string: 'y' }],
		['missing', 'a\n', { old_string: 'zz', new_string: 'y' }],
		['empty old_string', 'a\n', { old_string: '', new_string: 'y' }],
		['delete by empty new_string', 'a\nb\n', { old_string: 'b\n', new_string: '' }],
		['crlf lf anchor', 'a\r\nb\r\nc\r\n', { old_string: 'a\nb', new_string: 'x\ny' }],
		['crlf replace_all', 'a\r\na\r\n', { old_string: 'a\n', new_string: 'b\n', replace_all: true }],
		['crlf insert', 'a\r\nb\r\n', { insertLine: 1, new_string: 'm\nn' }],
		['crlf batch', 'a\r\nb\r\n', { edits: [{ old_string: 'a', new_string: 'x\ny' }] }],
		['mixed endings', 'a\r\nb\nc\r\n', { old_string: 'b\nc', new_string: 'q' }],
		['insert 0', 'a\n', { insertLine: 0, new_string: 'top' }],
		['insert end no newline', 'a', { insertLine: 'end', new_string: 'z' }],
		['insert past end', 'a\n', { insertLine: 99, new_string: 'z' }],
		['insert on empty file', '', { insertLine: 'end', new_string: 'z' }],
		['both shapes', 'a\n', { old_string: 'a', new_string: 'b', edits: [] }],
		['no-op in batch', 'a\nb\n', { edits: [{ old_string: 'a', new_string: 'a' }] }],
		['bom', '﻿a\n', { old_string: 'a', new_string: 'b' }],
		['dollar patterns', 'a\n', { old_string: 'a', new_string: "$& $1 $$ $'" }],
	]
	for (const [name, body, args] of cases) {
		it(name, async () => {
			await same(body, args)
		})
	}
})
