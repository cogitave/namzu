import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
	shortHomePath,
	stripByteOrderMark,
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

describe('automatic memory recall config', () => {
	it('preserves explicit opt-out from a file', () => {
		const home = userConfig('memory:\n  recall: false\n')
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).memory).toEqual({
			recall: false,
		})
	})
	it.each(['memory: true\n', 'memory:\n  recall: sometimes\n', 'memory:\n  magic: true\n'])(
		'rejects malformed policy %s',
		(contents) => {
			const home = userConfig(contents)
			expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(ConfigValueError)
		},
	)
})

describe('workflow config', () => {
	it('reads the two caps from a file', () => {
		const home = userConfig('workflow:\n  maxConcurrency: 4\n  maxAgents: 600\n')
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).workflow).toEqual({
			maxConcurrency: 4,
			maxAgents: 600,
		})
	})
	it('accepts the limits themselves and leaves absent keys to the defaults', () => {
		const home = userConfig('workflow:\n  maxConcurrency: 16\n')
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).workflow).toEqual({ maxConcurrency: 16 })
		const top = userConfig('workflow:\n  maxAgents: 1000\n')
		expect(loadConfig({ home: top, cwd: tmpdir(), env: {} }).workflow).toEqual({ maxAgents: 1000 })
		expect(loadConfig({ home: userConfig(''), cwd: tmpdir(), env: {} }).workflow).toBeUndefined()
	})
	it.each([
		'workflow: 4\n',
		'workflow:\n  maxConcurrency: 17\n',
		'workflow:\n  maxConcurrency: 0\n',
		'workflow:\n  maxAgents: 1001\n',
		'workflow:\n  maxAgents: 2.5\n',
		'workflow:\n  maxAgents: many\n',
		'workflow:\n  turbo: true\n',
	])('rejects %s', (contents) => {
		const home = userConfig(contents)
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(ConfigValueError)
	})
	it('is never set from the environment', () => {
		const home = userConfig('')
		expect(
			loadConfig({ home, cwd: tmpdir(), env: { NAMZU_WORKFLOW: '{"maxAgents":5}' } }).workflow,
		).toBeUndefined()
	})
})

