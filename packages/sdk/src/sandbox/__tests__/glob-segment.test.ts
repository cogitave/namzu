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
})
