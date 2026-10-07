import { describe, expect, it } from 'vitest'
import {
	MAX_REFS,
	codeRef,
	createLinkCache,
	linkRef,
	pathCandidates,
	relativeProjectPath,
} from './project-refs.js'

describe('reply references', () => {
	it('collects local link targets and path-like code, once each', () => {
		const text = [
			'See [the plan](docs/plan.md) and [again](docs/plan.md), [web](https://example.test/a.md),',
			'[mail](mailto:a@b.c), [anchor](#top), [line](src/app.ts:42), [file](file:///work/x.ts).',
			'Edit `src/app.ts` and `README.md`, not `npm install` or `42`.',
		].join('\n')
		expect(pathCandidates(text)).toEqual([
			'docs/plan.md',
			'src/app.ts:42',
			'file:///work/x.ts',
			'src/app.ts',
			'README.md',
		])
	})
	it('ignores fenced code, including an unterminated fence', () => {
		const text = '```\n`src/a.ts` [x](b.md)\n```\n`kept.ts`\n~~~ts\n`gone.ts`\n'
		expect(pathCandidates(text)).toEqual(['kept.ts'])
	})
	it('decodes percent escapes and refuses schemes and options', () => {
		expect(linkRef('my%20notes.md')).toBe('my notes.md')
		expect(linkRef('C:\\work\\a.ts')).toBe('C:\\work\\a.ts')
		expect(linkRef('vscode://open?x=1')).toBeUndefined()
		expect(linkRef('--help')).toBeUndefined()
		expect(linkRef('a\u0000b')).toBeUndefined()
		expect(linkRef('https://example.test')).toBeUndefined()
		expect(linkRef(undefined)).toBeUndefined()
	})
	it('reads code spans as files only when they look like one', () => {
		expect(codeRef('packages/desktop/')).toBe('packages/desktop/')
		expect(codeRef('a.ts:3:4')).toBe('a.ts:3:4')
		expect(codeRef('a.ts#L10-L20')).toBe('a.ts#L10-L20')
		expect(codeRef('some words.ts')).toBeUndefined()
		expect(codeRef('v1.2')).toBeUndefined()
		expect(codeRef('https://example.test/a')).toBeUndefined()
		expect(codeRef('--flag')).toBeUndefined()
		expect(codeRef('pnpm')).toBeUndefined()
	})
	it('never asks for more than the host allows', () => {
		const text = Array.from({ length: MAX_REFS + 50 }, (_, i) => `\`dir/f${i}.ts\``).join(' ')
		expect(pathCandidates(text)).toHaveLength(MAX_REFS)
	})
})

describe('document links', () => {
	it('normalises against the file folder and stays inside the project', () => {
		expect(relativeProjectPath('docs/guide/a.md', 'b.md')).toBe('docs/guide/b.md')
		expect(relativeProjectPath('docs/guide/a.md', '../img/x.png#top')).toBe('docs/img/x.png')
		expect(relativeProjectPath('a.md', './b/c.md?x=1')).toBe('b/c.md')
		expect(relativeProjectPath('docs/a.md', '../../etc/passwd')).toBeUndefined()
		expect(relativeProjectPath('a.md', '/etc/passwd')).toBeUndefined()
		expect(relativeProjectPath('a.md', 'C:/x')).toBeUndefined()
		expect(relativeProjectPath('a.md', '..\\x')).toBeUndefined()
		expect(relativeProjectPath('a.md', 'https://example.test/x')).toBeUndefined()
		expect(relativeProjectPath('a.md', '#section')).toBeUndefined()
		expect(relativeProjectPath('a.md', 'file:///x')).toBeUndefined()
	})
})

describe('link cache', () => {
	const make = (answers: Record<string, string | undefined>) => {
		const calls: string[][] = []
		let clock = 0
		const cache = createLinkCache(
			async (_project, refs) => {
				calls.push(refs)
				return refs.map((ref) => ({ ref, path: answers[ref] }))
			},
			() => clock,
			1000,
		)
		return {
			cache,
			calls,
			advance: (ms: number) => {
				clock += ms
			},
		}
	}
	it('asks once for a batch and not again for answered references', async () => {
		const { cache, calls } = make({ 'a.ts': 'a.ts', 'b.ts': 'src/b.ts' })
		const first = await cache.resolve('p', ['a.ts', 'b.ts', 'nope.ts'])
		expect([...first.keys()]).toEqual(['a.ts', 'b.ts'])
		expect(first.get('b.ts')?.path).toBe('src/b.ts')
		await cache.resolve('p', ['a.ts', 'nope.ts'])
		expect(calls).toEqual([['a.ts', 'b.ts', 'nope.ts']])
	})
	it('shares one in-flight call between callers', async () => {
		const { cache, calls } = make({ 'a.ts': 'a.ts' })
		await Promise.all([cache.resolve('p', ['a.ts']), cache.resolve('p', ['a.ts'])])
		expect(calls).toHaveLength(1)
	})
	it('sends references asked in the same tick as one call per project', async () => {
		const { cache, calls } = make({ 'a.ts': 'a.ts', 'b.ts': 'b.ts' })
		const [one, two] = await Promise.all([
			cache.resolve('p', ['a.ts']),
			cache.resolve('p', ['a.ts', 'b.ts']),
		])
		expect(calls).toEqual([['a.ts', 'b.ts']])
		expect([...one.keys()]).toEqual(['a.ts'])
		expect([...two.keys()]).toEqual(['a.ts', 'b.ts'])
	})
	it('asks again about a missing file once the negative answer expires', async () => {
		const { cache, calls, advance } = make({})
		await cache.resolve('p', ['new.ts'])
		advance(999)
		await cache.resolve('p', ['new.ts'])
		expect(calls).toHaveLength(1)
		advance(2)
		await cache.resolve('p', ['new.ts'])
		expect(calls).toHaveLength(2)
	})
	it('keeps projects apart and does not cache a failed call', async () => {
		let fail = true
		const cache = createLinkCache(async (_project, refs) => {
			if (fail) throw new Error('down')
			return refs.map((ref) => ({ ref, path: ref }))
		})
		expect((await cache.resolve('p', ['a.ts'])).size).toBe(0)
		fail = false
		expect((await cache.resolve('p', ['a.ts'])).size).toBe(1)
		expect((await cache.resolve('q', ['a.ts'])).size).toBe(1)
	})
})
