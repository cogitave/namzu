import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	ConfigLoadError,
	ConfigValueError,
	ENV_VARIABLE_NAMES,
	type LoadConfigOptions,
	loadBootstrapConfigWithProvenance,
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

	it('refuses an invalid known value instead of silently using the default', () => {
		const home = userConfig('format: xml\n')
		let error: unknown
		try {
			loadConfig({ home, cwd: tmpdir(), env: {} })
		} catch (cause) {
			error = cause
		}

		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({
			settingPath: 'format',
			source: { kind: 'file', path: join(home, '.namzu', 'config.yaml') },
		})
		expect((error as Error).message).toContain('must be one of "text", "json", or "yaml"')
	})

	it('refuses a malformed lower-precedence file even when the environment could override it', () => {
		const home = userConfig('format: xml\n')

		expect(() => loadConfig({ home, cwd: tmpdir(), env: { NAMZU_FORMAT: 'json' } })).toThrow(
			ConfigValueError,
		)
	})

	it.each([
		['NAMZU_FORMAT', { NAMZU_FORMAT: 'xml' }, 'format'],
		['NAMZU_FORMAT', { NAMZU_FORMAT: '' }, 'format'],
		['NAMZU_QUIET', { NAMZU_QUIET: 'yes' }, 'quiet'],
		['NAMZU_QUIET', { NAMZU_QUIET: '' }, 'quiet'],
	] as const)('refuses invalid explicit environment variable %s', (variable, env, settingPath) => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		let error: unknown
		try {
			loadConfig({ home, cwd, env })
		} catch (cause) {
			error = cause
		}

		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({
			settingPath,
			source: { kind: 'environment', variable },
		})
	})
})

describe('plugin runtime config', () => {
	it('reads the explicit default-off controls without inventing defaults in the file layer', () => {
		const home = userConfig(
			'plugins:\n  enabled: true\n  autoDiscovery: false\n  allowedScopes: [project]\n  hookTimeoutMs: 2500\n',
		)

		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).plugins).toEqual({
			enabled: true,
			autoDiscovery: false,
			allowedScopes: ['project'],
			hookTimeoutMs: 2500,
		})
	})

	it.each([
		['plugins.enabled', 'plugins:\n  enabled: yes\n'],
		['plugins.autoDiscovery', 'plugins:\n  autoDiscovery: later\n'],
		['plugins.allowedScopes[1]', 'plugins:\n  allowedScopes: [project, global]\n'],
		['plugins.allowedScopes', 'plugins:\n  allowedScopes: [project, project]\n'],
		['plugins.hookTimeoutMs', 'plugins:\n  hookTimeoutMs: 0\n'],
		['plugins.enable', 'plugins:\n  enable: true\n'],
	] as const)('refuses malformed or misspelled setting %s at its exact path', (path, yaml) => {
		const home = userConfig(yaml)
		let error: unknown
		try {
			loadConfig({ home, cwd: tmpdir(), env: {} })
		} catch (cause) {
			error = cause
		}

		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({ settingPath: path })
	})

	it('does not enable executable plugins from an environment variable', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))

		expect(
			loadConfig({ home, cwd: tmpdir(), env: { NAMZU_PLUGINS: 'true' } }).plugins,
		).toBeUndefined()
		expect(ENV_VARIABLE_NAMES.plugins).toBeUndefined()
	})

	it('does not let NAMZU_PROFILE become an executable-code authority', () => {
		const home = userConfig(
			'profiles:\n  executable:\n    plugins:\n      enabled: true\n      allowedScopes: [project]\n',
		)
		let error: unknown
		try {
			loadConfig({ home, cwd: tmpdir(), env: { NAMZU_PROFILE: 'executable' } })
		} catch (cause) {
			error = cause
		}

		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({ settingPath: 'profiles.executable.plugins' })
	})
})

describe('pre-trust bootstrap config', () => {
	it('does not read or validate the project layer before trust', () => {
		const home = userConfig('format: yaml\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), '{ "format": ')

		const bootstrap = loadBootstrapConfigWithProvenance({ home, cwd, env: {} })

		expect(bootstrap.config.format).toBe('yaml')
		expect(Object.values(bootstrap.provenance)).not.toContainEqual(
			expect.objectContaining({ kind: 'project-file' }),
		)
		expect(() => loadConfigWithProvenance({ home, cwd, env: {} })).toThrow(ConfigLoadError)
	})

	it('defers a profile declared only by the trusted project layer', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({ profiles: { review: { format: 'json' } } }),
		)

		expect(
			loadBootstrapConfigWithProvenance({
				home,
				cwd,
				env: {},
				profile: 'review',
			}).config.format,
		).toBe('text')
		expect(loadConfigWithProvenance({ home, cwd, env: {}, profile: 'review' }).config.format).toBe(
			'json',
		)
	})
})

describe('terminal notification config', () => {
	it('reads an event filter and explicit method from the project file', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({
				tui: {
					notifications: ['approval-required'],
					notificationMethod: 'bel',
				},
			}),
		)

		expect(loadConfig({ home: tmpdir(), cwd, env: {} }).tui).toEqual({
			notifications: ['approval-required'],
			notificationMethod: 'bel',
		})
	})

	it.each([
		{ notifications: ['turn-complet'] },
		{ notifications: 'yes' },
		{ notifications: true, notificationMethod: 'desktop' },
	])('refuses an invalid notification shape instead of changing it: $notifications', (tui) => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ tui }))

		expect(() => loadConfig({ home: tmpdir(), cwd, env: {} })).toThrow(ConfigValueError)
	})
})

