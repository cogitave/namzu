#!/usr/bin/env node
/**
 * Records what the glob segment compiler answers, as language-neutral vectors
 * a second implementation can be held to.
 *
 *   node --import tsx scripts/generate-conformance-vectors.mjs           # write the file
 *   node --import tsx scripts/generate-conformance-vectors.mjs --check   # diff, exit 1 on drift
 *
 * The output is `f(implementation)` and nothing else: never edit it by hand.
 * `conformance/README.md` says what a vector set is and how to read this one.
 * `tsx` is needed because the implementation is read from its TypeScript
 * source, so the check does not depend on a build.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GLOB_SEGMENT_VECTORS_PATH = join(
	HERE,
	'..',
	'conformance',
	'glob-segment',
	'vectors.json',
)

// Hand-picked segments: every construct, and the edges each one has.
const HAND = [
	'a', 'abc', '.a', '.env', 'a.b', 'a b', 'ä', '日本', '', '*', '**', '***', '?', '??', '*.ts', '*.test.*', 'a*', '*a', 'a*b', '*a*', '*foo*bar*',
	'*a*a*a', '*a*a*a*b', '.*', '.?', '?.a', '[ab]', '[!ab]', '[^ab]', '[a-c]', '[z-a]', 'x[z-a]y', '[]a]', '[a', '[', ']', '[!]', '[[:digit:]]',
	'[[:alpha:]]x', '[[:foo:]]', '[[:upper:][:digit:]]', '[a-]', '[-a]', '[\\]]', '\\*', '\\?', '\\[a]', 'a\\', '@(a|b)', '@(a|b)*', '@(a|aa)',
	'@(.a|b)', '?(a)', '?(a)b', '?(a)*', '?(a|b)c', '+(a)', '+(a)*', '+(foo|bar)', '+(a|aa)', '+(a|)', '+(*.ts)', '+([a-z])', '+([a-z]).ts',
	'+([ab]|[bc])', '*(a)', '*(ab|cd)', '*(a|aa)', '*(*(a))', '*(?(a))', '*(a)*', '*(a|.b)', '*(a)*(b)*(c)*', '!(a)', '!(a)*', '!(.a)*', '!(a|b)',
	'!(a)*b*c*', '!(*.ts)', '+(a)*b*c*d', '***a**b*', '*(a)*b*c', '@(a|+(b))', '@(a|*(b|bb))', '?(+(a))', 'a@(b)c', 'a?(b)c', 'a+(b)c', 'a*(b)c',
	'a!(b)c', '(a)', 'a|b', 'a(b', '@(a', '@()', '+()', '*()', '{a,b}', 'a{b', '$', '^a', 'a$', 'a.b.c', 'a+b', 'a(b)c', '\\(a\\)', 'A', '[A-Z]',
	'[a-zA-Z0-9_]', '[!.]*', '*[!.]', '?*', '*?', '[*]', '[?]', '[!*]', '@(*)', '@(?)', '@([ab])', '@(\\*)', 'é*', '*😀*', '[à-ü]', 'a/b',
	// A POSIX class name that Object.prototype also has is an unknown name like any other.
	'[[:constructor:]]', '[[:toString:]]', '[[:__proto__:]]', '[[:hasOwnProperty:]]', '[[:valueOf:]]', '[[:constructor:]x]', '[^[:toString:]]',
]
const FRAGS = ['a', 'b', '.', '*', '?', '[ab]', '[!a]', '[a-c]', '@(a|b)', '?(a)', '+(ab|c)', '*(a|aa)', '!(a)', '\\*', '[[:digit:]]', '.a', '+(a)', '*(a)']

// Names the compiled expressions are tried against; `matches` has one bit per name.
const NAMES = ['', 'a', 'b', 'c', 'ab', 'ba', 'aa', 'aaa', 'abc', 'abab', 'cab', '.a', '.b', '.env', '.', '..', 'a.b', 'a.ts', 'a.test.ts', 'foo', 'bar',
	'foobar', 'xfooybarz', '1', 'a1', '12', '[ab]', '*', '?', 'a b', 'A', 'Ab', 'ä', '日本', 'é', '😀', 'a😀b', 'a*', '!a', '(a)', 'a|b', 'x'.repeat(40), 'a'.repeat(30) + 'b', 'd', 'abcd', 'ac', 'bc', '\\',
	':', ':]', 'c]']

/** Segments given as a generator, so a file does not carry a megabyte string. */
const GENERATED = [
	{ repeat: 'a', times: 'cap' },
	{ repeat: 'a', times: 'cap+1' },
	{ repeat: '[[:alpha:]', times: 20000 },
	{ repeat: '*', times: 2000 },
]

