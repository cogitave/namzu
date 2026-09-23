/**
 * A scheduled job's browser grant: what `expandPermissions` accepts, what
 * `compileJobPolicy` makes of it through the kernel's own gate and the real
 * browser tools, and how the confirmation words it.
 */

import {
	AuthorizationGate,
	type AuthorizationRule,
	type BrowserHost,
	NOOP_LOGGER,
	ToolRegistry,
	createBrowserTools,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { PermissionLayer } from '../../config/load.js'
import { allowsNetwork, compileJobPolicy, expandPermissions, withheldTools } from '../policy.js'
import type { SchedulePermissionSet } from '../types.js'

const host: BrowserHost = {
	id: 'fake',
	capabilities: {
		engine: 'fake',
		headless: true,
		screenshot: true,
		upload: false,
	},
	async observe() {
		throw new Error('not called')
	},
	async act() {
		throw new Error('not called')
	},
}
const registry = new ToolRegistry()
for (const tool of createBrowserTools(host)) registry.register(tool as never)

function decide(rules: readonly AuthorizationRule[], name: string, raw: Record<string, unknown>) {
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules: [...rules],
			allowReadOnlyTools: true,
			denyDangerousPatterns: true,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
	const prepared = registry.get(name) ? registry.prepareExecution(name, raw) : undefined
	if (!prepared?.success) {
		return gate.evaluate({
			toolName: name,
			toolInput: raw,
			toolDef: registry.get(name),
		}).decision
	}
	return gate.evaluate({
		toolName: name,
		toolInput: prepared.prepared.input,
		toolDef: registry.get(name),
	}).decision
}

const HOME = '/home/someone/.namzu-test'

function policy(set: SchedulePermissionSet, layers: readonly PermissionLayer[] = []) {
	return compileJobPolicy(set, { layers, namzuHome: HOME })
}

const granted = expandPermissions({
	preset: 'read-only',
	unmatched: 'park',
	browser: {
		profile: 'social',
		sites: { 'HTTP://LOCALHOST:8123': 'act', 'https://news.example': 'read' },
	},
})

describe('a browser grant', () => {
	it('is stored with canonical site keys and counts as network access', () => {
		expect(granted.browser).toEqual({
			profile: 'social',
			sites: { 'http://localhost:8123': 'act', 'https://news.example': 'read' },
		})
		expect(allowsNetwork(granted)).toBe(true)
		expect(policy(granted).network).toBe(true)
	})

	it('stands on its own, without a preset or rules', () => {
		const set = expandPermissions({
			unmatched: 'deny',
			browser: { profile: 'social', sites: { 'https://news.example': 'read' } },
		})
		expect(set.browser?.profile).toBe('social')
		expect(set.rules).toEqual({})
	})

	it('refuses "*", an empty list, a bad level, a bad profile and a site listed twice', () => {
		const grant = (sites: Record<string, string>, profile = 'social') =>
			expandPermissions({
				preset: 'read-only',
				unmatched: 'park',
				browser: { profile, sites },
			})
		expect(() => grant({ '*': 'read' })).toThrow(/every site/)
		expect(() => grant({})).toThrow(/at least one site/)
		expect(() => grant({ 'https://a.example': 'deny' })).toThrow(/not read, ask or act/)
		expect(() => grant({ 'https://a.example': 'read' }, 'Work Profile')).toThrow(/profile name/)
		expect(() => grant({ 'https://A.example': 'read', 'https://a.example': 'act' })).toThrow(
			/listed twice/,
		)
		expect(() => grant({ 'ftp://a.example': 'read' })).toThrow(/ftp/)
	})

	it('refuses ask unless unmatched is park', () => {
		const withAsk = (unmatched: 'park' | 'deny' | 'allow') =>
			expandPermissions({
				preset: 'read-only',
				unmatched,
				execution: 'sandbox',
				browser: { profile: 'social', sites: { 'https://a.example': 'ask' } },
			})
		expect(withAsk('park').browser?.sites['https://a.example']).toBe('ask')
		expect(() => withAsk('deny')).toThrow(/refused every time/)
		expect(() => withAsk('allow')).toThrow(/approved without asking/)
	})

	it('refuses rules that name the browser tools: the grant is the only way in', () => {
		expect(() => expandPermissions({ rules: { browser: 'allow' }, unmatched: 'park' })).toThrow(
			/browser grant/,
		)
		expect(() =>
			expandPermissions({
				rules: { browser_act: { '*': 'allow' } },
				unmatched: 'park',
			}),
		).toThrow(/browser grant/)
	})
})

describe('the compiled grant, through the gate', () => {
	const { rules } = policy(granted)
	const navigate = (url: string) => decide(rules, 'browser', { action: 'navigate', url })
	const click = (origin: string) =>
		decide(rules, 'browser_act', { action: 'click', ref: 'e1', origin })

	it('opens the listed sites and nothing else', () => {
		expect(navigate('http://localhost:8123/feed')).toBe('allow')
		expect(navigate('https://news.example/today')).toBe('allow')
		expect(navigate('https://evil.example/')).toBe('deny')
		expect(navigate('http://localhost:8124/')).toBe('deny')
		expect(navigate('https://news.example.evil.example/')).toBe('deny')
	})

	it('acts only where the level is act', () => {
		expect(click('http://localhost:8123')).toBe('allow')
		expect(click('https://news.example')).toBe('deny')
		expect(click('https://evil.example')).toBe('deny')
	})

	it('lets the run look at the page and move through its history', () => {
		expect(decide(rules, 'browser', { action: 'snapshot' })).toBe('allow')
		expect(decide(rules, 'browser', { action: 'back' })).toBe('allow')
		expect(decide(rules, 'browser', { action: 'reload' })).toBe('allow')
	})

	it('sends an ask site to review, which a held run parks', () => {
		const set = expandPermissions({
			unmatched: 'park',
			browser: { profile: 'social', sites: { 'https://a.example': 'ask' } },
		})
		const compiled = policy(set)
		expect(
			decide(compiled.rules, 'browser', {
				action: 'navigate',
				url: 'https://a.example/',
			}),
		).toBe('review')
		expect(
			decide(compiled.rules, 'browser_act', {
				action: 'click',
				ref: 'e1',
				origin: 'https://a.example',
			}),
		).toBe('review')
		expect(compiled.mode).toBe('prompt')
	})

	it('denies the browser tools outright when there is no grant', () => {
		const plain = policy(expandPermissions({ preset: 'edit-in-folder' }))
		expect(
			decide(plain.rules, 'browser', {
				action: 'navigate',
				url: 'https://a.example/',
			}),
		).toBe('deny')
		expect(decide(plain.rules, 'browser', { action: 'snapshot' })).toBe('deny')
		expect(
			decide(plain.rules, 'browser_act', {
				action: 'click',
				ref: 'e1',
				origin: 'https://a.example',
			}),
		).toBe('deny')
	})

	it('cannot reopen a site a config file denies', () => {
		const layers: PermissionLayer[] = [
			{
				source: 'user-file',
				path: '/home/someone/.namzu-test/config.yaml',
				permissions: {},
				browserDenies: ['https://news.example'],
			},
		]
		const compiled = policy(granted, layers)
		expect(
			decide(compiled.rules, 'browser', {
				action: 'navigate',
				url: 'https://news.example/',
			}),
		).toBe('deny')
		expect(compiled.lines).toContain(
			'browser https://news.example: deny (from /home/someone/.namzu-test/config.yaml)',
		)
	})

	it('says what the run may do on each site, and that a sign-in stops it', () => {
		const { lines } = policy(granted)
		expect(lines).toEqual(
			expect.arrayContaining([
				'browser: profile social, no window',
				'browser http://localhost:8123: open, read and change without asking',
				'browser https://news.example: open and read, never change',
				'browser any other site: deny',
				'browser sign-in, CAPTCHA or a code: the run stops and tells you',
			]),
		)
	})
})

describe("the floor over the Windows browser's profiles", () => {
	it('is part of every scheduled run’s rules', () => {
		const { rules } = policy(expandPermissions({ preset: 'edit-in-folder' }))
		expect(decide(rules, 'bash', { command: 'cat /mnt/c/Users/A/AppData/Local/namzu/x' })).toBe(
			'deny',
		)
		expect(decide(rules, 'read', { path: 'C:\\Users\\A\\AppData\\Local\\namzu' })).toBe('deny')
	})
})

describe('the tools a run is not sent', () => {
	it('are those denied by name before anything could allow them, and the strict-only ones', () => {
		expect(withheldTools(granted, policy(granted))).toEqual([
			'bash',
			'edit',
			'job',
			'wait_for_job',
			'web_fetch',
			'web_search',
			'write',
		])
		const strict = expandPermissions({
			preset: 'read-only',
			unmatched: 'deny',
			browser: { profile: 'social', sites: { 'http://localhost:8123': 'act' } },
		})
		expect(withheldTools(strict, policy(strict))).toEqual(
			expect.arrayContaining(['Agent', 'save_memory', 'send_message', 'bash']),
		)
		expect(withheldTools(strict, policy(strict))).not.toContain('browser')
	})

	it('keeps a tool a rule lets through, and the browser without a grant is withheld', () => {
		const shell = expandPermissions({ preset: 'edit-in-folder' })
		const kept = withheldTools(shell, policy(shell))
		expect(kept).not.toContain('bash')
		expect(kept).not.toContain('job')
		expect(kept).toEqual(expect.arrayContaining(['browser', 'browser_act', 'web_fetch']))
		const memory = expandPermissions({
			preset: 'read-only',
			unmatched: 'deny',
			rules: { save_memory: 'allow' },
		})
		expect(withheldTools(memory, policy(memory))).not.toContain('save_memory')
	})
})
