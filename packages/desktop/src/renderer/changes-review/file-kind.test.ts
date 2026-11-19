import { describe, expect, it } from 'vitest'
import { fileKind, groupByKind } from './file-kind.js'

describe('file kinds', () => {
	it.each([
		['src/app.ts', 'source'],
		['src/app.test.ts', 'test'],
		['tests/helpers/db.py', 'test'],
		['pkg/__snapshots__/a.snap', 'test'],
		['web/button.stories.tsx', 'test'],
		['BUILD.bazel', 'build'],
		['tools/rules.bzl', 'build'],
		['pnpm-lock.yaml', 'generated'],
		['apps/web/package-lock.json', 'generated'],
		['dist/index.js', 'generated'],
		['src/api.pb.go', 'generated'],
		['public/app.min.js', 'generated'],
		['src/generated/schema.ts', 'generated'],
	])('%s is %s', (path, kind) => {
		expect(fileKind(path)).toBe(kind)
	})

	it('takes generated before build before test', () => {
		expect(fileKind('dist/BUILD')).toBe('generated')
		expect(fileKind('tests/BUILD')).toBe('build')
	})

	it('keeps one group, in order, when not separating', () => {
		const files = [{ path: 'a.test.ts' }, { path: 'b.ts' }]
		expect(groupByKind(files, false)).toEqual([{ kind: 'source', files }])
	})

	it('sorts source, test, build, generated and names the headings', () => {
		const files = [
			{ path: 'yarn.lock' },
			{ path: 'a.test.ts' },
			{ path: 'b.ts' },
			{ path: 'BUILD' },
			{ path: 'c.ts' },
		]
		const groups = groupByKind(files, true)
		expect(groups.map((group) => [group.heading, group.files.map((file) => file.path)])).toEqual([
			[undefined, ['b.ts', 'c.ts']],
			['Test files', ['a.test.ts']],
			['Build files', ['BUILD']],
			['Generated files', ['yarn.lock']],
		])
	})
})
