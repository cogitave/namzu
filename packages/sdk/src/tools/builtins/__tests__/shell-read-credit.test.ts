import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { GUARD_TEMP_DIR_ENV, pathOutsideRoots, toolRoots } from '../../paths.js'
import { BashTool } from '../bash.js'
import { EditTool } from '../edit.js'
import { creditShellReads, shellShownFiles } from '../shell-read-credit.js'

const whole = (operand: string) => ({ operand, full: true })
const window = (operand: string) => ({ operand, full: false })

describe('which files a shell line shows', () => {
	it.each([
		['cat src/a.ts', [whole('src/a.ts')]],
		['nl src/a.ts', [whole('src/a.ts')]],
		['sed -n 1,40p src/a.ts', [window('src/a.ts')]],
		['sed -n p src/a.ts', [whole('src/a.ts')]],
		['cat src/a.ts && cat src/b.ts', [whole('src/a.ts'), whole('src/b.ts')]],
		['head src/a.ts', [window('src/a.ts')]],
		['head -n 20 src/a.ts', [window('src/a.ts')]],
		['tail -n 3 src/a.ts', [window('src/a.ts')]],
		['cat f.txt && echo x >> f.txt', []],
		['cat f.txt > g.txt', []],
		['cat f.txt | tee f.txt', []],
		['cat f.txt; python rewrite.py f.txt', []],
		['sed s/a/b/ src/a.ts', []],
		['sed -n w/out src/a.ts', []],
		['awk 1 src/a.ts', []],
		['cat src/a.ts 2>&1', [whole('src/a.ts')]],
		['cat src/a.ts && echo done', [whole('src/a.ts')]],
		['less src/a.ts', [whole('src/a.ts')]],
		['grep foo src/a.ts', []],
		['cat "$FILE"', []],
		['sed -i s/a/b/ src/a.ts', []],
		['cat ~/notes.txt', []],
		['cat src/*.ts', []],
		// A piped printer is a window; a pipe into anything but a printer earns nothing.
		['cat src/a.ts | head -20', [window('src/a.ts')]],
		['cat src/a.ts | grep foo', []],
		// A leading `cd` moves the operands after it, only when `&&` joins them.
		['cd lib && cat a.ts', [whole('lib/a.ts')]],
		[
			'cd /w/x && cat package.json && echo ---- && cat src/stats.js',
			[whole('/w/x/package.json'), whole('/w/x/src/stats.js')],
		],
		['cd lib; cat a.ts', []],
		['cd "$D" && cat a.ts', []],
		['cd lib || cat a.ts', []],
		['cat a.ts || cat b.ts', []],
		// A listing changes nothing, so it may share the line.
		['cat bin/scores.js; ls -la bin; ls', [whole('bin/scores.js')]],
		['cat a.ts; rm a.ts', []],
	])('%s', (line, expected) => {
		expect(shellShownFiles(line, false)).toEqual(expected)
	})
})

