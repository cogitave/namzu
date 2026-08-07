import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from '../frontmatter.js'

/**
 * This reader replaced three. The two that disagreed did so on one file shape:
 * this one threw on malformed frontmatter, and the CLI's copy silently
 * returned no metadata — so the same file was a hard error on one path and a
 * skill named after its own directory with "(no description)" on the other.
 *
 * The CRLF cases are the ones with a live defect behind them. The CLI's regex
 * was `/^---\n([\s\S]*?)\n---\n?/`, which requires LF: a file authored on
 * Windows lost its frontmatter entirely and was described wrongly rather than
 * refused. This reader already handled CRLF — by accident, because `$` under
 * `/m` matches before a `\r` — so these assertions are a lock on a property
 * that was true and untested, not a repair. Mutating the fence to `/^---$/`
 * without the `\r?` still passes; mutating it to an LF-anchored form fails
 * `parses CRLF identically to LF`, which is the point of having it.
 */

const LINES = [
	'---',
	'name: a-skill',
	'description: Does a useful thing',
	'---',
	'',
	'First body line.',
	'Second body line.',
]

const SOURCE = 'test.md'

describe('line endings', () => {
	it('parses CRLF identically to LF', () => {
		const lf = parseFrontmatter(LINES.join('\n'), SOURCE)
		const crlf = parseFrontmatter(LINES.join('\r\n'), SOURCE)

		expect(lf.data).toEqual({ name: 'a-skill', description: 'Does a useful thing' })
		// The whole point: the same keys, not merely "some keys".
		expect(crlf.data).toEqual(lf.data)
	})

	it('does not leave a carriage return inside a CRLF value', () => {
		const { data } = parseFrontmatter(LINES.join('\r\n'), SOURCE)
		// A trailing \r survives naive splitting and reaches the system prompt.
		expect(data.description).toBe('Does a useful thing')
		expect(data.description).not.toMatch(/\r/)
		expect(data.name).not.toMatch(/\r/)
	})

	it('keeps the body intact under CRLF', () => {
		const { body } = parseFrontmatter(LINES.join('\r\n'), SOURCE)
		expect(body).toContain('First body line.')
		expect(body).toContain('Second body line.')
		expect(body.startsWith('First')).toBe(true)
	})

	it('reads a CRLF nested block', () => {
		const raw = ['---', 'name: x', 'metadata:', '  author: someone', '---', '', 'Body.'].join(
			'\r\n',
		)
		expect(parseFrontmatter(raw, SOURCE).blocks.metadata).toEqual({ author: 'someone' })
	})

	it('splits a lone-CR file into lines rather than one long key', () => {
		// Without `\r` in the split this file is a single line, and the whole
		// block collapses into `name` — a wrong value, silently. `loadSkill`
		// escaped it only because the collapse also removes the `description`
		// key, so the required-field check refused the file first. A caller
		// that validates nothing would have taken the mangled name.
		const { data } = parseFrontmatter(LINES.join('\r'), SOURCE)
		expect(data).toEqual({ name: 'a-skill', description: 'Does a useful thing' })
		expect(data.name).not.toMatch(/description/)
	})

	it('leaves the body its own line endings rather than normalising them', () => {
		const raw = ['---', 'name: x', '---', '', 'a', 'b'].join('\r\n')
		expect(parseFrontmatter(raw, SOURCE).body).toBe('a\r\nb')
	})

	it('parses a file that opens with a byte-order mark', () => {
		// An editor on Windows writes one, and `---` is then not at index 0.
		const raw = `﻿${LINES.join('\r\n')}`
		expect(parseFrontmatter(raw, SOURCE).data.name).toBe('a-skill')
	})
})

describe('refusing rather than degrading', () => {
	it('throws when there is no frontmatter, rather than treating it all as body', () => {
		expect(() => parseFrontmatter('Just a body.', SOURCE)).toThrow(/no YAML frontmatter/)
	})

	it('throws on unclosed frontmatter', () => {
		expect(() => parseFrontmatter(['---', 'name: x'].join('\n'), SOURCE)).toThrow(/unclosed/)
	})

	it('names its source in the message', () => {
		expect(() => parseFrontmatter('nope', 'the-command-file.md')).toThrow(/the-command-file\.md/)
	})

	it('refuses a block scalar rather than reading it as ">-"', () => {
		const raw = ['---', 'name: x', 'description: >-', '  wrapped text', '---'].join('\n')
		expect(() => parseFrontmatter(raw, SOURCE)).toThrow(/block scalar/)
	})

	it('refuses a flow sequence rather than interpolating its text', () => {
		const raw = ['---', 'name: x', 'allowed-tools: [Read, Grep]', '---'].join('\n')
		expect(() => parseFrontmatter(raw, SOURCE)).toThrow(/flow sequence/)
	})

	it('refuses a flow mapping', () => {
		const raw = ['---', 'name: x', 'opts: {a: b}', '---'].join('\n')
		expect(() => parseFrontmatter(raw, SOURCE)).toThrow(/flow mapping/)
	})
})