describe('skills config', () => {
	it('reads builtin and disabled from a file', () => {
		const home = userConfig(
			'skills:\n  builtin: false\n  disabled:\n    - noisy\n    - " other "\n',
		)
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).skills).toEqual({
			builtin: false,
			disabled: ['noisy', 'other'],
		})
	})
	it('reads suggest and suggestMinToolCalls from a file', () => {
		const home = userConfig('skills:\n  suggest: false\n  suggestMinToolCalls: 8\n')
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).skills).toEqual({
			suggest: false,
			suggestMinToolCalls: 8,
		})
	})
	it.each([
		'skills: true\n',
		'skills:\n  suggest: sometimes\n',
		'skills:\n  suggestMinToolCalls: 0\n',
		'skills:\n  suggestMinToolCalls: 2.5\n',
		'skills:\n  suggestMinToolCalls: "6"\n',
		'skills:\n  builtin: sometimes\n',
		'skills:\n  disabled: noisy\n',
		'skills:\n  enabled: true\n',
	])('rejects malformed skills config %s', (contents) => {
		const home = userConfig(contents)
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(ConfigValueError)
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

	it.each(['kitty', 'ghostty'] as const)(
		'accepts the idle notice and the %s method',
		(notificationMethod) => {
			const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
			writeFileSync(
				join(cwd, 'namzu.config.json'),
				JSON.stringify({ tui: { notifications: ['idle-prompt'], notificationMethod } }),
			)

			expect(loadConfig({ home: tmpdir(), cwd, env: {} }).tui).toEqual({
				notifications: ['idle-prompt'],
				notificationMethod,
			})
		},
	)

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
		[{ sandbox: { allowEscape: 'ask' } }, 'sandbox.allowEscape'],
		[{ sandbox: { allowUnattendedEscape: 1 } }, 'sandbox.allowUnattendedEscape'],
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
		[{ toolResultScreens: 'correspondence' }, 'toolResultScreens'],
		[{ toolResultScreens: ['injection', 'nope'] }, 'toolResultScreens[1]'],
		[{ toolResultScreens: [42] }, 'toolResultScreens[0]'],
		[{ toolResultScreens: [{}] }, 'toolResultScreens[0].name'],
		[{ toolResultScreens: [{ name: 'nope' }] }, 'toolResultScreens[0].name'],
		// An option the named screen does not read. Refused rather than
		// carried: it would parse, install, and exempt nothing, which reads to
		// an operator as the exemption being in force.
		[
			{ toolResultScreens: [{ name: 'injection', passthroughTools: ['lookup'] }] },
			'toolResultScreens[0].passthroughTools',
		],
		[
			{ toolResultScreens: [{ name: 'correspondence', passthroughTools: 'lookup' }] },
			'toolResultScreens[0].passthroughTools',
		],
		[
			{ toolResultScreens: [{ name: 'correspondence', passthroughTools: [7] }] },
			'toolResultScreens[0].passthroughTools[0]',
		],
		[
			{ toolResultScreens: [{ name: 'correspondence', passthroughTools: ['  '] }] },
			'toolResultScreens[0].passthroughTools[0]',
		],
		[
			{ toolResultScreens: [{ name: 'correspondence', typo: ['lookup'] }] },
			'toolResultScreens[0].typo',
		],
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

	it('reads the two escape switches as written', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({
				sandbox: { enabled: true, allowEscape: false, allowUnattendedEscape: true },
			}),
		)

		const config = loadConfig({ home: tmpdir(), cwd, env: {} })
		expect(config.sandbox).toEqual({
			enabled: true,
			allowEscape: false,
			allowUnattendedEscape: true,
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
		// config with no `permissions` key and the turn continued unrestricted.
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
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).web).toEqual({
			fetch: true,
		})

		writeFileSync(join(home, '.namzu', 'config.yaml'), 'web:\n  fetch: yes\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(/web\.fetch/)

		writeFileSync(join(home, '.namzu', 'config.yaml'), 'web:\n  search: live\n')
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).web).toEqual({
			search: 'live',
		})
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'web:\n  search: true\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(/web\.search/)
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'web:\n  search: [live]\n')
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
			'hooks:\n  pre_tool_use:\n    - matcher: bash\n      command: ./check.sh\n      timeoutMs: 500\n  turn_end:\n    - command: notify-send done\n',
		)
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).hooks).toEqual({
			pre_tool_use: [{ matcher: 'bash', command: './check.sh', timeoutMs: 500 }],
			turn_end: [{ command: 'notify-send done' }],
		})

		for (const [bad, path] of [
			['hooks:\n  on_save:\n    - command: x\n', 'hooks.on_save'],
			['hooks:\n  turn_end:\n    - matcher: x\n', 'hooks.turn_end[0].command'],
			['hooks:\n  turn_end:\n    - command: x\n      shell: zsh\n', 'hooks.turn_end[0].shell'],
			[
				'hooks:\n  turn_end:\n    - command: x\n      timeoutMs: soon\n',
				'hooks.turn_end[0].timeoutMs',
			],
			// A run-era name is refused, and the refusal names its replacement.
			['hooks:\n  run_end:\n    - command: x\n', 'hooks.run_end was renamed; name it `turn_end`'],
			['hooks:\n  run_start:\n    - command: x\n', 'name it `turn_start`'],
		]) {
			writeFileSync(join(home, '.namzu', 'config.yaml'), bad)
			expect(() => loadConfig({ home, cwd: tmpdir(), env: {} }), bad).toThrow(path)
		}
	})

	it('reads the new events and the `if`, `once` and `statusMessage` options', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-hooks-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'config.yaml'),
			[
				'hooks:',
				'  post_tool_use_failure:',
				'    - command: ./why.sh',
				'  permission_request:',
				'    - matcher: "^(bash|write)$"',
				'      command: ./decide.sh',
				'  notification:',
				'    - matcher: approval_required',
				'      command: notify-send waiting',
				'  pre_tool_use:',
				'    - if: "Bash(git push *)"',
				'      once: true',
				'      statusMessage: Checking the push',
				'      command: ./guard.sh',
				'',
			].join('\n'),
		)
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).hooks).toEqual({
			post_tool_use_failure: [{ command: './why.sh' }],
			permission_request: [{ matcher: '^(bash|write)$', command: './decide.sh' }],
			notification: [{ matcher: 'approval_required', command: 'notify-send waiting' }],
			pre_tool_use: [
				{
					command: './guard.sh',
					if: 'Bash(git push *)',
					once: true,
					statusMessage: 'Checking the push',
				},
			],
		})

		for (const [bad, path] of [
			['hooks:\n  turn_end:\n    - command: x\n      if: 3\n', 'hooks.turn_end[0].if'],
			['hooks:\n  turn_end:\n    - command: x\n      once: soon\n', 'hooks.turn_end[0].once'],
			[
				'hooks:\n  turn_end:\n    - command: x\n      statusMessage: ""\n',
				'hooks.turn_end[0].statusMessage',
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

describe('statusLine', () => {
	it('reads a command with padding and a refresh interval, and refuses what it does not know', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-statusline-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'config.yaml'),
			'statusLine:\n  type: command\n  command: ~/bin/line.sh\n  padding: 2\n  refreshInterval: 5\n',
		)
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).statusLine).toEqual({
			type: 'command',
			command: '~/bin/line.sh',
			padding: 2,
			refreshInterval: 5,
		})
		for (const [bad, path] of [
			['statusLine:\n  padding: 1\n', 'statusLine.command'],
			['statusLine:\n  command: x\n  shell: zsh\n', 'statusLine.shell'],
			['statusLine:\n  command: x\n  type: file\n', 'statusLine.type'],
			['statusLine:\n  command: x\n  refreshInterval: 0\n', 'statusLine.refreshInterval'],
			['statusLine:\n  command: x\n  padding: -1\n', 'statusLine.padding'],
		]) {
			writeFileSync(join(home, '.namzu', 'config.yaml'), bad)
			expect(() => loadConfig({ home, cwd: tmpdir(), env: {} }), bad).toThrow(path)
		}
	})

	it('is not settable from the environment', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-statusline-'))
		expect(
			loadConfig({ home, cwd: tmpdir(), env: { NAMZU_STATUS_LINE: 'x' } }).statusLine,
		).toBeUndefined()
	})

	it('comes from a project file only once the folder is trusted, as hooks do', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-statusline-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-statusline-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({ statusLine: { command: 'echo hi' } }),
		)
		expect(
			loadBootstrapConfigWithProvenance({ home, cwd, env: {} }).config.statusLine,
		).toBeUndefined()
		expect(loadConfig({ home, cwd, env: {} }).statusLine).toEqual({
			command: 'echo hi',
		})
	})
})

