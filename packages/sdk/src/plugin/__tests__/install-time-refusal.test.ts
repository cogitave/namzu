import { describe, expect, it } from 'vitest'

import { type PluginManifest, PluginManifestSchema } from '../../types/plugin/index.js'
import { assertEnableable } from '../loader.js'

/**
 * The manifest schema accepts and validates `skills`, `connectors` and
 * `personas` with per-type caps, and enabling then refused all three
 * wholesale — before any contribution loaded. So a plugin shipping four
 * tools and one skill validated clean, installed clean, was persisted as
 * `installed`, and contributed zero tools.
 *
 * The refusal was right. Its position was not: a plugin that can never
 * enable was being recorded under a status that says it is fine, and the
 * author found out only when something tried to use it — at which point
 * every supported contribution it also shipped went down with it.
 */

const manifest = (extra: Partial<PluginManifest> = {}): PluginManifest =>
	({
		name: 'demo',
		version: '1.0.0',
		...extra,
	}) as PluginManifest

describe('a manifest declaring what the runtime cannot enable', () => {
	it.each(['skills', 'connectors', 'personas'] as const)('is refused for %s', (kind) => {
		expect(() => assertEnableable(manifest({ [kind]: ['x'] } as never))).toThrow(new RegExp(kind))
	})

	it('names every unsupported type, not just the first', () => {
		expect(() => assertEnableable(manifest({ skills: ['a'], personas: ['b'] } as never))).toThrow(
			/skills, personas/,
		)
	})

	it('says what would have been lost, so the refusal is actionable', () => {
		// The author's real question is "why did my four tools not load".
		expect(() => assertEnableable(manifest({ skills: ['a'] } as never))).toThrow(
			/contributes nothing/,
		)
	})

	it('points at the path that does work', () => {
		// The registries all exist and are wired to agents through host
		// configuration; what is missing is the manifest route into them.
		expect(() => assertEnableable(manifest({ skills: ['a'] } as never))).toThrow(/registries/)
	})
})

describe('a manifest the runtime can enable', () => {
	it('passes with supported contributions', () => {
		expect(() =>
			assertEnableable(manifest({ tools: ['./tools.js'], hooks: ['./hooks.js'] } as never)),
		).not.toThrow()
	})

	it('passes with the keys present but empty', () => {
		// An empty array declares nothing, so there is nothing to refuse.
		expect(() =>
			assertEnableable(manifest({ skills: [], connectors: [], personas: [] } as never)),
		).not.toThrow()
	})

	it('passes with no contributions at all', () => {
		expect(() => assertEnableable(manifest())).not.toThrow()
	})
})

describe('a plugin MCP declaration', () => {
	it.each([
		['url', 'https://example.test/mcp'],
		['headers', { Authorization: 'Bearer secret' }],
		['inheritEnv', ['TOKEN']],
		['requireApproval', true],
	] as const)('refuses an unsupported %s field instead of silently discarding it', (key, value) => {
		expect(() =>
			PluginManifestSchema.parse({
				name: 'demo',
				version: '1.0.0',
				description: 'test',
				mcpServers: [{ name: 'server', command: 'node', [key]: value }],
			}),
		).toThrow(new RegExp(key))
	})

	it('accepts a bounded connect deadline and refuses a zero deadline', () => {
		const server = { name: 'server', command: 'node', connectTimeoutMs: 500 }
		expect(
			PluginManifestSchema.parse({
				name: 'demo',
				version: '1.0.0',
				description: 'test',
				mcpServers: [server],
			}).mcpServers?.[0]?.connectTimeoutMs,
		).toBe(500)
		expect(() =>
			PluginManifestSchema.parse({
				name: 'demo',
				version: '1.0.0',
				description: 'test',
				mcpServers: [{ ...server, connectTimeoutMs: 0 }],
			}),
		).toThrow()
	})
})