describe('keys from an untrusted file cannot reach the prototype chain', () => {
	/**
	 * Caught by an adversarial pass, and it was real: with a plain object,
	 * `blocks[currentKey] = …` for `currentKey === '__proto__'` resolves through
	 * the inheritance chain and writes to `Object.prototype` itself. A
	 * frontmatter file could set `Object.prototype.metadata`, and the poison
	 * then surfaced in the metadata of an unrelated skill loaded afterwards in
	 * the same process.
	 */
	const RESERVED = ['__proto__', 'constructor', 'toString'] as const

	for (const key of RESERVED) {
		it(`does not pollute Object.prototype through a \`${key}\` block`, () => {
			const raw = ['---', 'name: x', `${key}:`, '  polluted: yes', '---'].join('\n')
			parseFrontmatter(raw, SOURCE)

			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(Object.prototype).not.toHaveProperty('polluted')
		})
	}

	it('reports such a key as ordinary own data instead', () => {
		const raw = ['---', 'name: x', '__proto__:', '  polluted: yes', '---'].join('\n')
		const { blocks } = parseFrontmatter(raw, SOURCE)

		// The file really did declare it, so reporting it is honest; what must
		// not happen is the write landing on the prototype.
		expect(Object.hasOwn(blocks, '__proto__')).toBe(true)
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})

	it('does not let a `constructor` scalar shadow anything structural', () => {
		const raw = ['---', 'name: x', 'constructor: hijacked', '---'].join('\n')
		const { data } = parseFrontmatter(raw, SOURCE)
		expect(data.constructor).toBe('hijacked')
		expect(Object.hasOwn(data, 'constructor')).toBe(true)
	})
})

describe('the closing fence', () => {
	it('is a line of its own, not `---` wherever it appears', () => {
		const raw = [
			'---',
			'name: x',
			'description: "Handles the --- separator in CSV files"',
			'---',
			'',
			'Body text.',
		].join('\n')

		const { data, body } = parseFrontmatter(raw, SOURCE)
		expect(data.description).toContain('CSV')
		expect(body).toBe('Body text.')
		// A leak here is a leak into the system prompt.
		expect(body).not.toContain('description:')
	})

	it('tolerates trailing whitespace on the fence', () => {
		const raw = ['---', 'name: x', '---   ', '', 'Body.'].join('\n')
		expect(parseFrontmatter(raw, SOURCE).body).toBe('Body.')
	})
})

describe('vocabulary belongs to the caller', () => {
	it('parses command-shaped frontmatter without knowing what a command is', () => {
		const raw = [
			'---',
			'description: Open a pull request',
			'argument-hint: <branch>',
			'---',
			'',
			'Prompt template.',
		].join('\n')

		const { data, body } = parseFrontmatter(raw, SOURCE)
		expect(data).toEqual({
			description: 'Open a pull request',
			'argument-hint': '<branch>',
		})
		expect(body).toBe('Prompt template.')
	})

	it('validates no field names of its own — `name` is not required', () => {
		const raw = ['---', 'description: no name here', '---'].join('\n')
		expect(parseFrontmatter(raw, SOURCE).data).toEqual({ description: 'no name here' })
	})

	it('groups an indented block under any key, not only `metadata`', () => {
		const raw = ['---', 'name: x', 'inputs:', '  branch: main', '  force: "yes"', '---'].join('\n')
		const { data, blocks } = parseFrontmatter(raw, SOURCE)
		expect(data).toEqual({ name: 'x' })
		expect(blocks.inputs).toEqual({ branch: 'main', force: 'yes' })
	})
})

describe('scalars', () => {
	it('keeps a quoted value containing a colon', () => {
		const raw = ['---', 'url: "Reads a URL: http://example.com"', '---'].join('\n')
		expect(parseFrontmatter(raw, SOURCE).data.url).toBe('Reads a URL: http://example.com')
	})

	it('skips comments and blank lines', () => {
		const raw = ['---', '# a comment', '', 'name: x', '---'].join('\n')
		expect(parseFrontmatter(raw, SOURCE).data).toEqual({ name: 'x' })
	})
})
