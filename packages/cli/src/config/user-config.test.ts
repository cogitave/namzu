import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { loadConfig } from './load.js'
import { setUserConfigValue } from './user-config.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})
function namzuHome(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-user-config-'))
	dirs.push(dir)
	return dir
}

describe('setUserConfigValue', () => {
	it('creates the file, and the loader reads the key back', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = setUserConfigValue(['skills', 'suggest'], false, { env })
		expect(file).toBe(join(home, 'config.yaml'))
		expect(statSync(file).mode & 0o777).toBe(0o600)
		expect(loadConfig({ cwd: tmpdir(), env }).skills).toEqual({ suggest: false })
	})

	it('keeps comments, order and the other keys', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		writeFileSync(
			file,
			'# my settings\nformat: yaml\nskills:\n  builtin: false # no built-ins\n  suggest: true\n',
		)
		setUserConfigValue(['skills', 'suggest'], false, { env })
		expect(readFileSync(file, 'utf8')).toBe(
			'# my settings\nformat: yaml\nskills:\n  builtin: false # no built-ins\n  suggest: false\n',
		)
		expect(loadConfig({ cwd: tmpdir(), env }).skills).toEqual({ builtin: false, suggest: false })
	})

	it.each([
		['broken YAML', 'skills: [\n', /not valid YAML/],
		['a list at the top', '- a\n- b\n', /not a mapping/],
		['skills as a scalar', 'skills: true\n', /skills is not a mapping/],
	])('refuses %s and leaves the file alone', (_name, text, error) => {
		const home = namzuHome()
		const file = join(home, 'config.yaml')
		writeFileSync(file, text)
		expect(() =>
			setUserConfigValue(['skills', 'suggest'], false, { env: { NAMZU_HOME: home } }),
		).toThrow(error)
		expect(readFileSync(file, 'utf8')).toBe(text)
	})
})