describe('compaction', () => {
	it('reads the strategy and a window override, and refuses what it does not know', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-compaction-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'config.yaml'),
			'compaction:\n  strategy: salience\n  contextWindowTokens: 20000\n  consolidate: true\n  deduplicateObservations: false\n  retainedToolPreviewChars: 0\n  recallEvidence: true\n  resolveEvidenceQueries: false\n',
		)
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).compaction).toEqual({
			strategy: 'salience',
			contextWindowTokens: 20000,
			consolidate: true,
			deduplicateObservations: false,
			retainedToolPreviewChars: 0,
			recallEvidence: true,
			resolveEvidenceQueries: false,
		})

		for (const [bad, path] of [
			['compaction:\n  strategy: clever\n', 'compaction.strategy'],
			['compaction:\n  contextWindowTokens: many\n', 'compaction.contextWindowTokens'],
			['compaction:\n  softTarget: 0.5\n', 'compaction.softTarget'],
			['compaction:\n  consolidate: yes please\n', 'compaction.consolidate'],
			['compaction:\n  deduplicateObservations: maybe\n', 'compaction.deduplicateObservations'],
			['compaction:\n  recallEvidence: maybe\n', 'compaction.recallEvidence'],
			['compaction:\n  resolveEvidenceQueries: maybe\n', 'compaction.resolveEvidenceQueries'],
			['compaction:\n  retainedToolPreviewChars: -1\n', 'compaction.retainedToolPreviewChars'],
			['compaction:\n  retainedToolPreviewChars: 1.5\n', 'compaction.retainedToolPreviewChars'],
			['compaction:\n  retainedToolPreviewChars: nope\n', 'compaction.retainedToolPreviewChars'],
		]) {
			writeFileSync(join(home, '.namzu', 'config.yaml'), bad)
			expect(() => loadConfig({ home, cwd: tmpdir(), env: {} }), bad).toThrow(path)
		}
	})

	it('is not settable from the environment', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-compaction-'))
		expect(
			loadConfig({ home, cwd: tmpdir(), env: { NAMZU_COMPACTION: 'salience' } }).compaction,
		).toBeUndefined()
	})
})

it('preserves identifier grounding opt-out and rejects nonboolean values', () => {
	const home = userConfig('memory:\n  identifierGrounding: false\n')
	expect(loadConfig({ home, cwd: tmpdir(), env: {} }).memory).toEqual({
		identifierGrounding: false,
	})
	const invalid = userConfig('memory:\n  identifierGrounding: sometimes\n')
	expect(() => loadConfig({ home: invalid, cwd: tmpdir(), env: {} })).toThrow(ConfigValueError)
})

