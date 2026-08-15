import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	ConfigLoadError,
	ENV_VARIABLE_NAMES,
	type LoadConfigOptions,
	loadConfig,
	loadConfigWithProvenance,
} from './load.js'
import type { NamzuCliConfig } from './schema.js'

function userConfig(contents: string): string {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	writeFileSync(join(home, '.namzu', 'config.yaml'), contents)
	return home
}

describe('loadConfig cascade', () => {
	it('returns defaults when nothing is configured', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		const cfg = loadConfig({ home, cwd, env: {} })
		expect(cfg.format).toBe('text')
		expect(cfg.quiet).toBe(false)
	})

	it('reads user config from ~/.namzu/config.yaml', () => {
		const home = userConfig('format: yaml\nquiet: true\n')
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.format).toBe('yaml')
		expect(cfg.quiet).toBe(true)
	})

	it('project config overrides user config', () => {
		const home = userConfig('format: yaml\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ format: 'json' }))
		const cfg = loadConfig({ home, cwd, env: {} })
		expect(cfg.format).toBe('json')
	})

	it('env vars override file config', () => {
		const home = userConfig('format: yaml\n')
		const cfg = loadConfig({
			home,
			cwd: tmpdir(),
			env: { NAMZU_FORMAT: 'text' },
		})
		expect(cfg.format).toBe('text')
	})

	it('ignores invalid format values silently', () => {
		const home = userConfig('format: xml\n')
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.format).toBe('text')
	})
})

/**
 * A file that is not there is a default; a file that is there and cannot be
 * read is a refusal.
 *
 * These are the same branch until you separate them, and the shared answer was
 * `{}`. `permissions` is read from these files, so `{}` is an empty rule table,
 * and a headless run sends everything no rule covered to `auto` — an operator's
 * deny list becomes approval of the same calls, silently, on the path with
 * nobody watching. See `docs/conventions/refuse-do-not-degrade.md`.
 */
describe('a config that cannot be read', () => {
	it('refuses malformed yaml instead of reading it as no settings', () => {
		const home = userConfig(': : : not yaml\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(ConfigLoadError)
	})

	it('refuses malformed json instead of reading it as no settings', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), '{ "format": ')
		expect(() => loadConfig({ home: tmpdir(), cwd, env: {} })).toThrow(ConfigLoadError)
	})

	it('names the file it could not read', () => {
		const home = userConfig(': : : not yaml\n')
		const path = join(home, '.namzu', 'config.yaml')
		try {
			loadConfig({ home, cwd: tmpdir(), env: {} })
			expect.unreachable('a malformed config must not load')
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigLoadError)
			expect((err as ConfigLoadError).path).toBe(path)
			// The operator has to be able to find the file from the message
			// alone — this is printed without a stack trace.
			expect((err as ConfigLoadError).message).toContain(path)
		}
	})

	it('refuses a file whose top level is not a mapping', () => {
		const home = userConfig('just a string\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(ConfigLoadError)
	})

	it('refuses a file that exists but is not a readable file', () => {
		// A directory where the config belongs. Portable stand-in for the
		// permission error the check is really about: both mean the path is
		// occupied and its contents cannot be established, and neither is
		// ENOENT. Mode bits are not a usable test fixture on every platform
		// this runs on; this is.
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		mkdirSync(join(home, '.namzu', 'config.yaml'), { recursive: true })
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(ConfigLoadError)
	})

	it('does not drop a permission table it failed to parse', () => {
		// The finding, stated as the caller sees it. Before: this returned a
		// config with no `permissions` key and the run continued unrestricted.
		const home = userConfig('permissions:\n  bash: "deny"\n   badly: indented\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(ConfigLoadError)
	})
})

describe('a config that is legitimately absent or empty', () => {
	it('treats a missing file as no settings', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).not.toThrow()
	})

	it('treats an empty file as no settings', () => {
		// Emptied on purpose says nothing, which is what it looks like. Only
		// content namzu cannot read is a refusal.
		const home = userConfig('')
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.format).toBe('text')
	})

	it('treats a comments-only file as no settings', () => {
		const home = userConfig('# nothing configured yet\n')
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.format).toBe('text')
	})

	it('treats a missing parent directory as no settings', () => {
		// ENOTDIR rather than ENOENT: nothing was ever written at that path
		// either way.
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		writeFileSync(join(home, '.namzu'), 'not a directory')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).not.toThrow()
	})
})