describe('a shell read counts as a read', () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-shell-read-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const contextOf = (tracker: ReturnType<typeof createFileReadTracker>): ToolContext =>
		({
			sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
			turnId: '9bf74d42-964f-4a93-aabb-d20245d81daf',
			workingDirectory: dir,
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
			fileReadTracker: tracker,
		}) as unknown as ToolContext

	it('lets an edit through after `cat`, and refuses a missing text in a file never shown', async () => {
		await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
		await writeFile(join(dir, 'b.txt'), 'one\ntwo\n')
		const tracker = createFileReadTracker()
		const context = contextOf(tracker)

		const ran = await BashTool.execute({ command: 'sed -n 1,2p a.txt', timeout: 10_000 }, context)
		expect(ran.success).toBe(true)

		const edited = await EditTool.execute(
			{ path: 'a.txt', old_string: 'two', new_string: 'three', replace_all: false },
			context,
		)
		expect(edited.success).toBe(true)
		expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('one\nthree\n')

		// A file never shown is read by the edit itself: a text that is not in it is refused.
		const unread = await EditTool.execute(
			{ path: 'b.txt', old_string: 'twelve', new_string: 'three', replace_all: false },
			contextOf(createFileReadTracker()),
		)
		expect(unread.success).toBe(false)
	})

	it('lets the first edit through after the exact line a model wrote: cd, then cat with echo between', async () => {
		await mkdir(join(dir, 'src'))
		await writeFile(join(dir, 'package.json'), '{}\n')
		await writeFile(join(dir, 'src', 'stats.js'), 'export const n = 1\n')
		const tracker = createFileReadTracker()
		const context = contextOf(tracker)
		const ran = await BashTool.execute(
			{
				command: `cd ${dir} && cat package.json && echo ---- && cat src/stats.js`,
				timeout: 10_000,
			},
			context,
		)
		expect(ran.success).toBe(true)
		const edited = await EditTool.execute(
			{ path: 'src/stats.js', old_string: '= 1', new_string: '= 2', replace_all: false },
			context,
		)
		expect(edited.success).toBe(true)
		expect(await readFile(join(dir, 'src', 'stats.js'), 'utf-8')).toBe('export const n = 2\n')
	})

	it('counts a listing on the same line, and a partial print as enough for edit', async () => {
		await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
		const tracker = createFileReadTracker()
		const context = contextOf(tracker)
		await BashTool.execute({ command: 'head -n 1 a.txt; ls', timeout: 10_000 }, context)
		expect(tracker.hasRead(join(dir, 'a.txt'))).toBe(true)
		// A window is not a whole body.
		expect(tracker.fullBody?.(join(dir, 'a.txt'))).toBeUndefined()
		const edited = await EditTool.execute(
			{ path: 'a.txt', old_string: 'three', new_string: '3', replace_all: false },
			context,
		)
		expect(edited.success).toBe(true)
	})

	it('records a whole print as a full body, and a later window does not drop it', async () => {
		await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
		const tracker = createFileReadTracker()
		const context = contextOf(tracker)
		await BashTool.execute({ command: 'cat a.txt', timeout: 10_000 }, context)
		expect(tracker.fullBody?.(join(dir, 'a.txt'))).toBe('one\ntwo\n')
		await BashTool.execute({ command: 'head -n 1 a.txt', timeout: 10_000 }, context)
		expect(tracker.fullBody?.(join(dir, 'a.txt'))).toBe('one\ntwo\n')
	})

	it('refuses an edit as stale when the file changed after it was printed', async () => {
		await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
		const tracker = createFileReadTracker()
		const context = contextOf(tracker)
		await BashTool.execute({ command: 'cat a.txt', timeout: 10_000 }, context)
		await writeFile(join(dir, 'a.txt'), 'one\ntwo changed elsewhere\n')
		const edited = await EditTool.execute(
			{ path: 'a.txt', old_string: 'one', new_string: '1', replace_all: false },
			context,
		)
		expect(edited.success).toBe(false)
		expect(edited.error).toContain('changed on disk after you read it')
	})

	it('earns nothing from a failed cat, a glob, or a pipe into a filter', async () => {
		await writeFile(join(dir, 'a.txt'), 'one\n')
		const tracker = createFileReadTracker()
		const context = contextOf(tracker)
		const failed = await BashTool.execute({ command: 'cat missing.txt', timeout: 10_000 }, context)
		expect(failed.success).toBe(false)
		await BashTool.execute({ command: 'cat *.txt', timeout: 10_000 }, context)
		await BashTool.execute({ command: 'cat a.txt | grep one', timeout: 10_000 }, context)
		expect(tracker.hasRead(join(dir, 'a.txt'))).toBe(false)
		expect(tracker.hasRead(join(dir, 'missing.txt'))).toBe(false)
	})

	it('earns nothing for a line that also rewrites the file it prints', async () => {
		await writeFile(join(dir, 'a.txt'), 'one\n')
		const tracker = createFileReadTracker()
		await creditShellReads('cat a.txt && echo x >> a.txt', contextOf(tracker), dir)
		expect(tracker.hasRead(join(dir, 'a.txt'))).toBe(false)
	})

	it('earns nothing when the command failed or the path is unreadable', async () => {
		const tracker = createFileReadTracker()
		await creditShellReads('cat missing.txt', contextOf(tracker), dir)
		expect(tracker.hasRead(join(dir, 'missing.txt'))).toBe(false)
	})
})

describe('the temporary directory is exempt from the path guard', () => {
	const previous = process.env[GUARD_TEMP_DIR_ENV]
	beforeEach(() => {
		process.env[GUARD_TEMP_DIR_ENV] = ''
	})
	afterEach(() => {
		if (previous === undefined) process.env[GUARD_TEMP_DIR_ENV] = undefined
		else process.env[GUARD_TEMP_DIR_ENV] = previous
		if (previous === undefined) Reflect.deleteProperty(process.env, GUARD_TEMP_DIR_ENV)
	})

	it('reaches the temp directory and nothing wider', async () => {
		const work = await mkdtemp(join(process.cwd(), '.namzu-guard-'))
		try {
			await mkdir(join(work, 'x'), { recursive: true })
			const roots = toolRoots({ workingDirectory: work })
			expect(await pathOutsideRoots(roots, join(tmpdir(), 'scratch', 'out.txt'))).toBeUndefined()
			expect(await pathOutsideRoots(roots, '/')).toBeDefined()
			expect(await pathOutsideRoots(roots, '/etc/hosts')).toBeDefined()
			// A sibling that merely shares the temp directory's prefix is outside. Not the
			// home folder: a runner may place HOME under the temp directory itself.
			expect(await pathOutsideRoots(roots, `${tmpdir()}-sibling/x`)).toBeDefined()
		} finally {
			await rm(work, { recursive: true, force: true })
		}
	})

	it('can be switched off', async () => {
		process.env[GUARD_TEMP_DIR_ENV] = '1'
		const roots = toolRoots({ workingDirectory: '/srv/project' })
		expect(await pathOutsideRoots(roots, join(tmpdir(), 'x'))).toBeDefined()
	})
})
