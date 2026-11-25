import { describe, expect, it } from 'vitest'
import {
	MCP_SKILL_LIMITS,
	admitMcpSkillEntries,
	mcpSkillServerNameProblem,
	nameMcpSkills,
	summarizeMcpSkillRefusals,
	validateMcpSkillEntry,
} from '../skills.js'

const DIGEST = `sha256:${'a'.repeat(64)}`
const ROOT = 'skill://tickets/triage'

function entry(over: Record<string, unknown> = {}, rootUri = ROOT): Record<string, unknown> {
	return {
		uri: `${rootUri}/SKILL.md`,
		frontmatter: { name: rootUri.slice(rootUri.lastIndexOf('/') + 1), description: 'Sort tickets' },
		resources: [{ uri: `${rootUri}/SKILL.md`, digest: DIGEST, size: 10 }],
		...over,
	}
}

function reasonOf(raw: unknown): string | undefined {
	const verdict = validateMcpSkillEntry(raw)
	return verdict.ok ? undefined : verdict.reason
}

describe('validating a listed skill', () => {
	it('accepts a well-formed entry and keeps what was listed', () => {
		const verdict = validateMcpSkillEntry(entry())
		expect(verdict.ok).toBe(true)
		if (!verdict.ok) return
		expect(verdict.entry).toMatchObject({
			uri: `${ROOT}/SKILL.md`,
			root: ROOT,
			name: 'triage',
			description: 'Sort tickets',
			digest: DIGEST,
			size: 10,
		})
	})

	it.each([
		['not an object', 'x', 'invalid_entry'],
		['no uri', entry({ uri: undefined }), 'invalid_entry'],
		['not ending in SKILL.md', entry({ uri: `${ROOT}/README.md` }), 'invalid_entry'],
		['a $ in the uri', entry({}, 'skill://tickets/$ARGUMENTS'), 'placeholder_uri'],
		['a quote in the uri', entry({}, 'skill://tickets/tri"age'), 'unshowable_uri'],
		['an angle bracket in the uri', entry({}, 'skill://tickets/<b>'), 'unshowable_uri'],
		['a zero-width character', entry({}, 'skill://tickets/tri​age'), 'unshowable_uri'],
		[
			'a uri that changes under normalisation',
			entry({}, 'skill://tickets/ｔriage'),
			'unshowable_uri',
		],
		['an unparseable uri', entry({ uri: 'no scheme/SKILL.md' }), 'unparseable_uri'],
		[
			'an overlong uri',
			entry({}, `skill://tickets/${'a'.repeat(MCP_SKILL_LIMITS.maxUriBytes)}`),
			'uri_too_long',
		],
		['an uppercase name', entry({}, 'skill://tickets/Triage'), 'invalid_name'],
		['a doubled hyphen', entry({}, 'skill://tickets/a--b'), 'invalid_name'],
		['a name over 64 characters', entry({}, `skill://tickets/${'a'.repeat(65)}`), 'invalid_name'],
		['no frontmatter', entry({ frontmatter: undefined }), 'invalid_frontmatter'],
		[
			'a frontmatter without a description',
			entry({ frontmatter: { name: 'triage' } }),
			'invalid_frontmatter',
		],
		[
			'a frontmatter name that differs from the uri',
			entry({ frontmatter: { name: 'other', description: 'd' } }),
			'name_mismatch',
		],
		[
			'a frontmatter nested too deep',
			entry({
				frontmatter: {
					name: 'triage',
					description: 'd',
					x: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
				},
			}),
			'invalid_frontmatter',
		],
		['dynamic resources', entry({ resources: 'dynamic' }), 'dynamic_declined'],
		['resources that are not a list', entry({ resources: {} }), 'invalid_manifest'],
		['a manifest without SKILL.md', entry({ resources: [] }), 'invalid_manifest'],
		[
			'a bad digest',
			entry({ resources: [{ uri: `${ROOT}/SKILL.md`, digest: 'sha256:xyz', size: 1 }] }),
			'invalid_manifest',
		],
		[
			'a file outside the root',
			entry({
				resources: [
					{ uri: `${ROOT}/SKILL.md`, digest: DIGEST, size: 1 },
					{ uri: 'skill://other/x.md', digest: DIGEST, size: 1 },
				],
			}),
			'invalid_manifest',
		],
		[
			'a file that climbs out with ..',
			entry({
				resources: [
					{ uri: `${ROOT}/SKILL.md`, digest: DIGEST, size: 1 },
					{ uri: `${ROOT}/../x.md`, digest: DIGEST, size: 1 },
				],
			}),
			'invalid_manifest',
		],
		[
			'SKILL.md listed twice',
			entry({
				resources: [
					{ uri: `${ROOT}/SKILL.md`, digest: DIGEST, size: 1 },
					{ uri: `${ROOT}/SKILL.md`, digest: DIGEST, size: 1 },
				],
			}),
			'invalid_manifest',
		],
		[
			'a negative size',
			entry({ resources: [{ uri: `${ROOT}/SKILL.md`, digest: DIGEST, size: -1 }] }),
			'invalid_manifest',
		],
		[
			'more files than allowed',
			entry({
				resources: Array.from({ length: MCP_SKILL_LIMITS.maxFiles + 1 }, (_, i) => ({
					uri: `${ROOT}/f${i}.md`,
					digest: DIGEST,
					size: 1,
				})),
			}),
			'too_many_resources',
		],
		[
			'a SKILL.md over its cap',
			entry({
				resources: [
					{ uri: `${ROOT}/SKILL.md`, digest: DIGEST, size: MCP_SKILL_LIMITS.maxSkillMdBytes + 1 },
				],
			}),
			'skill_md_too_large',
		],
		[
			'a skill over its total size',
			entry({
				resources: [
					{ uri: `${ROOT}/SKILL.md`, digest: DIGEST, size: 10 },
					{ uri: `${ROOT}/big.bin`, digest: DIGEST, size: MCP_SKILL_LIMITS.maxTotalBytes },
				],
			}),
			'too_large',
		],
	])('refuses %s', (_label, raw, reason) => {
		expect(reasonOf(raw)).toBe(reason)
	})
})

