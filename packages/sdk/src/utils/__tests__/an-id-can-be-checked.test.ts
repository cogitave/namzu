import { describe, expect, it } from 'vitest'

import * as ids from '../id.js'
import { InvalidIdError } from '../id.js'

// A nominal brand cannot inspect strings read from JSON or prevent a type
// assertion. Constructors validate those values; stores must call them too.

/** Every `generate*Id` factory paired with the parser that must accept it. */
function pairs(): { name: string; generate: () => string; parse: (v: string) => string }[] {
	const out: { name: string; generate: () => string; parse: (v: string) => string }[] = []
	for (const [key, value] of Object.entries(ids)) {
		if (!key.startsWith('generate') || typeof value !== 'function') continue
		const parserName = `as${key.slice('generate'.length)}`
		const parse = (ids as Record<string, unknown>)[parserName]
		if (typeof parse !== 'function') continue
		out.push({
			name: key,
			generate: value as () => string,
			parse: parse as (v: string) => string,
		})
	}
	return out
}

describe('an id can be checked at runtime', () => {
	it('refuses a value carrying the wrong prefix, naming both', () => {
		// Both halves of the message matter: the caller needs the value they
		// passed AND the prefix that was wanted, or they are left guessing
		// which of the two dozen id types they got wrong.
		expect(() => ids.asRunId('ses_abc')).toThrow(InvalidIdError)
		expect(() => ids.asRunId('ses_abc')).toThrow(/ses_abc/)
		expect(() => ids.asRunId('ses_abc')).toThrow(/run_/)
	})

	it('returns the value unchanged, rather than normalising it', () => {
		// The first version of this asserted `toBe` on a lowercase id and
		// called it "a check, not a copy". That cannot fail: JS strings are
		// primitives, so every string-returning implementation compares equal
		// by value and `toBe` never sees a copy — `a-check-that-cannot-fail`,
		// written by hand.
		//
		// What CAN fail is normalisation. A constructor that trimmed or
		// lower-cased on the way through would hand back an id that is not
		// the one the caller has stored elsewhere, and every lookup keyed on
		// the original would miss. Mixed case and surrounding-looking
		// characters are what make that visible.
		expect(ids.asRunId('run_AbC')).toBe('run_AbC')
		expect(ids.asRunId('run_a-b_c')).toBe('run_a-b_c')
	})

	it('accepts every id its own factory mints', () => {
		// This is also the check that the prefix table in utils/id.ts agrees
		// with the one in types/ids/index.ts. Changing a factory's prefix
		// without changing its parser fails here.
		const checked = pairs()
		expect(checked.length).toBeGreaterThan(20)

		for (const { name, generate, parse } of checked) {
			const minted = generate()
			expect(() => parse(minted), name).not.toThrow()
		}
	})

	it('does not let a longer prefix satisfy a shorter one', () => {
		// `mcpc_`, `advc_` and `kbs_` all start with another id's letters, and
		// only the trailing underscore separates them. A prefix table written
		// without it would have `asMCPServerId` quietly accepting a client id.
		expect(() => ids.asMCPServerId('mcpc_abc')).toThrow(InvalidIdError)
		expect(() => ids.asAdvisoryId('advc_abc')).toThrow(InvalidIdError)
		expect(() => ids.asKnowledgeBaseId('kbs_abc')).toThrow(InvalidIdError)

		// And each accepts its own.
		expect(() => ids.asMCPClientId('mcpc_abc')).not.toThrow()
		expect(() => ids.asAdvisoryCallId('advc_abc')).not.toThrow()
		expect(() => ids.asKnowledgeBaseRef('kbs_abc')).not.toThrow()
	})

	it('refuses the empty string and the bare prefix-less value', () => {
		expect(() => ids.asRunId('')).toThrow(InvalidIdError)
		expect(() => ids.asRunId('abc')).toThrow(InvalidIdError)
	})

	it.each(['', '../outside', 'a/b', 'a\\b', 'a.b', 'a:stream', 'a b', 'a\n', 'a\0b', 'ü'])(
		'refuses the empty or unsafe suffix %j for every generated id type',
		(suffix) => {
			for (const { generate, parse } of pairs()) {
				const minted = generate()
				const prefix = minted.slice(0, minted.indexOf('_') + 1)
				expect(() => parse(`${prefix}${suffix}`)).toThrow(InvalidIdError)
			}
		},
	)

	it('applies the same shape rules to deprecated parsers', () => {
		const parsers = [
			{ parse: ids.parseRunId, prefix: 'run_' },
			{ parse: ids.parseProjectId, prefix: 'prj_' },
			{ parse: ids.parseConnectorInstanceId, prefix: 'ci_' },
			{ parse: ids.parsePluginId, prefix: 'plg_' },
			{ parse: ids.parseSandboxId, prefix: 'sbx_' },
		]
		for (const { parse, prefix } of parsers) {
			expect(parse(`${prefix}Custom-A_1`)).toBe(`${prefix}Custom-A_1`)
			expect(() => parse(prefix)).toThrow(Error)
			expect(() => parse(`${prefix}../../outside`)).toThrow(Error)
		}
	})
})
