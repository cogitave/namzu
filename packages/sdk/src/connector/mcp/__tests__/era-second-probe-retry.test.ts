import { describe, expect, it, vi } from 'vitest'

/**
 * W4 nice-to-have: the second probe `resolveMcpEra` sends when a `-32022`
 * names a mutually-supported version other than the one first attempted.
 *
 * `MCP_MODERN_VERSIONS` holds exactly one entry in production
 * (`2026-07-28`), so the `outcome.kind === 'retry'` branch in
 * `resolveMcpEra` — "try again at the version both sides actually agree
 * on" — has no test that reaches it: every scripted server in
 * `era-conformance.test.ts` either speaks the one modern version this
 * client offers or none at all. There is no THIRD version to retry at.
 *
 * This file is the white-box exception: it mocks the constants module to
 * fabricate a second modern version for `resolveMcpEra`'s own internal
 * reads of `MCP_MODERN_VERSIONS` / `MCP_SUPPORTED_PROTOCOL_VERSIONS`, then
 * exercises the retry path directly against an injected probe — no
 * `MCPClient`, no transport. The real `MCP_MODERN_VERSIONS` constant is
 * never written to; only this test FILE's module registry sees the
 * fabricated pair, because vitest isolates module state per test file, and
 * every other file in this package still imports the genuine, single-entry
 * constant.
 */

// `vi.hoisted` because `vi.mock`'s factory below is hoisted above ordinary
// top-level `const`s in this file — referencing a plain module-scope
// constant from inside it throws a temporal-dead-zone error at collection
// time, which is exactly what happened here before this existed.
const { NEWEST_FAKE_MODERN, OLDER_FAKE_MODERN } = vi.hoisted(() => ({
	NEWEST_FAKE_MODERN: '2027-02-01',
	// The real, single production modern version — kept as the OLDER of the
	// two fakes so the retry lands on a version this client actually
	// implements end to end everywhere else in the suite.
	OLDER_FAKE_MODERN: '2026-07-28',
}))

vi.mock('../../../constants/mcp/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../constants/mcp/index.js')>()
	const fakeModern = [NEWEST_FAKE_MODERN, OLDER_FAKE_MODERN]
	return {
		...actual,
		MCP_MODERN_VERSIONS: fakeModern,
		// `newestMutuallySupported` filters against THIS list, not against
		// `MCP_MODERN_VERSIONS` directly — both must carry the fabricated
		// pair, or the retry's chosen version reads as unsupported and the
		// resolution falls back to legacy instead of retrying.
		MCP_SUPPORTED_PROTOCOL_VERSIONS: [...fakeModern, ...actual.MCP_LEGACY_VERSIONS],
	}
})

import { createMcpEraCache, resolveMcpEra } from '../era.js'
import { MCPProtocolError } from '../errors.js'

describe('resolveMcpEra retries once at the server-named mutually-supported version', () => {
	it('probes exactly twice, the second time at that version, and caches the result', async () => {
		const cache = createMcpEraCache()
		const key = 'fixture-two-probe'
		const attempts: string[] = []

		const probe = vi.fn(async (version: string) => {
			attempts.push(version)
			if (version === NEWEST_FAKE_MODERN) {
				// A real `-32022` reply decodes into exactly this shape — see
				// `protocolErrorFromReply` in `errors.ts`.
				return {
					kind: 'error' as const,
					error: new MCPProtocolError(-32022, 'Unsupported protocol version', {
						supported: [OLDER_FAKE_MODERN],
					}),
				}
			}
			if (version === OLDER_FAKE_MODERN) {
				return {
					kind: 'result' as const,
					result: {
						supportedVersions: [OLDER_FAKE_MODERN],
						capabilities: {},
						serverInfo: { name: 'two-version-fixture', version: '1' },
					},
				}
			}
			throw new Error(`unexpected probe version: ${version}`)
		})

		const resolution = await resolveMcpEra({
			cache,
			key,
			probe,
			probeSupported: true,
			serverName: 'two-version-fixture',
		})

		// Exactly two probes, in order, and the second at the version the
		// server actually named as mutually supported — not at whatever this
		// client would have tried next on its own.
		expect(attempts).toEqual([NEWEST_FAKE_MODERN, OLDER_FAKE_MODERN])
		expect(resolution.probes).toBe(2)
		expect(resolution.fromCache).toBe(false)
		expect(resolution.era).toEqual({ kind: 'modern', version: OLDER_FAKE_MODERN })
		expect(resolution.discover?.supportedVersions).toEqual([OLDER_FAKE_MODERN])

		// Cached afterwards, under the same key, at the version the retry
		// actually settled on.
		expect(cache.get(key)).toEqual({ kind: 'modern', version: OLDER_FAKE_MODERN })
	})
})
