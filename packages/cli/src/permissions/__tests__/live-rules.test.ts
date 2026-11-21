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

/** The folder counts as trusted: only a trusted folder's local rules are edited and read. */
const TRUSTED = { trusted: true } as const
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
	return { cwd, layers: permissionLayersOf(config), trusted: () => true }
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
	expect(removeLocalRule(setupResult.cwd, 'Write', TRUSTED).ok).toBe(true)
	expect(removeLocalRule(setupResult.cwd, 'Read', TRUSTED).ok).toBe(true)
	live.reload()
	expect(decide('write').matchedRule).toBeNull()
	expect(decide('read').matchedRule).toBeNull()
	addLocalRule(setupResult.cwd, 'ask', 'Write', TRUSTED)
	live.reload()
	expect(decide('write').decision).toBe('review')
	addLocalRule(setupResult.cwd, 'allow', 'Write', TRUSTED)
	live.reload()
	expect(decide('write').decision).toBe('allow')
})
it('cannot reopen other layers, a local-file profile, or browser denies; invalid reload retains policy', () => {
	const { cwd, layers } = setup()
	const live = createLivePermissionRules({
		cwd,
		trusted: () => true,
		layers: [
			...layers,
			{ read: 'deny', grep: 'ask' },
			// A profile in the same local file is a separate immutable launch layer.
			bindPermissionTableToSource({ write: 'deny' }, join(cwd, 'namzu.config.local.json')),
		],
		browserRules: [{ type: 'deny_by_name', toolNames: ['browser'] }],
	})
	const decide = reader(live.rules)
	removeLocalRule(cwd, 'Write', TRUSTED)
	addLocalRule(cwd, 'allow', 'Read', TRUSTED)
	addLocalRule(cwd, 'allow', 'browser', TRUSTED)
	addLocalRule(cwd, 'allow', 'Grep', TRUSTED)
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
	const remembered = createSessionAllows(new Map(), {
		cwd: '/saved',
		persist: (cwd) => ({ path: cwd }),
		keepIgnored: async () => ({ state: 'not-a-repository' }),
	})
	const decide = reader([remembered.rule])
	remembered.add([{ kind: 'tool', tool: 'write' }])
	expect(decide('write').decision).toBe('allow')
	remembered.clear()
	expect(remembered.list()).toEqual([])
	expect(decide('write').matchedRule).toBeNull()
})

it('keeps an answer held for this conversation only, which no file carries, until it is removed', () => {
	const remembered = createSessionAllows(new Map(), {
		cwd: '/saved',
		// Saved for one tool, refused for the other: that one is held in memory only.
		persist: (cwd, table) =>
			'edit' in table ? { path: cwd, error: 'the disk is full' } : { path: cwd },
		keepIgnored: async () => ({ state: 'not-a-repository' }),
	})
	const decide = reader([remembered.rule])
	remembered.add([{ kind: 'tool', tool: 'write' }])
	expect(remembered.add([{ kind: 'tool', tool: 'edit' }])).toMatch(/the disk is full/)
	remembered.clear()
	expect(remembered.list()).toEqual([{ kind: 'tool', tool: 'edit' }])
	expect(decide('edit').decision).toBe('allow')
	expect(decide('write').matchedRule).toBeNull()

	expect(remembered.forget((table) => 'edit' in table)).toBe(1)
	expect(remembered.list()).toEqual([])
	expect(decide('edit').matchedRule).toBeNull()
})

it('reads no local rule of a folder that is not trusted when it reloads', () => {
	const { cwd, layers } = setup()
	let trusted = true
	const live = createLivePermissionRules({ cwd, layers, trusted: () => trusted })
	const decide = reader(live.rules)
	expect(decide('write').decision).toBe('deny')
	trusted = false
	live.reload()
	expect(decide('write').matchedRule).toBeNull()
	expect(decide('read').matchedRule).toBeNull()
	trusted = true
	live.reload()
	expect(decide('write').decision).toBe('deny')
})