describe('admitting a listing', () => {
	const at = (n: string): Record<string, unknown> => entry({}, `skill://tickets/${n}`)

	it('keeps the first of two entries at one address and says why the second went', () => {
		const result = admitMcpSkillEntries([at('a'), at('a'), at('b')])
		expect(result.accepted.map((e) => e.name)).toEqual(['a', 'b'])
		expect(result.refused).toEqual([{ uri: 'skill://tickets/a/SKILL.md', reason: 'duplicate_uri' }])
	})

	it('drops skills past the per-server cap, in listed order', () => {
		const names = Array.from({ length: MCP_SKILL_LIMITS.maxSkills + 3 }, (_, i) => `s${i}`)
		const result = admitMcpSkillEntries(names.map(at))
		expect(result.accepted).toHaveLength(MCP_SKILL_LIMITS.maxSkills)
		expect(result.refused.map((r) => r.reason)).toEqual([
			'too_many_skills',
			'too_many_skills',
			'too_many_skills',
		])
	})

	it('drops entries once the listing passes its byte cap', () => {
		const fat = (n: string): Record<string, unknown> => ({
			...at(n),
			frontmatter: { name: n, description: 'x'.repeat(30_000) },
		})
		const listed = Array.from({ length: 30 }, (_, i) => fat(`s${i}`))
		const result = admitMcpSkillEntries(listed)
		expect(result.accepted.length).toBeLessThan(30)
		expect(result.refused.every((r) => r.reason === 'past_list_bytes')).toBe(true)
		expect(result.accepted.length + result.refused.length).toBe(30)
	})

	it('reads a refused entry and the rest still load', () => {
		const result = admitMcpSkillEntries([at('a'), { uri: 5 }, at('b')])
		expect(result.accepted).toHaveLength(2)
		expect(result.refused).toEqual([{ reason: 'invalid_entry' }])
	})

	it('summarises the refusals in one line', () => {
		expect(summarizeMcpSkillRefusals([])).toBeUndefined()
		expect(
			summarizeMcpSkillRefusals([
				{ reason: 'invalid_name' },
				{ reason: 'invalid_name' },
				{ reason: 'too_large' },
			]),
		).toBe('3 skills not loaded (invalid_name 2, too_large 1)')
	})
})

describe('naming skills', () => {
	const make = (uri: string): ReturnType<typeof admitMcpSkillEntries>['accepted'][number] => {
		const root = uri.replace(/\/SKILL\.md$/, '')
		const result = admitMcpSkillEntries([entry({}, root)])
		const first = result.accepted[0]
		if (!first) throw new Error('fixture refused')
		return first
	}

	it('uses server:skill for a unique name', () => {
		const { named } = nameMcpSkills('tickets', [make('skill://tickets/triage/SKILL.md')])
		expect(named.map((n) => n.name)).toEqual(['tickets:triage'])
	})

	it('qualifies a duplicate with its directory, then with the authority', () => {
		const result = nameMcpSkills('tickets', [
			make('skill://tickets/a/review/SKILL.md'),
			make('skill://tickets/b/review/SKILL.md'),
			make('skill://other/review/SKILL.md'),
		])
		expect(result.named.map((n) => n.name)).toEqual([
			'tickets:review',
			'tickets:b/review',
			'tickets:other/review',
		])
		expect(result.qualified.map((q) => q.name)).toEqual([
			'tickets:b/review',
			'tickets:other/review',
		])
	})

	it('drops an entry with no free form instead of replacing another', () => {
		const same = make('skill://tickets/review/SKILL.md')
		const result = nameMcpSkills('tickets', [same, same, same])
		expect(result.named.map((n) => n.name)).toEqual(['tickets:review', 'tickets:tickets/review'])
		expect(result.refused).toEqual([{ uri: same.uri, reason: 'duplicate_name' }])
	})

	it('never takes a name another source already holds', () => {
		const result = nameMcpSkills(
			'tickets',
			[make('skill://tickets/triage/SKILL.md')],
			new Set(['tickets:triage']),
		)
		expect(result.named).toEqual([])
		expect(result.refused.map((r) => r.reason)).toEqual(['duplicate_name'])
	})

	it.each(['a$b', 'a:b', 'a"b', 'a<b>', 'a\nb', 'a​b', ''])('refuses the server name %j', (name) => {
		expect(mcpSkillServerNameProblem(name)).toBeTypeOf('string')
	})

	it('accepts an ordinary server name', () => {
		expect(mcpSkillServerNameProblem('my-tickets_2')).toBeUndefined()
	})
})
