import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig, takeConfigWarnings } from './load.js'

interface Files {
	readonly user?: string
	readonly project?: object
	readonly managed?: object
}

function folder(files: Files) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcpskills-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (files.user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), files.user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-mcpskills-cwd-'))
	if (files.project) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(files.project))
	const managedPath = join(cwd, 'managed.json')
	if (files.managed) writeFileSync(managedPath, JSON.stringify(files.managed))
	return { home, cwd, env: {}, managedPath }
}

const SERVERS = 'mcpServers:\n  docs:\n    command: node\n    skills: true\n'

describe('the switches for tool server skills', () => {
	it('reads skills on a server as written, and is off when it says nothing', () => {
		const on = loadConfig(folder({ user: SERVERS }))
		expect(on.mcpServers?.docs?.skills).toBe(true)
		const off = loadConfig(folder({ user: 'mcpServers:\n  docs:\n    command: node\n' }))
		expect(off.mcpServers?.docs?.skills).toBeUndefined()
		expect(off.disableMcpSkills).toBeUndefined()
	})

	it('disableMcpSkills in the user file turns the feature off', () => {
		expect(
			loadConfig(folder({ user: `disableMcpSkills: true\n${SERVERS}` })).disableMcpSkills,
		).toBe(true)
	})

	it('disableMcpSkills in the managed file turns it off whatever the user file says', () => {
		const config = loadConfig(
			folder({ user: `disableMcpSkills: false\n${SERVERS}`, managed: { disableMcpSkills: true } }),
		)
		expect(config.disableMcpSkills).toBe(true)
	})

	it('cannot be turned back off by a later layer', () => {
		const config = loadConfig(
			folder({
				user: `disableMcpSkills: true\n${SERVERS}`,
				project: { disableMcpSkills: false },
			}),
		)
		expect(config.disableMcpSkills).toBe(true)
	})

	it('is ignored in a project file, with a note', () => {
		takeConfigWarnings()
		const config = loadConfig(folder({ user: SERVERS, project: { disableMcpSkills: true } }))
		expect(config.disableMcpSkills).not.toBe(true)
		expect(takeConfigWarnings().join('\n')).toMatch(/disableMcpSkills in .*is ignored/)
	})

	it('refuses a value that is not true or false', () => {
		expect(() => loadConfig(folder({ user: 'disableMcpSkills: maybe\n' }))).toThrow(
			/disableMcpSkills/,
		)
	})
})
