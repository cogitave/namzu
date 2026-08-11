import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigLoadError, loadConfig } from './load.js'

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
