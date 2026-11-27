import { describe, expect, it } from 'vitest'

import { marketplaceNameProblem, parseMarketplaceAddress } from './marketplace.js'
import { isExecutablePath, splitAllowedTools, surfaceChanges } from './surface.js'

describe('marketplace names', () => {
	it('accepts lowercase names and gives a sentence for the rest', () => {
		expect(marketplaceNameProblem('team-tools')).toBeUndefined()
		expect(marketplaceNameProblem('a.b_c-1')).toBeUndefined()
		for (const bad of ['', 'Team', '-x', 'a..b', 'a b', 'a/b', 'x'.repeat(65), 'a\u202eb']) {
			expect(marketplaceNameProblem(bad), JSON.stringify(bad)).toContain(
				'is not a marketplace name',
			)
		}
		expect(marketplaceNameProblem('namzu')).toContain('reserved')
		expect(marketplaceNameProblem('namzu-extras')).toContain('reserved')
		expect(marketplaceNameProblem('local-uploads')).toContain('reserved')
		expect(marketplaceNameProblem('anthropic-plugins')).toContain('official')
	})
})

describe('marketplace addresses', () => {
	const cwd = '/work/app'
	it('reads path forms in order, without touching the disk', () => {
		expect(parseMarketplaceAddress('./m', cwd)).toEqual({ kind: 'path', path: '/work/app/m' })
		expect(parseMarketplaceAddress('../m/cat.json', cwd)).toEqual({
			kind: 'path',
			path: '/work/m/cat.json',
		})
		expect(parseMarketplaceAddress('/abs/m', cwd)).toEqual({ kind: 'path', path: '/abs/m' })
		expect(parseMarketplaceAddress('C:\\m', cwd).kind).toBe('path')
	})
	it('names the forms that need a download', () => {
		expect(parseMarketplaceAddress('acme/tools#main', cwd)).toMatchObject({
			kind: 'remote',
			form: 'github',
		})
		expect(parseMarketplaceAddress('git@host:acme/tools.git', cwd)).toMatchObject({
			kind: 'remote',
			form: 'git',
		})
		expect(parseMarketplaceAddress('https://example.com/m.json', cwd)).toMatchObject({
			kind: 'remote',
			form: 'https',
		})
	})
	it('refuses what is never accepted', () => {
		for (const bad of [
			'http://x/m.json',
			'file:///m',
			'\\\\server\\share',
			'//server/share',
			'https://u:p@x/m',
			'https://x/m#frag',
			'https://github.com/a/b/blob/main/m.json',
			'two words',
		]) {
			expect(parseMarketplaceAddress(bad, cwd).kind, bad).toBe('refused')
		}
	})
})

describe('what counts as runnable', () => {
	it('counts configuration, hooks, bin, exec bits and program extensions', () => {
		for (const path of [
			'plugin.json',
			'.mcp.json',
			'skills/a/SKILL.md',
			'agents/x.md',
			'hooks/any.txt',
			'bin/tool',
			'a.sh',
			'b.PY',
			'c.ps1',
			'd.cmd',
		])
			expect(isExecutablePath(path, 0o644), path).toBe(true)
		expect(isExecutablePath('notes/readme.txt', 0o755)).toBe(true)
		expect(isExecutablePath('notes/readme.txt', 0o644)).toBe(false)
		expect(isExecutablePath('assets/logo.png', 0o644)).toBe(false)
	})
	it('splits allowed-tools into one entry per tool, keeping a pattern whole', () => {
		expect(splitAllowedTools('Bash(git log:*) Read Bash(npm run test:*)')).toEqual([
			'Bash(git log:*)',
			'Read',
			'Bash(npm run test:*)',
		])
		expect(splitAllowedTools('')).toEqual([])
	})
	it('says what changed between two surfaces', () => {
		const empty = {
			hooks: [],
			fileHooks: [],
			mcpLocal: [],
			mcpRemote: [],
			modules: [],
			allowedTools: [],
			scripts: [],
			unpinnedDownload: false,
		}
		const hook = { event: 'pre_tool_use', type: 'command' as const, run: 'x' }
		expect(surfaceChanges(empty, { ...empty, hooks: [hook] })).toEqual(['1 new hook'])
		expect(surfaceChanges({ ...empty, hooks: [hook] }, empty)).toEqual([
			'1 hook removed or changed',
		])
		expect(surfaceChanges(empty, empty)).toEqual([])
	})
})
