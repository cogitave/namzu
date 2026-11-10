import { Minimatch } from 'minimatch'
import { describe, expect, it } from 'vitest'
import { GlobTooComplexError, MAX_GLOB_SEGMENT_LENGTH, compileSegment } from '../glob-segment.js'

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

const PINNED_PATTERNS = [
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

describe('compileSegment against Minimatch', () => {
	const patterns = PINNED_PATTERNS
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

// Largest depth of unbounded repetition (`*`, `+`, `{n,}`) in a regex source: a quantifier on an atom counts
// one, on a group counts one more than the deepest repetition inside it. `?` and `{n,m}` are bounded.
function starHeight(source: string): number {
	let index = 0
	const quantifier = (): boolean => {
		const ch = source[index]
		let unbounded = false
		if (ch === '*' || ch === '+') {
			index += 1
			unbounded = true
		} else if (ch === '?') index += 1
		else if (ch === '{') {
			const end = source.indexOf('}', index)
			unbounded = /,$/.test(source.slice(index + 1, end))
			index = end + 1
		} else return false
		if (source[index] === '?') index += 1
		return unbounded
	}
	const alternation = (): number => {
		let best = 0
		let run = 0
		while (index < source.length && source[index] !== ')') {
			if (source[index] === '|') {
				index += 1
				best = Math.max(best, run)
				run = 0
				continue
			}
			let inner = 0
			const ch = source[index]
			if (ch === '\\') index += 2
			else if (ch === '[') {
				index += 1
				while (source[index] !== ']') index += source[index] === '\\' ? 2 : 1
				index += 1
			} else if (ch === '(') {
				index += 1
				if (source[index] === '?') index += source[index + 1] === '<' ? 3 : 2
				inner = alternation()
				index += 1
			} else index += 1
			run = Math.max(run, quantifier() ? inner + 1 : inner)
		}
		return Math.max(best, run)
	}
	return alternation()
}

describe('star height', () => {
	it('measures nesting of unbounded repetition', () => {
		expect(starHeight('^(?:a)*$')).toBe(1)
		expect(starHeight('^(?:(?:a)*)*$')).toBe(2)
		expect(starHeight('^(?:a|aa)+b[^/]*?$')).toBe(1)
		expect(starHeight('^(?:a*)?$')).toBe(1)
		expect(starHeight('^(?:[*+]x)?(?:a{2,})$')).toBe(1)
	})
	const accepted = [
		...PINNED_PATTERNS,
		'*a*a*a',
		'+(foo|bar)',
		'*(ab|cd)',
		'*(a)*(b)',
		'!(x)*',
		'?(*(a))',
		'@(+(a)|b)',
		'!(*(a)|b)c*',
		'@(a|aa)',
		'*.@(ts|js)',
		'+([a-z])',
		'*([[:digit:]])',
	]
	for (const dot of [false, true]) {
		for (const pattern of accepted) {
			it(`${pattern} (dot ${dot}) compiles to star height at most 1`, () => {
				expect(starHeight(compileSegment(pattern, dot).source)).toBeLessThanOrEqual(1)
			})
		}
	}
})

describe('repeated extglob groups that can match the same text more than one way', () => {
	for (const pattern of [
		'*(*(a))',
		'*(a|aa)',
		'+(a|aa)',
		'+(*.ts)',
		'+(a|)',
		'*(?(a))',
		'*(a|a)',
		'*(a?)',
		'+([ab]|[bc])',
		'*([ab]x)',
		'*(@(a|b))',
		'x@(*(a|aa))y',
		'!(+(a|aa))',
		'a*(b|bc)',
	]) {
		it(`refuses ${pattern}`, () => {
			expect(() => compileSegment(pattern, false)).toThrow(GlobTooComplexError)
			expect(() => compileSegment(pattern, true)).toThrow(
				`The pattern '${pattern}' repeats a group that can match the same text more than one way; use ** or {a,b} instead.`,
			)
		})
	}
	it('accepts a repeated group of unambiguous literals and matches as before', () => {
		expect(compileSegment('+(foo|bar)', false).source).toBe('^(?:(?:(?!\\.)foo|(?!\\.)bar)+)$')
		expect(matches('+(foo|bar)', 'foobarfoo')).toBe(true)
		expect(matches('+(foo|bar)', 'foobaz')).toBe(false)
		expect(matches('*(ab|cd)', '')).toBe(true)
		expect(matches('*(ab|cd)', 'abcdab')).toBe(true)
		expect(matches('*(ab|cd)', 'abc')).toBe(false)
		expect(matches('@(a|aa)', 'aa')).toBe(true)
		expect(matches('!(x)*', 'y')).toBe(true)
		expect(matches('?(*(a))', 'aaa')).toBe(true)
		expect(matches('*(a\\*)', 'a*a*')).toBe(true)
	})
	it('runs a near miss through the compiled expression without backtracking', () => {
		const { source } = compileSegment('*(ab|cd)', false)
		expect(new RegExp(source, 'u').test(`${'ab'.repeat(5000)}x`)).toBe(false)
	})
})

describe('wildcards that can stretch', () => {
	const stretchy = (pattern: string) =>
		`The pattern '${pattern}' has more than three wildcards that can stretch; split it across folders or use fewer *.`
	for (const pattern of ['*a*a*a*b', '*a*a*a*a*', '*(a)*(b)*(c)*', '+(a)*b*c*d', '!(a)*b*c*']) {
		it(`refuses ${pattern}`, () => {
			expect(() => compileSegment(pattern, false)).toThrow(GlobTooComplexError)
			expect(() => compileSegment(pattern, true)).toThrow(stretchy(pattern))
		})
	}
	it('counts consecutive stars as one and accepts three runs', () => {
		for (const pattern of ['*foo*bar*', '*.test.*', '***a**b*', '*(a)*b*c']) {
			expect(() => compileSegment(pattern, false)).not.toThrow()
		}
		expect(matches('*foo*bar*', 'xfooybarz')).toBe(true)
		expect(matches('*.test.*', 'a.test.ts')).toBe(true)
		expect(matches('*.test.*', 'a.ts')).toBe(false)
	})
	it('accepts every pinned pattern', () => {
		for (const pattern of PINNED_PATTERNS) {
			expect(() => compileSegment(pattern, false)).not.toThrow()
		}
	})
})

describe('POSIX class names', () => {
	it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
		'treats the inherited name %s like any other unknown name',
		(name) => {
			const unknown = compileSegment('[[:nosuchclass:]]', false)
			const inherited = compileSegment(`[[:${name}:]]`, false)
			// Exactly what an unknown name compiles to, with only the name different.
			expect(inherited.source).toBe(unknown.source.replace('nosuchclass', name))
			expect(inherited.source).not.toContain('(?!)')
		},
	)
	it('still honours a real class', () => {
		expect(new RegExp(compileSegment('[[:digit:]]', false).source, 'u').test('7')).toBe(true)
	})
})

describe('segment length cap', () => {
	it('compiles a segment at the cap and refuses one past it', () => {
		expect(compileSegment('a'.repeat(MAX_GLOB_SEGMENT_LENGTH), false).literal).toHaveLength(
			MAX_GLOB_SEGMENT_LENGTH,
		)
		expect(() => compileSegment('a'.repeat(MAX_GLOB_SEGMENT_LENGTH + 1), false)).toThrow(
			GlobTooComplexError,
		)
	})
	it('says the pattern is too long without echoing it', () => {
		const long = `${'[[:alpha:]'.repeat(20_000)}`
		let message = ''
		try {
			compileSegment(long, true)
		} catch (error) {
			message = (error as Error).message
		}
		expect(message).toContain(`The pattern '${long.slice(0, 60)}...' is too long`)
		expect(message).toContain('200000 characters')
		expect(message).toContain('shorten it or split it across folders')
		expect(message.length).toBeLessThan(250)
	})
	it('cuts the preview on a code point, not inside a surrogate pair', () => {
		const long = `${'a'.repeat(59)}\u{1F600}${'b'.repeat(MAX_GLOB_SEGMENT_LENGTH)}`
		let error: GlobTooComplexError | undefined
		try {
			compileSegment(long, false)
		} catch (caught) {
			error = caught as GlobTooComplexError
		}
		expect(error?.segment).toBe(`${'a'.repeat(59)}\u{1F600}`)
		expect(error?.message).toContain(`'${'a'.repeat(59)}\u{1F600}...'`)
		expect(error?.message).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
	})
})
