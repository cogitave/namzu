import { describe, expect, it } from 'vitest'

import { joinPosix, relativePosix, resolveWithinPosix } from '../posix-path.js'

/**
 * A sandbox is a POSIX filesystem whatever the host runs, so resolving its
 * paths with the host's path module rewrites them whenever the two
 * disagree — on a Windows host `resolve('/workspace')` becomes
 * `C:\workspace`, and a container path stops being a container path. The
 * tool then hands the model a string its own sandbox cannot open.
 *
 * Found while testing the sandboxed search: the fake sandbox returned
 * nothing at all, because the paths it was asked for had been rewritten
 * into host shape on the way through.
 */

describe('joinPosix', () => {
	it('joins and keeps the leading slash', () => {
		expect(joinPosix('/work', 'src', 'a.ts')).toBe('/work/src/a.ts')
	})

	it('normalises . and ..', () => {
		expect(joinPosix('/work', 'src/../lib/a.ts')).toBe('/work/lib/a.ts')
	})

	it('collapses repeated separators', () => {
		expect(joinPosix('/work//', '/src//a.ts')).toBe('/work/src/a.ts')
	})

	it('leaves a relative base relative', () => {
		expect(joinPosix('work', 'a.ts')).toBe('work/a.ts')
	})

	it('never produces a host-shaped path', () => {
		// The whole point: this must not become `C:\work\a.ts` anywhere.
		expect(joinPosix('/work', 'a.ts')).not.toContain('\\')
	})
})

describe('relativePosix', () => {
	it('strips a shared prefix', () => {
		expect(relativePosix('/work', '/work/src/a.ts')).toBe('src/a.ts')
	})

	it('returns empty for the root itself', () => {
		expect(relativePosix('/work', '/work')).toBe('')
	})

	it('climbs out when it has to', () => {
		expect(relativePosix('/work/src', '/work/lib/a.ts')).toBe('../lib/a.ts')
	})

	it('does not treat a prefix-sharing sibling as inside', () => {
		expect(relativePosix('/work', '/work-backup/a.ts').startsWith('..')).toBe(true)
	})
})

describe('resolveWithinPosix', () => {
	it('accepts a path inside the root', () => {
		expect(resolveWithinPosix('/work', 'src/a.ts')).toBe('/work/src/a.ts')
	})

	it('treats an absent path as the root', () => {
		expect(resolveWithinPosix('/work', undefined)).toBe('/work')
	})

	it('refuses a climb out', () => {
		expect(() => resolveWithinPosix('/work', '../../etc')).toThrow(/escapes the working directory/)
	})

	it('refuses a prefix-sharing sibling', () => {
		expect(() => resolveWithinPosix('/work', '../work-backup')).toThrow(/escapes/)
	})

	it('takes an absolute candidate as sandbox-absolute', () => {
		expect(resolveWithinPosix('/work', '/work/src')).toBe('/work/src')
		expect(() => resolveWithinPosix('/work', '/etc/passwd')).toThrow(/escapes/)
	})

	it('allows a climb that lands back inside', () => {
		expect(resolveWithinPosix('/work', 'src/../lib')).toBe('/work/lib')
	})
})
