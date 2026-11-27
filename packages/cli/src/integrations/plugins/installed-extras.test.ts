import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installFixture, writeFiles } from '../../__fixtures__/installed-plugin.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { recordLayerPath, setEnabledPlugin } from './enabled-records.js'
import { readPluginFileSources } from './files.js'
import { validatePluginFolder } from './validate.js'

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-installed-extras-'))
	home = join(root, 'home')
	cwd = join(root, 'app')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const files = (name: string) => ({
	'plugin.json': {
		name,
		version: '1.0.0',
		description: 'x',
		commands: ['commands'],
		agents: ['agents'],
	},
	'commands/go.md': 'Go.',
	'agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\nPrompt\n',
	'scripts/run.sh': '#!/bin/sh\n',
})

describe('the command and agent files of installed plugins', () => {
	it('reach the session for a plugin turned on, and not for one turned off or hidden by a name', async () => {
		installFixture(home, { id: 'on@m', files: files('on') })
		installFixture(home, { id: 'off@m', files: files('off') })
		installFixture(home, { id: 'taken@m', files: files('taken') })
		writeFiles(join(home, 'plugins', 'taken'), {
			'plugin.json': {
				name: 'taken',
				version: '1.0.0',
				description: 'hand placed',
				commands: ['commands'],
			},
			'commands/mine.md': 'Mine.',
		})
		for (const id of ['on@m', 'taken@m'])
			setEnabledPlugin(recordLayerPath('user', { home, cwd }), home, id, true)
		setEnabledPlugin(recordLayerPath('user', { home, cwd }), home, 'off@m', false)
		const sources = await readPluginFileSources({
			config: { enabled: true },
			cwd,
			projectTrusted: true,
		})
		const plugins = sources.commands.map((c) => c.plugin).sort()
		expect(plugins).toEqual(['on', 'taken'])
		expect(sources.commands.find((c) => c.plugin === 'taken')?.dir).toContain(
			join('plugins', 'taken'),
		)
		expect(sources.agents.map((a) => a.plugin)).toEqual(['on'])
	})

	it('read no folder record for an untrusted folder', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd, files: files('proj') })
		setEnabledPlugin(recordLayerPath('project', { home, cwd }), home, 'proj@m', true)
		const untrusted = await readPluginFileSources({
			config: { enabled: true },
			cwd,
			projectTrusted: false,
		})
		expect(untrusted.commands).toEqual([])
		const trusted = await readPluginFileSources({
			config: { enabled: true },
			cwd,
			projectTrusted: true,
		})
		expect(trusted.commands.map((c) => c.plugin)).toEqual(['proj'])
	})
})

describe('namzu plugin validate and the reserved folders', () => {
	it('warns about a hand-placed plugin in a folder Namzu keeps its own state in', async () => {
		const dir = join(home, 'plugins', 'cache')
		writeFiles(dir, {
			'plugin.json': { name: 'sneaky', version: '1.0.0', description: 'x', skills: [] },
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems.map((p) => p.code)).toContain('plugin-folder-reserved')
		const fine = join(home, 'plugins', 'fine')
		writeFiles(fine, {
			'plugin.json': { name: 'fine', version: '1.0.0', description: 'x', skills: [] },
		})
		expect((await validatePluginFolder(fine)).problems.map((p) => p.code)).not.toContain(
			'plugin-folder-reserved',
		)
	})
})
