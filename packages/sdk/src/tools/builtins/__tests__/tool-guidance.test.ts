import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { estimateTextTokens } from '../../../compaction/token-estimate.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'
import { EditTool } from '../edit.js'
import { GlobTool } from '../glob.js'
import { GrepTool } from '../grep.js'
import { ReadFileTool } from '../read-file.js'

/**
 * What the built-in tools tell the model about each other, and what it costs.
 */

/** The three descriptions before the guidance was added, in estimated tokens (characters / 4). */
const BEFORE_TOKENS = 98 + 243 + 94
/** What the guidance may add across all of them. */
const BUDGET_TOKENS = 250

function makeContext(workingDirectory: string): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('the tool guidance', () => {
	it('grows the shell, grep and glob descriptions by less than the budget', () => {
		const now = [BashTool, GrepTool, GlobTool].reduce(
			(sum, tool) => sum + estimateTextTokens(tool.description),
			0,
		)
		expect(now).toBeGreaterThan(BEFORE_TOKENS)
		expect(now - BEFORE_TOKENS).toBeLessThanOrEqual(BUDGET_TOKENS)
	})

	it('has the shell tool send reading and searching to the dedicated tools, and say why', () => {
		expect(BashTool.description).toContain('`read`, `grep` and `glob`')
		expect(BashTool.description).toContain('earns no read credit')
		expect(BashTool.description).toContain('refused once')
	})

	it('has the shell tool say to run a check on its own, because a pipe hides the status', () => {
		expect(BashTool.description).toContain('never piped through tail, head or grep')
		expect(BashTool.description).toContain('already trimmed')
		expect(BashTool.description).toContain('hides the exit status')
	})

	it('has the search tools name each other and no sub-agent', () => {
		expect(GrepTool.description).toContain('use glob')
		expect(GlobTool.description).toContain('use grep')
		for (const tool of [BashTool, GrepTool, GlobTool, EditTool, ReadFileTool]) {
			expect(tool.description.toLowerCase()).not.toMatch(/sub-?agent/)
		}
	})
})

describe('the edit tool when the text is not found or not unique', () => {
	function fileWith(text: string) {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-hint-'))
		writeFileSync(join(dir, 'a.ts'), text)
		return makeContext(dir)
	}

	it('names the line of a near match and says to read again, keeping the reason code', async () => {
		const context = fileWith('function a() {\n    return 1\n}\n')
		const result = await EditTool.execute(
			{ path: 'a.ts', old_string: '  return   1', new_string: 'return 2' },
			context,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('not found in file')
		expect(result.error).toContain('including whitespace and indentation')
		expect(result.error).toContain('line 2')
		expect(result.error).toContain('read around it again')
	})

	it('says to read again when nothing is near', async () => {
		const context = fileWith('one\ntwo\n')
		const result = await EditTool.execute(
			{ path: 'a.ts', old_string: 'absent text', new_string: 'x' },
			context,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('Read the lines you mean to change again')
		expect(result.error).not.toMatch(/is at line/)
	})

	it('keeps the uniqueness rule and adds a hint to read around the matches', async () => {
		const context = fileWith('x = 1\ny = 2\nx = 1\n')
		const result = await EditTool.execute(
			{ path: 'a.ts', old_string: 'x = 1', new_string: 'x = 3' },
			context,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('is not unique — found at lines 1 and 3')
		expect(result.error).toContain('replace_all: true')
		expect(result.error).toContain('Read around those lines again')
	})
})

describe('what read marks as a cut', () => {
	function lines(n: number) {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-mark-'))
		writeFileSync(
			join(dir, 'f.txt'),
			`${Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n')}\n`,
		)
		return makeContext(dir)
	}

	it('marks a window the caller asked for as asked, not as a partial view', async () => {
		const asked = await ReadFileTool.execute({ path: 'f.txt', limit: 5 }, lines(50))
		expect(asked.output).toContain('[Lines 1-5 of 50, as asked.]')
		expect(asked.output).not.toContain('PARTIAL')
	})

	it('still marks the cut the default cap imposed as a partial view', async () => {
		const capped = await ReadFileTool.execute({ path: 'f.txt' }, lines(2500))
		expect(capped.output).toContain('[PARTIAL view — lines 1-2000 of 2500.')
		expect(capped.output).toContain('read({ offset: 2000, limit: N })')
	})
})
