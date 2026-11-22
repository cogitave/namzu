import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { addUserMcpServer, removeUserMcpServer } from '../integrations/mcp/user-config.js'
import { loadConfig } from './load.js'
import { deleteUserConfigValue, setUserConfigValue, withUserConfigLock } from './user-config.js'

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

describe('deleteUserConfigValue', () => {
	it('removes a block the removal left empty, and only that block', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		writeFileSync(file, 'format: yaml\ntui:\n  recap: false\nskills:\n  suggest: false\n')
		expect(deleteUserConfigValue(['tui', 'recap'], { env })).toBe(true)
		expect(readFileSync(file, 'utf8')).toBe('format: yaml\nskills:\n  suggest: false\n')
	})

	it('keeps a block that still holds other keys', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		writeFileSync(file, 'tui:\n  recap: false\n  theme: light\n')
		deleteUserConfigValue(['tui', 'recap'], { env })
		expect(readFileSync(file, 'utf8')).toBe('tui:\n  theme: light\n')
	})
})

describe('user config writes shared with other Namzu processes', () => {
	it('keeps the settings as they were in backups/ before a change, private', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		writeFileSync(file, 'theme: dark\n')
		setUserConfigValue(['theme'], 'light', { env })
		const copies = readdirSync(join(home, 'backups'))
		expect(copies).toHaveLength(1)
		expect(copies[0]).toMatch(/^config\.yaml\.backup\.\d+$/)
		expect(readFileSync(join(home, 'backups', copies[0] as string), 'utf8')).toBe('theme: dark\n')
		if (process.platform !== 'win32')
			expect(statSync(join(home, 'backups', copies[0] as string)).mode & 0o777).toBe(0o600)
		expect(existsSync(`${file}.lock`)).toBe(false)
	})

	it('takes over a lock left by a process that has exited', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		writeFileSync(`${file}.lock`, `${2 ** 22 + 777}:0:gone`)
		setUserConfigValue(['theme'], 'light', { env })
		expect(readFileSync(file, 'utf8')).toBe('theme: light\n')
		expect(existsSync(`${file}.lock`)).toBe(false)
	})

	it('holds one lock across a check and the writes after it', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		const seen = withUserConfigLock(
			() => {
				setUserConfigValue(['a'], 1, { env })
				deleteUserConfigValue(['a'], { env })
				setUserConfigValue(['b'], 2, { env })
				return existsSync(`${file}.lock`)
			},
			{ env },
		)
		expect(seen).toBe(true)
		expect(parse(readFileSync(file, 'utf8'))).toEqual({ b: 2 })
		expect(existsSync(`${file}.lock`)).toBe(false)
	})

	it('names the newest recovery copy when it refuses a file that does not parse', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		writeFileSync(file, 'theme: dark\n')
		setUserConfigValue(['theme'], 'light', { env })
		writeFileSync(file, 'theme: [unclosed\n')
		let message = ''
		try {
			setUserConfigValue(['theme'], 'dark', { env })
		} catch (error) {
			message = (error as Error).message
		}
		expect(message).toContain(`${file} is not valid YAML`)
		expect(message).toContain('fix it first. The newest recovery copy is ')
		expect(message).toContain('that change and any later one are not in it')
		expect(readFileSync(file, 'utf8')).toBe('theme: [unclosed\n')
	})

	it('cuts a removed tool server, and its headers, out of every recovery copy', () => {
		const home = namzuHome()
		const env = { NAMZU_HOME: home }
		const file = join(home, 'config.yaml')
		writeFileSync(file, 'theme: dark\n')
		addUserMcpServer(
			'tickets',
			{ url: 'https://tickets.example/mcp', headers: { Authorization: 'Bearer tok-drop-me' } },
			{ env },
		)
		addUserMcpServer('docs', { url: 'https://docs.example/mcp' }, { env })
		// One copy a minute: make one that holds the token, as an older change would have.
		const backups = join(home, 'backups')
		writeFileSync(join(backups, 'config.yaml.backup.1'), readFileSync(file, 'utf8'))
		writeFileSync(join(backups, 'config.yaml.backup.2'), 'theme: [unclosed\n')
		expect(removeUserMcpServer('tickets', { env })).toBe(true)
		const texts = readdirSync(backups).map((name) => readFileSync(join(backups, name), 'utf8'))
		expect(texts.filter((text) => text.includes('tok-drop-me'))).toEqual([])
		expect(texts.some((text) => text.includes('docs.example'))).toBe(true)
		// A copy that does not parse is left as it is: it is what that copy is for.
		expect(texts).toContain('theme: [unclosed\n')
	})
})
