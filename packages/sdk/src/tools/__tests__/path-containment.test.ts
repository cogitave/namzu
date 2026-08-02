import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolContext } from '../../types/tool/index.js'
import { GlobTool } from '../builtins/glob.js'
import { GrepTool } from '../builtins/grep.js'
import { LsTool } from '../builtins/ls.js'
import { matchesGlob } from '../glob-match.js'
import { resolveWithin } from '../paths.js'

/**
 * The containment rule existed — in one private function inside the local
 * sandbox provider — and the filesystem tools never reached it. They
 * resolved a caller-supplied path against the working directory bare, so
 * `path: "../../.."` landed wherever that pointed and the tool read it
 * happily.
 *
 * That holds with no sandbox configured at all, which is the common case,
 * so the escape needed no misconfiguration to reach: a model that asks for
 * a parent directory gets one. And `grep` returns file CONTENT, so what
 * escaped was not a listing.
 */

let root: string
let outside: string

beforeEach(() => {
	const base = mkdtempSync(join(tmpdir(), 'namzu-containment-'))
	root = join(base, 'workspace')
	outside = join(base, 'secrets')
	mkdirSync(root, { recursive: true })
	mkdirSync(outside, { recursive: true })
	writeFileSync(join(root, 'inside.ts'), 'const inside = true\n')
	writeFileSync(join(outside, 'credentials.txt'), 'SECRET_TOKEN=hunter2\n')
})

afterEach(() => {
	rmSync(resolve(root, '..'), { recursive: true, force: true })
})

const context = (): ToolContext =>
	({
		workingDirectory: root,
		env: {},
		abortSignal: new AbortController().signal,
	}) as unknown as ToolContext

describe('resolveWithin', () => {
	it('accepts a path inside the root', () => {
		expect(resolveWithin('/work', 'src/a.ts')).toBe(resolve('/work/src/a.ts'))
	})

	it('treats an absent path as the root itself', () => {
		expect(resolveWithin('/work', undefined)).toBe(resolve('/work'))
	})

	it('refuses a climb out', () => {
		expect(() => resolveWithin('/work', '../../..')).toThrow(/escapes the working directory/)
	})

	it('refuses an absolute path elsewhere', () => {
		expect(() => resolveWithin('/work', '/etc/passwd')).toThrow(/escapes the working directory/)
	})

	it('refuses a sibling that merely shares a prefix', () => {
		// A `startsWith` test would call this inside, which is the whole
		// reason the check uses `relative`.
		expect(() => resolveWithin('/work', '../work-backup')).toThrow(/escapes/)
	})

	it('allows a climb that lands back inside', () => {
		expect(resolveWithin('/work', 'src/../lib/a.ts')).toBe(resolve('/work/lib/a.ts'))
	})
})

describe('glob', () => {
	it('refuses a path that climbs out', async () => {
		const result = await GlobTool.execute(
			{ pattern: '*.txt', path: '../secrets' } as never,
			context(),
		)
		// A refusal reaches the model as a failed tool result rather than a
		// throw, so it can read WHY and correct itself.
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})

	it('refuses an escape hidden in the pattern', async () => {
		// The base directory lifted out of a pattern is caller-supplied too.
		const result = await GlobTool.execute({ pattern: '../secrets/**/*.txt' } as never, context())
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})

	it('still finds what is inside', async () => {
		const result = await GlobTool.execute({ pattern: '**/*.ts' } as never, context())
		expect(result.success).toBe(true)
		expect(result.output).toContain('inside.ts')
	})
})

describe('grep', () => {
	it('refuses a path that climbs out', async () => {
		const result = await GrepTool.execute(
			{
				pattern: 'SECRET',
				path: '../secrets',
				case_sensitive: true,
				context_lines: 0,
				max_results: 10,
			} as never,
			context(),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
		expect(JSON.stringify(result)).not.toContain('hunter2')
	})

	it('never returns content from outside the working directory', async () => {
		const result = await GrepTool.execute(
			{ pattern: 'SECRET', case_sensitive: true, context_lines: 0, max_results: 50 } as never,
			context(),
		)
		// grep returns file CONTENT, so an escape here reads rather than lists.
		expect(result.output).not.toContain('hunter2')
	})

	it('still finds what is inside', async () => {
		const result = await GrepTool.execute(
			{ pattern: 'inside', case_sensitive: true, context_lines: 0, max_results: 50 } as never,
			context(),
		)
		expect(result.output).toContain('inside.ts')
	})
})

describe('ls', () => {
	it('refuses a path that climbs out', async () => {
		const result = await LsTool.execute({ path: '../secrets' } as never, context())
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})
})

describe('glob matching', () => {
	it.each([
		['**/*.ts', 'src/a.ts', true],
		['**/*.ts', 'a.ts', true],
		['*.ts', 'a.ts', true],
		['*.ts', 'src/a.ts', false],
		['src/*.ts', 'src/a.ts', true],
		['src/*.ts', 'src/deep/a.ts', false],
		['**/*.ts', 'a.tsx', false],
		['a?.ts', 'ab.ts', true],
		['a?.ts', 'abc.ts', false],
	])('%s vs %s', (pattern, path, expected) => {
		expect(matchesGlob(path, pattern)).toBe(expected)
	})

	it('treats regex punctuation in a pattern as literal', () => {
		// A pattern is not a regex; `a.b` must not match `axb`.
		expect(matchesGlob('a.b.ts', 'a.b.ts')).toBe(true)
		expect(matchesGlob('axb.ts', 'a.b.ts')).toBe(false)
	})
})
