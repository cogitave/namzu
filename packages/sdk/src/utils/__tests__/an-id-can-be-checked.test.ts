import { describe, expect, it } from 'vitest'

import * as ids from '../id.js'
import { InvalidIdError } from '../id.js'

// A nominal brand cannot inspect strings read from JSON or prevent a type
// assertion. Constructors validate those values; stores must call them too.

/** Every `generate*Id` factory paired with the parser that must accept it. */
function pairs(): {
	name: string
	generate: () => string
	parse: (v: string) => string
}[] {
	const out: {
		name: string
		generate: () => string
		parse: (v: string) => string
	}[] = []
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

const legacyPrefixes: Record<string, string> = {
	asRunId: 'run_',
	asMessageId: 'msg_',
	asSessionId: 'ses_',
	asGoalId: 'goal_',
	asToolCallId: 'call_',
	asActivityId: 'act_',
	asTaskId: 'task_',
	asPlanId: 'plan_',
	asKnowledgeBaseId: 'kb_',
	asDocumentId: 'doc_',
	asChunkId: 'chk_',
	asConnectorId: 'conn_',
	asConnectorInstanceId: 'ci_',
	asTenantId: 'tnt_',
	asCredentialId: 'cred_',
	asExecutionContextId: 'ectx_',
	asMCPServerId: 'mcp_',
	asMCPClientId: 'mcpc_',
	asMCPSessionId: 'mcps_',
	asEnvironmentId: 'env_',
	asCheckpointId: 'cp_',
	asLockId: 'lock_',
	asAdvisoryId: 'adv_',
	asAdvisoryCallId: 'advc_',
	asEmergencySaveId: 'esave_',
	asMemoryId: 'mem_',
	asPluginId: 'plg_',
	asSandboxId: 'sbx_',
	asAuditEventId: 'aud_',
	asUserId: 'usr_',
	asAgentId: 'agt_',
	asMemoryStoreRef: 'mms_',
	asVaultRef: 'vlt_',
	asKnowledgeBaseRef: 'kbs_',
	asProjectId: 'prj_',
	asTopicId: 'top_',
	asSubSessionId: 'sub_',
	asHandoffId: 'hof_',
	asWorkspaceId: 'wsp_',
	asSummaryId: 'sum_',
	asDeliverableId: 'del_',
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
		// Every generated id is an opaque UUID and round-trips unchanged.
		const checked = pairs()
		expect(checked.length).toBeGreaterThan(20)

		for (const { name, generate, parse } of checked) {
			const minted = generate()
			expect(minted, name).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			)
			expect(parse(minted), name).toBe(minted)
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

	it('refuses the empty string and an arbitrary string', () => {
		expect(() => ids.asRunId('')).toThrow(InvalidIdError)
		expect(() => ids.asRunId('abc')).toThrow(InvalidIdError)
	})

	it.each(['', '../outside', 'a/b', 'a\\b', 'a.b', 'a:stream', 'a b', 'a\n', 'a\0b', 'ü'])(
		'refuses the empty or unsafe suffix %j for every generated id type',
		(suffix) => {
			for (const { name, generate, parse } of pairs()) {
				const minted = generate()
				const parserName = `as${name.slice('generate'.length)}`
				const prefix = legacyPrefixes[parserName]
				expect(prefix).toBeDefined()
				expect(() => parse(`${minted}${suffix || '/'}`)).toThrow(InvalidIdError)
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
			const uuid = ids.generateRunId()
			expect(parse(uuid)).toBe(uuid)
			expect(parse(`${prefix}Custom-A_1`)).toBe(`${prefix}Custom-A_1`)
			expect(() => parse(prefix)).toThrow(Error)
			expect(() => parse(`${prefix}../../outside`)).toThrow(Error)
		}
	})
})

describe('opaque ids retain identity across typed boundaries', () => {
	it('preserves every supported legacy kind and refuses other legacy kinds', () => {
		for (const [name, prefix] of Object.entries(legacyPrefixes)) {
			const parse = (ids as unknown as Record<string, (value: string) => string>)[name]
			if (parse === undefined) throw new Error(`Missing checked constructor: ${name}`)
			expect(parse(`${prefix}Selected-A_1`), name).toBe(`${prefix}Selected-A_1`)
			const other = prefix === 'run_' ? 'ses_Other' : 'run_Other'
			expect(() => parse(other), name).toThrow(InvalidIdError)
			expect(() => parse('thd_old'), name).toThrow(InvalidIdError)
			expect(() => parse(prefix), name).toThrow(InvalidIdError)
		}
	})

	it.each([
		'550e8400-e29b-11d4-a716-446655440000',
		'550e8400-e29b-41d4-a716-446655440000',
		'0198cc93-582e-7cfb-8511-73bd81e1ed21',
		'550e8400-e29b-81d4-a716-446655440000',
		'550E8400-E29B-41D4-A716-446655440000',
	])('checks a supported UUID without normalizing %s', (value) => {
		expect(ids.isEntityId(value, 'run')).toBe(true)
		expect(ids.asRunId(value)).toBe(value)
		expect(ids.asSessionId(value)).toBe(value)
	})

	it.each([
		undefined,
		null,
		12,
		{},
		'',
		'plain-opaque-looking-string',
		'550e8400e29b41d4a716446655440000',
		'550e8400-e29b-01d4-a716-446655440000',
		'550e8400-e29b-91d4-a716-446655440000',
		'550e8400-e29b-41d4-7716-446655440000',
		'550e8400-e29b-41d4-a716-446655440000\n',
		'550e8400-e29b-41d4-a716-446655440000/../outside',
		'run_../outside',
		'thd_old',
		'ses_different-kind',
	])('a nonthrowing predicate rejects invalid or mismatched input %j', (value) => {
		expect(ids.isEntityId(value, 'run')).toBe(false)
	})

	it('mints independent identities for every entity kind', () => {
		const generated = pairs().flatMap(({ generate }) => Array.from({ length: 20 }, generate))
		expect(new Set(generated).size).toBe(generated.length)
	})
})
