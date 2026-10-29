import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { loadConfigWithProvenance } from '../../config/load.js'
import { createLivePermissionRules } from '../live-rules.js'
import { addLocalRule, removeLocalRule } from '../rule-screen.js'
import { bindPermissionTableToSource, permissionLayersOf } from '../rules.js'
import { createSessionAllows } from '../session-allow.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})
function setup() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-live-rules-'))
	dirs.push(cwd)
	writeFileSync(
		join(cwd, 'namzu.config.local.json'),
		JSON.stringify({ permissions: { write: 'deny', read: 'allow' } }),
	)
	const { config } = loadConfigWithProvenance({
		cwd,
		home: cwd,
		env: {},
		managedPath: join(cwd, 'managed.json'),
	})
	return { cwd, layers: permissionLayersOf(config) }
}
function reader(rules: ReturnType<typeof createLivePermissionRules>['rules']) {
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules,
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
	return (toolName: string) =>
		gate.evaluate({ toolName, toolInput: { path: 'safe.txt' }, toolDef: undefined })
}
it('replaces existing local rules in a gate created before edits, and removes earlier allows', () => {
	const setupResult = setup()
	const live = createLivePermissionRules(setupResult)
	const decide = reader(live.rules)
	expect(decide('write').decision).toBe('deny')
	expect(decide('read').decision).toBe('allow')
	expect(removeLocalRule(setupResult.cwd, 'Write').ok).toBe(true)
	expect(removeLocalRule(setupResult.cwd, 'Read').ok).toBe(true)
	live.reload()
	expect(decide('write').matchedRule).toBeNull()
	expect(decide('read').matchedRule).toBeNull()
	addLocalRule(setupResult.cwd, 'ask', 'Write')
	live.reload()
	expect(decide('write').decision).toBe('review')
	addLocalRule(setupResult.cwd, 'allow', 'Write')
	live.reload()
	expect(decide('write').decision).toBe('allow')
})
it('cannot reopen other layers, a local-file profile, or browser denies; invalid reload retains policy', () => {
	const { cwd, layers } = setup()
	const live = createLivePermissionRules({
		cwd,
		layers: [
			...layers,
			{ read: 'deny', grep: 'ask' },
			// A profile in the same local file is a separate immutable launch layer.
			bindPermissionTableToSource({ write: 'deny' }, join(cwd, 'namzu.config.local.json')),
		],
		browserRules: [{ type: 'deny_by_name', toolNames: ['browser'] }],
	})
	const decide = reader(live.rules)
	removeLocalRule(cwd, 'Write')
	addLocalRule(cwd, 'allow', 'Read')
	addLocalRule(cwd, 'allow', 'browser')
	addLocalRule(cwd, 'allow', 'Grep')
	live.reload()
	expect(decide('write').decision).toBe('deny')
	expect(decide('read').decision).toBe('deny')
	expect(decide('browser').decision).toBe('deny')
	expect(decide('grep').decision).toBe('review')
	writeFileSync(join(cwd, 'namzu.config.local.json'), '{broken')
	expect(() => live.reload()).toThrow()
	expect(decide('read').decision).toBe('deny')
})

it('withdraws cached remembered answers when saved local rules take ownership', () => {
	const remembered = createSessionAllows(new Map())
	const decide = reader([remembered.rule])
	remembered.add([{ kind: 'tool', tool: 'write' }])
	expect(decide('write').decision).toBe('allow')
	remembered.clear()
	expect(remembered.list()).toEqual([])
	expect(decide('write').matchedRule).toBeNull()
})
