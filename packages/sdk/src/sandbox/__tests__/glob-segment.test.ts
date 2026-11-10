import { Minimatch } from 'minimatch'
import { describe, expect, it } from 'vitest'
import { compileSegment } from '../glob-segment.js'

const matches = (segment: string, name: string, dot = false) => {
	const { literal, source } = compileSegment(segment, dot)
	return literal !== null ? literal === name : new RegExp(source, 'us').test(name)
}

describe('compileSegment', () => {
	it('returns the plain name for a segment with no magic, honouring escapes', () => {
		expect(compileSegment('one.ts', false).literal).toBe('one.ts')
		expect(compileSegment('file\\[1\\].txt', false).literal).toBe('file[1].txt')
		expect(compileSegment('a b', false).literal).toBe('a b')
	})
	it('compiles wildcards, classes and POSIX classes', () => {
		expect(matches('*.ts', 'a.ts')).toBe(true)
		expect(matches('*.ts', 'a.js')).toBe(false)
		expect(matches('?x', 'ax')).toBe(true)
		expect(matches('?x', 'aax')).toBe(false)
		expect(matches('[!a]x', 'bx')).toBe(true)
		expect(matches('[!a]x', 'ax')).toBe(false)
		expect(matches('[a-c]', 'b')).toBe(true)
		expect(matches('[[:digit:]]', '7')).toBe(true)
		expect(matches('[[:alpha:]]', 'é')).toBe(true)
	})
	it('compiles the five extglob forms', () => {
		expect(matches('@(a|b)', 'b')).toBe(true)
		expect(matches('?(a|b)', '')).toBe(true)
		expect(matches('*(a)', 'aaa')).toBe(true)
		expect(matches('+(a|b)', 'abab')).toBe(true)
		expect(matches('+(a|b)', '')).toBe(false)
		expect(matches('!(three).ts', 'one.ts')).toBe(true)
		expect(matches('!(three).ts', 'three.ts')).toBe(false)
	})
	it('treats an unclosed class or group as literal text', () => {
		expect(compileSegment('[abc', false).literal).toBe('[abc')
		expect(compileSegment('@(abc', false).literal).toBe('@(abc')
	})
	it('keeps implicit wildcards off dot names unless asked or spelled out', () => {
		expect(matches('*', '.env')).toBe(false)
		expect(matches('*', '.env', true)).toBe(true)
		expect(matches('.*', '.env')).toBe(true)
		expect(matches('[.]env', '.env')).toBe(true)
		expect(matches('@(.config|src)', '.config')).toBe(true)
		expect(matches('@(.config|*)', '.other')).toBe(false)
	})

	it('matches nothing, and does not throw, for an out-of-order range', () => {
		expect(() => compileSegment('[z-a]', false)).not.toThrow()
		expect(matches('[z-a]', 'a')).toBe(false)
		expect(matches('[z-a]', 'z')).toBe(false)
		expect(matches('x[z-a]y', 'xay')).toBe(false)
	})
})

const oracle = (segment: string, name: string, dot: boolean) =>
	new Minimatch(segment, {
		nobrace: true,
		nonegate: true,
		nocomment: true,
		platform: 'linux',
		dot,
	}).match(name)

describe('compileSegment against Minimatch', () => {
	const patterns = [
		'[z-a]',
		'[!z-a]',
		'[a',
		'[]a]',
		'[]',
		'[a-]',
		'[-a]',
		'[[:foo:]]',
		'[[:digit:]]x',
		'*(a|.b)',
		'?(a)',
		'+(a|b)x*',
		'@(a|b)',
		'!(a).ts',
		'!(a)',
		'*.@(ts|js)',
		'a@(b|c)d',
	]
	const names = [
		'a',
		'b',
		'z',
		'ab',
		'ax',
		'x',
		'-',
		'[',
		']',
		'[]',
		'f]',
		':]',
		'a]',
		']a',
		'.a',
		'.b',
		'.env',
		'a.ts',
		'three.ts',
		'abd',
		'acd',
		'7x',
		'bx',
	]
	for (const dot of [false, true]) {
		for (const pattern of patterns) {
			it(`${pattern} (dot ${dot}) gives the same answer for every name`, () => {
				for (const name of names) {
					expect({ pattern, name, dot, got: matches(pattern, name, dot) }).toEqual({
						pattern,
						name,
						dot,
						got: oracle(pattern, name, dot),
					})
				}
			})
		}
	}

	// Forms where the answer differs from the minimatch 9 the walk used before. Each row is pinned to what the
	// walk answers now; the third column is what minimatch 9 answered.
	const differences: [
		segment: string,
		name: string,
		dot: boolean,
		now: boolean,
		before: boolean,
	][] = [
		['@(a|b)*', 'a', false, true, false],
		['@(a|b)*', 'b', true, true, false],
		['+(a)*', 'a', false, true, false],
		['+(a)*', 'a', true, true, false],
		['!(a)*', 'a', false, false, true],
		['!(.a)*', '.a', true, false, true],
		['?(a)*', '.env', false, false, true],
		['*(a)*', '.env', false, false, true],
	]
	for (const [segment, name, dot, now] of differences) {
		it(`pins ${segment} on ${name} (dot ${dot}) to ${now}`, () => {
			expect(matches(segment, name, dot)).toBe(now)
		})
	}
})
