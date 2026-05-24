import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig } from './load.js'

describe('loadConfig cascade', () => {
	it('returns defaults when nothing is configured', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		const cfg = loadConfig({ home, cwd, env: {} })
		expect(cfg.format).toBe('text')
		expect(cfg.quiet).toBe(false)
	})

	it('reads user config from ~/.namzu/config.yaml', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'format: yaml\nquiet: true\n')
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.format).toBe('yaml')
		expect(cfg.quiet).toBe(true)
	})

	it('project config overrides user config', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'format: yaml\n')
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ format: 'json' }))
		const cfg = loadConfig({ home, cwd, env: {} })
		expect(cfg.format).toBe('json')
	})

	it('env vars override file config', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'format: yaml\n')
		const cfg = loadConfig({
			home,
			cwd: tmpdir(),
			env: { NAMZU_FORMAT: 'text' },
		})
		expect(cfg.format).toBe('text')
	})

	it('ignores invalid format values silently', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'format: xml\n')
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.format).toBe('text')
	})

	it('ignores malformed yaml gracefully', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(join(home, '.namzu', 'config.yaml'), ': : : not yaml\n')
		const cfg = loadConfig({ home, cwd: tmpdir(), env: {} })
		expect(cfg.format).toBe('text')
	})
})