describe('a config file that is not valid', () => {
	const BOM = '﻿'

	function projectWith(contents: string): string {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), contents)
		return cwd
	}

	function managedWith(contents: string): string {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-managed-'))
		const path = join(dir, 'config.json')
		writeFileSync(path, contents)
		return path
	}

	it('loads a project file saved with a byte-order mark as if it were absent', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = projectWith(`${BOM}${JSON.stringify({ format: 'json' })}`)
		expect(loadConfig({ home, cwd, env: {} }).format).toBe('json')
	})

	it('loads a user file saved with a byte-order mark', () => {
		const home = userConfig(`${BOM}format: yaml\n`)
		expect(loadConfig({ home, cwd: tmpdir(), env: {} }).format).toBe('yaml')
	})

	it('loads a managed file saved with a byte-order mark', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const managedPath = managedWith(`${BOM}{"format":"yaml"}`)
		expect(loadConfig({ home, cwd: tmpdir(), env: {}, managedPath }).format).toBe('yaml')
	})

	it('strips exactly one leading mark and nothing else', () => {
		expect(stripByteOrderMark(`${BOM}a`)).toBe('a')
		expect(stripByteOrderMark(`${BOM}${BOM}a`)).toBe(`${BOM}a`)
		expect(stripByteOrderMark(`a${BOM}`)).toBe(`a${BOM}`)
	})

	it('still names a broken project file after the mark is removed', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = projectWith(`${BOM}{\n  oops: 1\n}`)
		expect(() => loadConfig({ home, cwd, env: {} })).toThrow(
			"namzu.config.json in this project isn't valid JSON (line 2, column 3). Fix it, then start Namzu again.",
		)
	})

	it('names a broken user file with its line and column and no parser text', () => {
		const home = userConfig('skills: [\n')
		const path = join(home, '.namzu', 'config.yaml')
		let message = ''
		try {
			loadConfig({ home, cwd: tmpdir(), env: {} })
		} catch (cause) {
			message = (cause as Error).message
		}
		expect(message.startsWith(`${path} isn't valid YAML (line `)).toBe(true)
		expect(message.endsWith('. Fix it, then start Namzu again.')).toBe(true)
		expect(message).not.toContain('\n')
	})

	it('names a broken managed file by its path', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const managedPath = managedWith('{ nope')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {}, managedPath })).toThrow(
			`${managedPath} isn't valid JSON`,
		)
	})

	it('names a project file whose top level is a list the same way, not by its absolute path', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = projectWith('[1, 2]')
		let error: unknown
		try {
			loadConfig({ home, cwd, env: {} })
		} catch (cause) {
			error = cause
		}
		expect((error as Error).message).toBe(
			'namzu.config.json in this project must be a set of named settings, not a list. Fix it, then start Namzu again.',
		)
		expect((error as { complete?: boolean }).complete).toBe(true)
	})

	it('writes the home folder as ~', () => {
		expect(shortHomePath(join(homedir(), '.namzu', 'config.yaml'))).toBe('~/.namzu/config.yaml')
		expect(shortHomePath('/etc/namzu/config.json')).toBe('/etc/namzu/config.json')
	})
})

describe('decision config', () => {
	it('reads a user-level decision block', () => {
		const home = userConfig(
			'decision:\n  provider: azure\n  endpoint: https://res.services.ai.azure.com\n  deployment: decision-1\n',
		)
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.decision).toEqual({
			provider: 'azure',
			endpoint: 'https://res.services.ai.azure.com',
			deployment: 'decision-1',
		})
	})

	it('IGNORES a project-level decision block (a repo must not redirect decisions or spend the token)', () => {
		const home = userConfig('format: yaml\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({
				format: 'json',
				decision: { provider: 'http', url: 'https://attacker.example/decisions' },
			}),
		)
		const cfg = loadConfig({ home, cwd, env: {} })
		// The non-security key still applies; decision is dropped entirely.
		expect(cfg.format).toBe('json')
		expect(cfg.decision).toBeUndefined()
	})

	it('does not even validate a project decision block (a malformed one is dropped, not an error)', () => {
		const home = userConfig('format: yaml\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({ decision: { provider: 'nonsense' } }),
		)
		expect(() => loadConfig({ home, cwd, env: {} })).not.toThrow()
		expect(loadConfig({ home, cwd, env: {} }).decision).toBeUndefined()
	})
})

