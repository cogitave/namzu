/**
 * Which files make up the instructions, and in what order.
 *
 * The order is the override semantics (later wins), so most of these pin an
 * order. The rest pin the includes: how deep, that a loop ends, that code is
 * not an include, and that a path leaving the allowed folders is refused and
 * reported rather than read.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolResultObservation } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { globToRegExp } from '../instruction-glob.js'
import { extractImportTokens, loadProjectInstructions } from '../instruction-scope.js'
import { ProjectInstructionTracker } from '../project-tracker.js'
import { stripHtmlComments } from '../project.js'

let base: string
let repo: string
let pkg: string
let home: string

function put(path: string, text: string): void {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, text)
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), 'namzu-sources-'))
	repo = join(base, 'repo')
	pkg = join(repo, 'pkg')
	home = join(base, 'home', '.namzu')
	mkdirSync(join(repo, '.git'), { recursive: true })
	mkdirSync(pkg, { recursive: true })
	mkdirSync(home, { recursive: true })
})

afterEach(() => removeTempDir(base))

function names(files: readonly { readonly path: string }[]): string[] {
	return files.map((file) => file.path.replace(`${base}/`, ''))
}

describe('what a scope contributes, in order', () => {
	it('puts the person file first, then each directory from the root down, local file last in its directory', () => {
		put(join(home, 'AGENTS.md'), 'mine')
		put(join(repo, 'AGENTS.md'), 'repo')
		put(join(repo, 'AGENTS.local.md'), 'repo private')
		put(join(pkg, 'AGENTS.md'), 'pkg')

		const loaded = loadProjectInstructions(pkg, { userHome: home })

		expect(names(loaded.files)).toEqual([
			'home/.namzu/AGENTS.md',
			'repo/AGENTS.md',
			'repo/AGENTS.local.md',
			'repo/pkg/AGENTS.md',
		])
		expect(loaded.files.map((file) => file.kind)).toEqual(['user', 'project', 'local', 'project'])
	})

	it('reads rule files between the project file and the local file, sorted by path', () => {
		put(join(repo, 'AGENTS.md'), 'repo')
		put(join(repo, '.namzu', 'rules', 'b.md'), 'rule b')
		put(join(repo, '.namzu', 'rules', 'a', 'z.md'), 'rule az')
		put(join(repo, '.namzu', 'rules', 'a.md'), 'rule a')
		put(join(repo, '.namzu', 'rules', 'notes.txt'), 'not a rule')
		put(join(repo, 'AGENTS.local.md'), 'private')

		const loaded = loadProjectInstructions(repo, { userHome: null })

		expect(names(loaded.files)).toEqual([
			'repo/AGENTS.md',
			'repo/.namzu/rules/a/z.md',
			'repo/.namzu/rules/a.md',
			'repo/.namzu/rules/b.md',
			'repo/AGENTS.local.md',
		])
	})

	it('loads the person rules folder too', () => {
		put(join(home, 'rules', 'style.md'), 'short sentences')
		const loaded = loadProjectInstructions(repo, { userHome: home })
		expect(names(loaded.files)).toEqual(['home/.namzu/rules/style.md'])
	})

	it('does not read the person file when none is configured', () => {
		put(join(home, 'AGENTS.md'), 'mine')
		expect(loadProjectInstructions(repo, { userHome: null }).files).toEqual([])
	})
})

describe('@path includes', () => {
	it('puts an included file right after the file that names it, relative to that file', () => {
		put(join(repo, 'AGENTS.md'), 'root\n@docs/style.md\nafter')
		put(join(repo, 'docs', 'style.md'), 'style text\n@./more.md')
		put(join(repo, 'docs', 'more.md'), 'more text')
		put(join(repo, 'AGENTS.local.md'), 'private')

		const loaded = loadProjectInstructions(repo, { userHome: null })

		expect(names(loaded.files)).toEqual([
			'repo/AGENTS.md',
			'repo/docs/style.md',
			'repo/docs/more.md',
			'repo/AGENTS.local.md',
		])
		expect(loaded.files[1]?.kind).toBe('import')
		expect(loaded.files[1]?.importedBy).toBe(join(repo, 'AGENTS.md'))
	})

	it('follows five levels below the first file and no further', () => {
		put(join(repo, 'AGENTS.md'), '@l1.md')
		for (let level = 1; level <= 7; level += 1) {
			put(join(repo, `l${level}.md`), `level ${level}\n@l${level + 1}.md`)
		}

		const loaded = loadProjectInstructions(repo, { userHome: null })

		expect(names(loaded.files).map((name) => name.replace('repo/', ''))).toEqual([
			'AGENTS.md',
			'l1.md',
			'l2.md',
			'l3.md',
			'l4.md',
			'l5.md',
		])
	})

	it('ends a loop and takes a file reached twice once', () => {
		put(join(repo, 'AGENTS.md'), '@a.md\n@b.md')
		put(join(repo, 'a.md'), 'a\n@b.md\n@AGENTS.md')
		put(join(repo, 'b.md'), 'b\n@a.md')

		const loaded = loadProjectInstructions(repo, { userHome: null })

		expect(names(loaded.files)).toEqual(['repo/AGENTS.md', 'repo/a.md', 'repo/b.md'])
	})

	it('treats a mention inside code as text', () => {
		put(join(repo, 'AGENTS.md'), 'use `@real.md` literally\n```\n@real.md\n```\nthanks')
		put(join(repo, 'real.md'), 'real')
		expect(names(loadProjectInstructions(repo, { userHome: null }).files)).toEqual([
			'repo/AGENTS.md',
		])
		expect(extractImportTokens('a@b.md and @c.md')).toEqual(['c.md'])
	})

	it('ignores a name that is not a file, silently', () => {
		put(join(repo, 'AGENTS.md'), 'ask @someone about @missing.md')
		const loaded = loadProjectInstructions(repo, { userHome: null })
		expect(names(loaded.files)).toEqual(['repo/AGENTS.md'])
		expect(loaded.skipped).toEqual([])
	})

	it('refuses a path that leaves the project and says so', () => {
		put(join(base, 'secret.md'), 'do not send')
		put(join(repo, 'AGENTS.md'), 'see @../secret.md and @~/notes.md')
		put(join(base, 'home', 'notes.md'), 'home notes')

		const loaded = loadProjectInstructions(repo, { userHome: null })

		expect(names(loaded.files)).toEqual(['repo/AGENTS.md'])
		expect(loaded.files.map((file) => file.text).join('\n')).not.toContain('do not send')
		expect(loaded.skipped.map((entry) => entry.reason).join('\n')).toContain('outside the folders')
	})

	it('lets the person file include notes from their home folder', () => {
		put(join(home, 'AGENTS.md'), '@../notes.md')
		put(join(base, 'home', 'notes.md'), 'home notes')
		// The test home is not the OS home, so only the Namzu home itself is allowed here.
		put(join(home, 'inner.md'), 'inner')
		put(join(home, 'AGENTS.md'), '@inner.md')

		const loaded = loadProjectInstructions(repo, { userHome: home })

		expect(names(loaded.files)).toEqual(['home/.namzu/AGENTS.md', 'home/.namzu/inner.md'])
	})

	it('drops HTML comments outside code and keeps those inside it', () => {
		const text =
			'a <!-- hidden --> b\n<!--\nmulti\nline\n-->\nc `<!-- kept -->`\n```\n<!-- fenced -->\n```'
		expect(stripHtmlComments(text)).toBe(
			'a  b\n\n\n\n\nc `<!-- kept -->`\n```\n<!-- fenced -->\n```',
		)
	})
})

describe('conditional rules', () => {
	it('stay out until the session touches a matching file', async () => {
		put(join(repo, 'AGENTS.md'), 'root')
		put(
			join(repo, '.namzu', 'rules', 'ts.md'),
			'---\npaths:\n  - "src/**/*.ts"\n---\nTypeScript rule',
		)
		put(join(repo, '.namzu', 'rules', 'always.md'), '---\npaths: "**"\n---\nAlways rule')
		put(join(repo, 'src', 'deep', 'a.ts'), 'x')
		put(join(repo, 'docs', 'a.md'), 'x')

		const tracker = new ProjectInstructionTracker(repo, { userHome: null })
		const context = tracker.createTurnContext()
		const first = await context.prepareInitialSnapshot?.({
			messages: [],
			signal: new AbortController().signal,
		})
		const text = (m: unknown): string => String((m as { content?: unknown } | null)?.content ?? '')
		expect(text(first)).toContain('Always rule')
		expect(text(first)).not.toContain('TypeScript rule')
		expect(text(first)).not.toContain('paths:')

		const observe = (path: string) =>
			context.observeToolResult(
				{
					sessionId: '0199a7c0-0000-7000-8000-000000000001',
					turnId: '734ba918-6df1-446e-81ac-ab3dbf64dca1',
					toolUseId: 'call',
					toolName: 'read',
					input: { path },
					result: { success: true, output: 'ok' },
				} as unknown as ToolResultObservation,
				{ messages: first ? [first] : [], signal: new AbortController().signal },
			)

		expect(await observe(join(repo, 'docs', 'a.md'))).toBeUndefined()
		expect(text(await observe(join(repo, 'src', 'deep', 'a.ts')))).toContain('TypeScript rule')
	})

	it('translates a glob', () => {
		expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
		expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true)
		expect(globToRegExp('src/**/*.ts').test('lib/a.ts')).toBe(false)
		expect(globToRegExp('docs/*.{md,mdx}').test('docs/a.mdx')).toBe(true)
		expect(globToRegExp('docs/*.{md,mdx}').test('docs/x/a.md')).toBe(false)
	})
})

