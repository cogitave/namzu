import { describe, expect, it } from 'vitest'

import { shellHookIfMatches } from '@namzu/sdk'

import { createHookPathFilter } from './hook-path-filter.js'

const cwd = '/work/app'
const filter = createHookPathFilter(cwd)
const matches = (rule: string, tool: string, input: unknown) =>
	shellHookIfMatches(rule, tool, input, filter)

describe('a hook filter on a file tool reads paths as the permission rules do', () => {
	it('runs an Edit filter for a file under the glob and not for another', () => {
		expect(matches('Edit(src/**/*.ts)', 'edit', { path: 'src/a/b.ts' })).toBe(true)
		expect(matches('Edit(src/**/*.ts)', 'edit', { path: 'docs/readme.md' })).toBe(false)
		expect(matches('Edit(src/**/*.ts)', 'edit', { path: 'src/a/b.md' })).toBe(false)
	})

	it('reads the same absolute and relative spellings as one file', () => {
		expect(matches('Edit(src/**/*.ts)', 'edit', { path: '/work/app/src/x.ts' })).toBe(true)
		expect(matches('Edit(src/**/*.ts)', 'edit', { path: './src/x.ts' })).toBe(true)
	})

	it('covers write with an Edit filter, as the permission rules do', () => {
		expect(matches('Edit(src/**/*.ts)', 'write', { path: 'src/new.ts' })).toBe(true)
		expect(matches('Edit(src/**/*.ts)', 'read', { path: 'src/new.ts' })).toBe(false)
	})

	it('matches a dot file under a Read filter', () => {
		expect(matches('Read(*.env)', 'read', { path: 'prod.env' })).toBe(true)
		expect(matches('Read(*.env)', 'read', { path: 'prod.txt' })).toBe(false)
		expect(matches('Read(.env)', 'read', { path: '.env' })).toBe(true)
	})

	it('runs the hook when the call has no path, and for a tool whose paths no rule reads', () => {
		expect(matches('Edit(src/**/*.ts)', 'edit', {})).toBe(true)
		expect(matches('Bash(git push *)', 'bash', { command: 'git push origin main' })).toBe(true)
		expect(matches('Bash(git push *)', 'bash', { command: 'ls' })).toBe(false)
	})
})
