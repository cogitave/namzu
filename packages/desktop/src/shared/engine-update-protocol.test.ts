import { describe, expect, it } from 'vitest'
import {
	ENGINE_UPDATE_IDS,
	compareVersions,
	parseVersion,
	readEngineUpdateRequest,
	versionFromOutput,
} from './engine-update-protocol.js'

describe('reading a version from a program’s output', () => {
	it.each([
		['codex-cli 0.154.0', '0.154.0'],
		['2.1.290 (Claude Code)', '2.1.290'],
		['35.0.0\n', '35.0.0'],
		['namzu 36.1.0-beta.2 (build 7)', '36.1.0-beta.2'],
	])('%s', (output, version) => expect(versionFromOutput(output)).toBe(version))
	it('finds none in text without one', () => {
		expect(versionFromOutput('running scripts is disabled on this system')).toBeUndefined()
		expect(versionFromOutput('')).toBeUndefined()
	})
	it('accepts only a plain version', () => {
		expect(parseVersion('1.2.3')).toBe('1.2.3')
		expect(parseVersion('1.2')).toBeUndefined()
		expect(parseVersion('1.2.3; echo')).toBeUndefined()
	})
})

describe('comparing versions', () => {
	it('orders numbers, not text', () => {
		expect(compareVersions('0.154.0', '0.162.0')).toBeLessThan(0)
		expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
		expect(compareVersions('2.1.295', '2.1.295')).toBe(0)
		expect(compareVersions('3.0.0', '2.9.9')).toBeGreaterThan(0)
	})
	it('puts a prerelease before its release', () => {
		expect(compareVersions('1.0.0-alpha.1', '1.0.0')).toBeLessThan(0)
		expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
	})
})

describe('the request a window sends', () => {
	it('carries a program, a pane and optionally a project', () => {
		expect(readEngineUpdateRequest({ engine: 'codex-cli', groupId: 'g', projectId: 'p' })).toEqual({
			engine: 'codex-cli',
			groupId: 'g',
			projectId: 'p',
		})
		expect(readEngineUpdateRequest({ engine: 'claude-code', groupId: 'g' })).toEqual({
			engine: 'claude-code',
			groupId: 'g',
		})
	})
	it.each([
		null,
		[],
		{ engine: 'bash', groupId: 'g' },
		{ engine: 'codex-cli' },
		{ engine: 'codex-cli', groupId: '' },
		{ engine: 'codex-cli', groupId: 'g', command: 'rm -rf /' },
		{ engine: 'codex-cli', groupId: 'g', projectId: 4 },
	])('refuses %j', (value) => expect(() => readEngineUpdateRequest(value)).toThrow())
	it('names exactly the three programs', () => {
		expect([...ENGINE_UPDATE_IDS].sort()).toEqual(['claude-code', 'codex-cli', 'namzu-cli'])
	})
})
