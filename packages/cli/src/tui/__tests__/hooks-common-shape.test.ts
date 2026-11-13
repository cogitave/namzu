import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { loadConfig, resetHookConfigProblems, takeConfigWarnings } from '../../config/load.js'
import { describeHooksStatus } from '../../doctor/checks/hooks.js'
import { readFolderGrants } from '../../integrations/trust/folder-grants.js'
import { renderHooks } from '../slashCommands.js'

const hooks = {
	PreToolUse: [
		{ matcher: 'Bash', hooks: [{ command: 'guard.sh' }, { type: 'agent', prompt: 'p' }] },
	],
	TeammateIdle: [{ hooks: [{ command: 'idle.sh' }] }],
	pre_compact: [{ command: 'own.sh', toolNames: 'written' }],
}

function folder() {
	const home = mkdtempSync(join(tmpdir(), 'namzu-common-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-common-cwd-'))
	writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ hooks }))
	return { home, cwd, env: {} }
}

beforeEach(() => {
	resetHookConfigProblems()
	takeConfigWarnings()
})

describe('/hooks and the doctor row for a hooks block in the common shape', () => {
	it('/hooks shows the names each tool-event entry receives and what was not loaded', () => {
		const config = loadConfig(folder())
		const text = renderHooks(config.hooks)
		expect(text).toContain('guard.sh · matches Bash · tool names as written (Bash)')
		expect(text).toContain('Not loaded: ')
		expect(text).toContain('TeammateIdle: is not an event this kernel has')
		expect(text).toContain('a kind this kernel does not have')
		// Not a tool event: no names line.
		expect(text).not.toMatch(/own\.sh.*tool names/)
	})

	it('/hooks says what was not loaded even when nothing else loaded', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-common-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-common-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({ hooks: { TeammateIdle: [{ hooks: [{ command: 'x' }] }] } }),
		)
		loadConfig({ home, cwd, env: {} })
		expect(renderHooks(undefined)).toContain('Not loaded: ')
	})

	it('the doctor row warns for a hook that guarded something, naming the file and the event', () => {
		const config = loadConfig(folder())
		const row = describeHooksStatus(config)
		expect(row.status).toBe('warn')
		expect(row.message).toContain('TeammateIdle')
		expect(row.message).toContain('PreToolUse')
		expect(row.message).toContain('namzu.config.json')
	})

	it('the doctor row does not name a folder file that is not trusted', () => {
		const dir = folder()
		const config = loadConfig(dir)
		const row = describeHooksStatus(config, { cwd: dir.cwd, trusted: false })
		expect(row.message).not.toContain('TeammateIdle')
	})

	it('the launch says it once as a warning', () => {
		loadConfig(folder())
		const said = takeConfigWarnings().join('\n')
		expect(said).toContain('Hook problem in')
		expect(said).toContain('TeammateIdle')
	})
})

describe('the trust prompt names a hook written in the common shape', () => {
	it('lists the command inside a group, under the event as written', () => {
		const dir = folder()
		const found = readFolderGrants(dir.cwd).hooks
		expect(found).toEqual(
			expect.arrayContaining([
				{ event: 'PreToolUse', runs: 'guard.sh' },
				{ event: 'TeammateIdle', runs: 'idle.sh' },
				{ event: 'pre_compact', runs: 'own.sh' },
			]),
		)
	})

	it('names an http and a prompt hook inside a group too', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-common-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: 'http', url: 'https://h.example/x?token=1' },
								{ type: 'prompt', prompt: 'ok?' },
							],
						},
					],
				},
			}),
		)
		expect(readFolderGrants(cwd).hooks).toEqual([
			{ event: 'Stop', runs: 'POST https://h.example/x' },
			{ event: 'Stop', runs: 'asks the model: ok?' },
		])
	})
})