describe('the tracker prompt', () => {
	it('names the person file with a tilde, labels the private file and the include, and keeps provenance as scopes', async () => {
		put(join(home, 'AGENTS.md'), 'my habit')
		put(join(repo, 'AGENTS.md'), 'root\n@docs/x.md')
		put(join(repo, 'docs', 'x.md'), 'included text')
		put(join(pkg, 'AGENTS.local.md'), 'pkg private')

		const tracker = new ProjectInstructionTracker(pkg, { userHome: home })
		const snapshot = tracker.prepareSnapshot([])
		const content = String(snapshot?.content ?? '')

		expect(content.indexOf('my habit')).toBeLessThan(content.indexOf('root'))
		expect(content.indexOf('root')).toBeLessThan(content.indexOf('included text'))
		expect(content.indexOf('included text')).toBeLessThan(content.indexOf('pkg private'))
		expect(content).toContain('Applies to every project.')
		expect(content).toContain('Included from `AGENTS.md`.')
		expect(content).toContain('This file is private to this checkout.')
		expect(snapshot?.source?.type === 'project-instructions' && snapshot.source.files).toEqual([
			'AGENTS.md',
			'pkg/AGENTS.md',
		])
		expect(tracker.instructionFiles.map((file) => file.replace(`${base}/`, ''))).toEqual([
			'home/.namzu/AGENTS.md',
			'repo/AGENTS.md',
			'repo/pkg/AGENTS.local.md',
		])
	})

	it('still works with only the person file', () => {
		put(join(home, 'AGENTS.md'), 'my habit')
		const snapshot = new ProjectInstructionTracker(repo, { userHome: home }).prepareSnapshot([])
		expect(String(snapshot?.content)).toContain('my habit')
		expect(snapshot?.source?.type === 'project-instructions' && snapshot.source.files).toEqual([
			'AGENTS.md',
		])
	})
})