const expand = (segment) =>
	typeof segment === 'string' ? segment : segment.repeat.repeat(segment.times)

/**
 * The vector set for the compiler passed in, as the exact text of the file.
 * `compileSegment`, `GlobTooComplexError` and `MAX_GLOB_SEGMENT_LENGTH` come
 * from the caller so a test can use the module it already imported.
 */
export function buildGlobSegmentVectors({ compileSegment, GlobTooComplexError, MAX_GLOB_SEGMENT_LENGTH }) {
	const generated = GENERATED.map((g) => ({
		repeat: g.repeat,
		times: g.times === 'cap' ? Math.floor(MAX_GLOB_SEGMENT_LENGTH / g.repeat.length) : g.times === 'cap+1' ? MAX_GLOB_SEGMENT_LENGTH + 1 : g.times,
	}))
	const segments = new Set(HAND)
	for (const x of FRAGS) for (const y of FRAGS) segments.add(x + y)
	for (const x of FRAGS.slice(0, 12)) for (const y of FRAGS.slice(0, 12)) for (const z of FRAGS.slice(0, 8)) segments.add(x + y + z)
	const inputs = [...segments, ...generated]
	const lines = []
	for (const segment of inputs) {
		const text = expand(segment)
		for (const dot of [false, true]) {
			const head = { segment, dot }
			try {
				const c = compileSegment(text, dot)
				const re = new RegExp(c.source, 'us')
				const matches = NAMES.map((n) => (re.test(n) ? '1' : '0')).join('')
				lines.push({ ...head, ok: { literal: c.literal, source: c.source }, matches })
			} catch (e) {
				if (e instanceof GlobTooComplexError) lines.push({ ...head, error: { kind: 'too-complex', message: e.message } })
				else lines.push({ ...head, error: { kind: 'other', message: String(e && e.message) } })
			}
		}
	}
	// One case per line, so a change to the implementation reads as a small diff.
	return `${[
		'{',
		`"about": ${JSON.stringify('glob segment compiler: source is a JavaScript regular expression source (flags u and s); matches[i] is whether names[i] matches; a segment given as {repeat, times} is repeat repeated times; see conformance/README.md')},`,
		`"limits": ${JSON.stringify({ maxSegmentLength: MAX_GLOB_SEGMENT_LENGTH })},`,
		`"names": ${JSON.stringify(NAMES)},`,
		'"cases": [',
		lines.map((line) => JSON.stringify(line)).join(',\n'),
		']',
		'}',
	].join('\n')}\n`
}

async function main() {
	const mod = await import('../packages/sdk/src/sandbox/glob-segment.ts')
	const rendered = buildGlobSegmentVectors(mod)
	if (!process.argv.includes('--check')) {
		writeFileSync(GLOB_SEGMENT_VECTORS_PATH, rendered)
		console.log(`conformance/glob-segment/vectors.json written`)
		return
	}
	let onDisk
	try {
		onDisk = readFileSync(GLOB_SEGMENT_VECTORS_PATH, 'utf8')
	} catch {
		console.error('conformance/glob-segment/vectors.json is missing. Run `node --import tsx scripts/generate-conformance-vectors.mjs` and commit it.')
		process.exit(1)
	}
	if (onDisk === rendered) {
		console.log('glob segment conformance vectors match the implementation')
		return
	}
	const actual = onDisk.split('\n')
	const expected = rendered.split('\n')
	const first = expected.findIndex((line, index) => line !== actual[index])
	console.error('CONFORMANCE VECTOR DRIFT\n')
	console.error('  conformance/glob-segment/vectors.json is not what the implementation produces.')
	console.error(`  First difference at line ${first + 1}:`)
	console.error(`    on disk:  ${JSON.stringify((actual[first] ?? '<end of file>').slice(0, 300))}`)
	console.error(`    expected: ${JSON.stringify((expected[first] ?? '<end of file>').slice(0, 300))}`)
	console.error('\n  A behaviour change regenerates the vectors in the same commit:\n    node --import tsx scripts/generate-conformance-vectors.mjs')
	process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