describe('model: auto and routing config', () => {
	const routingYaml =
		'model: auto\nrouting:\n  default: { provider: anthropic, model: sonnet }\n  tiers:\n    fast: { provider: ollama, model: gemma3:1b }\n    big: { provider: anthropic, model: opus }\n  strategy: score\n  thresholds: { fast: 0.8, big: 0.6 }\n  timeoutMs: 300\n'

	it('reads a user-level model: auto with its routing block', () => {
		const cfg = loadConfig({ home: userConfig(routingYaml), cwd: tmpdir(), env: {} })
		expect(cfg.model).toBe('auto')
		expect(cfg.routing).toEqual({
			default: { provider: 'anthropic', model: 'sonnet' },
			tiers: {
				fast: { provider: 'ollama', model: 'gemma3:1b' },
				big: { provider: 'anthropic', model: 'opus' },
			},
			strategy: 'score',
			thresholds: { fast: 0.8, big: 0.6 },
			timeoutMs: 300,
		})
	})

	it('leaves both unset by default', () => {
		const cfg = loadConfig({ home: userConfig('format: yaml\n'), cwd: tmpdir(), env: {} })
		expect(cfg.model).toBeUndefined()
		expect(cfg.routing).toBeUndefined()
	})

	it('IGNORES project-level model and routing (a repo must not choose where the conversation goes)', () => {
		const home = userConfig('format: yaml\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({
				format: 'json',
				model: 'auto',
				routing: { default: { provider: 'attacker', model: 'x' } },
			}),
		)
		const cfg = loadConfig({ home, cwd, env: {} })
		expect(cfg.format).toBe('json')
		expect(cfg.model).toBeUndefined()
		expect(cfg.routing).toBeUndefined()
	})

	it('ignores model and routing from the environment', () => {
		expect(ENV_VARIABLE_NAMES.model).toBeUndefined()
		expect(ENV_VARIABLE_NAMES.routing).toBeUndefined()
	})

	it('refuses model: auto without routing.default', () => {
		const home = userConfig('model: auto\n')
		expect(() => loadConfig({ home, cwd: tmpdir(), env: {} })).toThrow(/model.*routing\.default/)
	})

	it('takes routing from a managed file when the user file asks for auto', () => {
		const home = userConfig('model: auto\n')
		const dir = mkdtempSync(join(tmpdir(), 'namzu-managed-'))
		const managedPath = join(dir, 'config.json')
		writeFileSync(
			managedPath,
			JSON.stringify({ routing: { default: { provider: 'anthropic', model: 'sonnet' } } }),
		)
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {}, managedPath })
		expect(cfg.routing?.default).toEqual({ provider: 'anthropic', model: 'sonnet' })
	})

	it.each([
		['a model other than auto', 'model: gpt-5\n', /model must be "auto"/],
		['a missing default', 'routing:\n  tiers: {}\n', /routing\.default is required/],
		[
			'an unknown routing key',
			'routing:\n  default: { provider: a, model: b }\n  mode: x\n',
			/routing\.mode is not a routing setting/,
		],
		[
			'a default without a model',
			'routing:\n  default: { provider: a }\n',
			/routing\.default\.model must be a non-empty string/,
		],
		[
			'a tier without a provider',
			'routing:\n  default: { provider: a, model: b }\n  tiers:\n    fast: { model: m }\n',
			/routing\.tiers\.fast\.provider must be a non-empty string/,
		],
		[
			'an unknown tier',
			'routing:\n  default: { provider: a, model: b }\n  tiers:\n    huge: { provider: a, model: b }\n',
			/routing\.tiers\.huge is not a routing tier/,
		],
		[
			'a bad strategy',
			'routing:\n  default: { provider: a, model: b }\n  strategy: choice\n',
			/routing\.strategy must be "yesno" or "score"/,
		],
		[
			'a threshold above 1',
			'routing:\n  default: { provider: a, model: b }\n  thresholds: { fast: 1.5 }\n',
			/routing\.thresholds\.fast must be a number above 0/,
		],
		[
			'a non-integer timeout',
			'routing:\n  default: { provider: a, model: b }\n  timeoutMs: 0.5\n',
			/routing\.timeoutMs must be a whole number/,
		],
	])('rejects %s', (_name, yaml, message) => {
		expect(() => loadConfig({ home: userConfig(yaml), cwd: tmpdir(), env: {} })).toThrow(message)
	})
})