/**
 * `loadConfigWithProvenance` is the one real merge path now — `loadConfig` is
 * `loadConfigWithProvenance(opts).config`. These tests exercise the
 * provenance half directly: which `ConfigSource` won each key, and the two
 * invariants that make provenance trustworthy rather than decorative — a key
 * present in `config` is present in `provenance` and vice versa, and a key
 * nothing set is fabricated in neither.
 */
describe('loadConfigWithProvenance', () => {
	it('records the project file as the source when it beats the user file, matching Object.assign precedence', () => {
		const home = userConfig('format: yaml\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		const projectPath = join(cwd, 'namzu.config.json')
		writeFileSync(projectPath, JSON.stringify({ format: 'json' }))

		const { config, provenance } = loadConfigWithProvenance({ home, cwd, env: {} })

		expect(config.format).toBe('json')
		expect(provenance.format).toEqual({
			kind: 'project-file',
			path: resolve(cwd, 'namzu.config.json'),
		})
	})

	it('gives every key present on the resolved config a provenance entry, and no others, across all four sources', () => {
		// format: nothing overrides it -> default.
		// mcpServers: user-file.
		// permissions: project-file.
		// quiet: env.
		// sandbox: nothing sets it at all -> must be absent from both maps.
		const home = userConfig('mcpServers:\n  fs:\n    command: echo\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ permissions: {} }))

		const { config, provenance } = loadConfigWithProvenance({
			home,
			cwd,
			env: { NAMZU_QUIET: '1' },
		})

		expect(Object.keys(config).sort()).toEqual(['format', 'mcpServers', 'permissions', 'quiet'])
		expect(Object.keys(provenance).sort()).toEqual(['format', 'mcpServers', 'permissions', 'quiet'])

		expect(provenance.format).toEqual({ kind: 'default' })
		expect(provenance.mcpServers).toEqual({
			kind: 'user-file',
			path: join(home, '.namzu', 'config.yaml'),
		})
		expect(provenance.permissions).toEqual({
			kind: 'project-file',
			path: resolve(cwd, 'namzu.config.json'),
		})
		expect(provenance.quiet).toEqual({ kind: 'env', variable: 'NAMZU_QUIET' })
	})

	it('does not fabricate a default source for a key DEFAULT_CONFIG does not carry', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		const { config, provenance } = loadConfigWithProvenance({ home, cwd, env: {} })

		expect(config.sandbox).toBeUndefined()
		expect('sandbox' in provenance).toBe(false)
	})

	it('names the env variable, not just "env", when env wins over a project-file value', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ quiet: false }))

		const { config, provenance } = loadConfigWithProvenance({
			home: mkdtempSync(join(tmpdir(), 'namzu-home-')),
			cwd,
			env: { NAMZU_QUIET: '1' },
		})

		expect(config.quiet).toBe(true)
		expect(provenance.quiet).toEqual({ kind: 'env', variable: 'NAMZU_QUIET' })
	})
})

describe('type-level guarantees', () => {
	it('loadConfig keeps its exact public signature — (opts?: LoadConfigOptions) => NamzuCliConfig', () => {
		// `loadConfig` is re-exported from `../index.js` for embedded consumers
		// who already depend on this exact shape. If a future refactor makes
		// `loadConfig` return something wider (e.g. `{ config, provenance }`
		// directly, skipping the `.config` projection), this assignment stops
		// type-checking.
		const signature: (opts?: LoadConfigOptions) => NamzuCliConfig = loadConfig
		expect(typeof signature).toBe('function')
	})

	it('ENV_VARIABLE_NAMES is total over NamzuCliConfig — a new field must decide its env variable before this compiles', () => {
		// Same discipline `ConfigReaders` already gives `sanitize` for reading a
		// file, extended to the env layer's provenance: a field added to
		// `NamzuCliConfig` without a matching `ENV_VARIABLE_NAMES` entry (even
		// an explicit `undefined`) must fail to compile here, not silently
		// resolve to "env never sets it" at runtime with no one having decided
		// that on purpose.
		type ConfigWithHypotheticalField = NamzuCliConfig & { readonly hypothetical?: string }
		// @ts-expect-error — the production `ENV_VARIABLE_NAMES` has no
		// `hypothetical` entry; a new config field must add one before this
		// type-checks.
		const coverage: {
			readonly [K in keyof Required<ConfigWithHypotheticalField>]: string | undefined
		} = ENV_VARIABLE_NAMES
		expect(coverage.format).toBe('NAMZU_FORMAT')
	})
})