describe('semantic validation of known file settings', () => {
	function projectError(body: unknown): ConfigValueError {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(body))
		try {
			loadConfig({
				home: mkdtempSync(join(tmpdir(), 'namzu-home-')),
				cwd,
				env: {},
			})
			expect.unreachable('an invalid known value must not load')
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigValueError)
			return error as ConfigValueError
		}
	}

	it.each([
		[{ quiet: 'yes' }, 'quiet'],
		[{ permissions: [] }, 'permissions'],
		[{ permissionChecks: {} }, 'permissionChecks'],
		[{ mcpServers: [] }, 'mcpServers'],
		[{ sandbox: { enabled: 'yes' } }, 'sandbox.enabled'],
		[{ sandbox: { requireIsolation: 'filesystem' } }, 'sandbox.requireIsolation'],
		[{ sandbox: { requireIsolation: ['filesystem', 'memory'] } }, 'sandbox.requireIsolation[1]'],
		[{ sandbox: { workspace: 'session' } }, 'sandbox.workspace'],
		[{ sandbox: { teardownTimeoutMs: -1 } }, 'sandbox.teardownTimeoutMs'],
		[{ sandbox: { teardownTimeoutMs: 1.5 } }, 'sandbox.teardownTimeoutMs'],
		[
			{
				telemetry: {
					sessionExport: { destination: 'out.jsonl', redactors: 'secrets' },
				},
			},
			'telemetry.sessionExport.redactors',
		],
		[
			{
				telemetry: {
					sessionExport: { destination: 'out.jsonl', eventTypes: ['ok', 7] },
				},
			},
			'telemetry.sessionExport.eventTypes[1]',
		],
		[{ tui: { notifications: true, notificationMethod: 'desktop' } }, 'tui.notificationMethod'],
	] as const)('names the exact invalid config path %#', (body, settingPath) => {
		expect(projectError(body).settingPath).toBe(settingPath)
	})

	it('refuses an invalid managed value rather than letting a lower layer win', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-managed-'))
		const home = join(root, 'home')
		const cwd = join(root, 'cwd')
		const managedPath = join(root, 'managed.json')
		mkdirSync(home)
		mkdirSync(cwd)
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: true } }))
		writeFileSync(
			managedPath,
			JSON.stringify({
				sandbox: { requireIsolation: ['filesystem', 'memory'] },
			}),
		)

		let error: unknown
		try {
			loadConfig({ home, cwd, env: {}, managedPath })
		} catch (cause) {
			error = cause
		}
		expect(error).toMatchObject({
			settingPath: 'sandbox.requireIsolation[1]',
			source: { kind: 'file', path: managedPath },
		})
	})

	it('continues to accept and ignore unknown keys instead of inventing strict mode', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({
				futureSetting: true,
				sandbox: { enabled: true, futureControl: 'x' },
			}),
		)

		const config = loadConfig({ home: tmpdir(), cwd, env: {} })
		expect(config.sandbox).toEqual({ enabled: true })
		expect('futureSetting' in config).toBe(false)
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
 * nobody watching. See "refuse do not degrade".
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

		const { config, provenance } = loadConfigWithProvenance({
			home,
			cwd,
			env: {},
		})

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
		const { config, provenance } = loadConfigWithProvenance({
			home,
			cwd,
			env: {},
		})

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
		type ConfigWithHypotheticalField = NamzuCliConfig & {
			readonly hypothetical?: string
		}
		// @ts-expect-error — the production `ENV_VARIABLE_NAMES` has no
		// `hypothetical` entry; a new config field must add one before this
		// type-checks.
		const coverage: {
			readonly [K in keyof Required<ConfigWithHypotheticalField>]: string | undefined
		} = ENV_VARIABLE_NAMES
		expect(coverage.format).toBe('NAMZU_FORMAT')
	})
})

describe('web', () => {
	it('reads fetch as a boolean and refuses anything else', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-web-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'web:\n  fetch: true\n')
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).web).toEqual({ fetch: true })

		writeFileSync(join(home, '.namzu', 'config.yaml'), 'web:\n  fetch: yes\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(/web\.fetch/)

		writeFileSync(join(home, '.namzu', 'config.yaml'), 'web:\n  search: true\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(/web\.search/)
	})

	it('is not settable from the environment', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-web-'))
		expect(
			loadConfig({ home, cwd: tmpdir(), env: { NAMZU_WEB_FETCH: 'true' } }).web,
		).toBeUndefined()
	})
})

describe('hooks', () => {
	it('reads events, matchers and deadlines, and refuses what it does not know', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-hooks-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'config.yaml'),
			'hooks:\n  pre_tool_use:\n    - matcher: bash\n      command: ./check.sh\n      timeoutMs: 500\n  run_end:\n    - command: notify-send done\n',
		)
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).hooks).toEqual({
			pre_tool_use: [{ matcher: 'bash', command: './check.sh', timeoutMs: 500 }],
			run_end: [{ command: 'notify-send done' }],
		})

		for (const [bad, path] of [
			['hooks:\n  on_save:\n    - command: x\n', 'hooks.on_save'],
			['hooks:\n  run_end:\n    - matcher: x\n', 'hooks.run_end[0].command'],
			['hooks:\n  run_end:\n    - command: x\n      shell: zsh\n', 'hooks.run_end[0].shell'],
			[
				'hooks:\n  run_end:\n    - command: x\n      timeoutMs: soon\n',
				'hooks.run_end[0].timeoutMs',
			],
		]) {
			writeFileSync(join(home, '.namzu', 'config.yaml'), bad)
			expect(() => loadConfig({ home, cwd: tmpdir(), env: {} }), bad).toThrow(path)
		}
	})

	it('is not settable from the environment', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-hooks-'))
		expect(loadConfig({ home, cwd: tmpdir(), env: { NAMZU_HOOKS: 'x' } }).hooks).toBeUndefined()
	})
})
