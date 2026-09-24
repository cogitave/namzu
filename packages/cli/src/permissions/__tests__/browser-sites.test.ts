import {
	AuthorizationGate,
	type AuthorizationRule,
	type BrowserHost,
	NOOP_LOGGER,
	ToolManager,
	createBrowserTools,
	toolset,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	browserCallOrigin,
	browserSiteRuleFor,
	compileBrowserSites,
	normalizeBrowserSites,
	withBrowserSiteRules,
} from '../browser-sites.js'
import { compilePermissions } from '../rules.js'

/**
 * The site compiler against the kernel's own gate, with the real browser
 * tools: the input the gate sees is the registry's prepared (canonical)
 * value, exactly as in a turn.
 */

const host: BrowserHost = {
	id: 'fake',
	capabilities: { engine: 'fake', headless: true, screenshot: true, upload: false },
	async observe() {
		throw new Error('not called')
	},
	async act() {
		throw new Error('not called')
	},
}

const registry = new ToolManager({
	toolsets: [toolset('test', createBrowserTools(host))],
	messages: () => [],
})

function gateOf(rules: readonly AuthorizationRule[]) {
	// The TUI's gate: the dangerous-pattern floor and the read-only default on.
	return new AuthorizationGate(
		{
			enabled: true,
			rules: [...rules],
			allowReadOnlyTools: true,
			denyDangerousPatterns: true,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
}

function decide(rules: readonly AuthorizationRule[], name: string, raw: Record<string, unknown>) {
	const prepared = registry.prepareExecution(name, raw)
	if (!prepared.success) return 'refused-by-schema'
	return gateOf(rules).evaluate({
		toolName: name,
		toolInput: prepared.prepared.input,
		toolDef: registry.get(name),
	}).decision
}

const SITES = {
	'https://example.com': 'act',
	'https://www.iana.org': 'read',
	'https://*.corp.example': 'ask',
	'https://secret.corp.example': 'deny',
	'http://localhost:*': 'act',
	'*': 'ask',
} as const

const { rules } = compileBrowserSites(SITES)
const navigate = (url: string) => decide(rules, 'browser', { action: 'navigate', url })
const click = (origin: string) =>
	decide(rules, 'browser_act', { action: 'click', ref: 'e1', origin })

describe('browser.sites through the real gate', () => {
	it('opens an act site and a read site without asking, and asks for anything else', () => {
		expect(navigate('https://example.com/')).toBe('allow')
		expect(navigate('https://example.com/a?b=c&d=e;f|g')).toBe('allow')
		expect(navigate('https://www.iana.org/domains/example')).toBe('allow')
		expect(navigate('https://iana.org/domains/example')).toBe('review')
		expect(navigate('https://unlisted.example/')).toBe('review')
	})

	it('acts on an act site, asks on an ask site, and never acts on a read site', () => {
		expect(click('https://example.com')).toBe('allow')
		expect(click('https://www.iana.org')).toBe('deny')
		expect(click('https://a.corp.example')).toBe('review')
		expect(click('https://unlisted.example')).toBe('review')
	})

	it('reads every spelling of a site as that site', () => {
		expect(navigate('HTTPS://Example.COM.:443/x')).toBe('allow')
		expect(click('HTTPS://EXAMPLE.com:443/')).toBe('allow')
	})

	it('does not let a lookalike ride on an allowed site', () => {
		for (const url of [
			'https://example.com.evil.example/',
			'https://evil.example/?https://example.com',
			'https://evil.example/#https://example.com',
			'https://example.com:8443/',
			'http://example.com/',
			'https://xexample.com/',
			'https://exаmple.com/', // Cyrillic а: punycode, another site
		]) {
			expect(navigate(url), url).toBe('review')
		}
		expect(navigate('https://example.com@evil.example/')).toBe('refused-by-schema')
		expect(click('https://example.com.evil.example')).toBe('review')
	})

	it('puts a deny ahead of a less specific allow and a more general ask', () => {
		expect(navigate('https://secret.corp.example/')).toBe('deny')
		expect(click('https://secret.corp.example')).toBe('deny')
		// *. is one or more whole labels, never the bare suffix.
		expect(navigate('https://corp.example/')).toBe('review')
		expect(navigate('https://a.b.corp.example/')).toBe('review')
	})

	it('reads :* as any port and no port as the default one', () => {
		expect(navigate('http://localhost:5173/')).toBe('allow')
		expect(navigate('http://localhost/')).toBe('allow')
		expect(navigate('https://localhost/')).toBe('review')
	})

	it('lets the model look at the page it holds without asking', () => {
		for (const input of [
			{ action: 'snapshot' },
			{ action: 'screenshot', fullPage: true },
			{ action: 'scroll', direction: 'down' },
			{ action: 'wait_for', text: 'Done' },
			{ action: 'tabs', op: 'list' },
			{ action: 'tabs', op: 'select', tab: 't2' },
			{ action: 'tabs', op: 'close', tab: 't2' },
		]) {
			expect(decide(rules, 'browser', input), JSON.stringify(input)).toBe('allow')
		}
		expect(decide(rules, 'browser', { action: 'tabs', op: 'new', url: 'https://x.example/' })).toBe(
			'review',
		)
		expect(
			decide(rules, 'browser', { action: 'tabs', op: 'new', url: 'https://example.com/' }),
		).toBe('allow')
		// Moving through history loads a page no rule names: the table and the mode decide.
		expect(decide(rules, 'browser', { action: 'back' })).toBe('review')
		expect(navigate('about:blank')).toBe('allow')
	})

	it('reads "*" as the level for every unlisted site, ask when absent', () => {
		const deny = compileBrowserSites({ 'https://example.com': 'read', '*': 'deny' }).rules
		expect(decide(deny, 'browser', { action: 'navigate', url: 'https://other.example/' })).toBe(
			'deny',
		)
		expect(decide(deny, 'browser', { action: 'navigate', url: 'https://example.com/' })).toBe(
			'allow',
		)
		const none = compileBrowserSites(undefined).rules
		expect(decide(none, 'browser', { action: 'navigate', url: 'https://example.com/' })).toBe(
			'review',
		)
		expect(
			decide(none, 'browser_act', { action: 'click', ref: 'e1', origin: 'https://example.com' }),
		).toBe('review')
		expect(decide(none, 'browser', { action: 'snapshot' })).toBe('allow')
	})

	it('keeps a [permissions] deny for a browser tool ahead of the site rules', () => {
		const table = compilePermissions({ browser_act: 'deny', bash: 'allow' }).rules
		const merged = withBrowserSiteRules(table, rules)
		expect(
			decide(merged, 'browser_act', { action: 'click', ref: 'e1', origin: 'https://example.com' }),
		).toBe('deny')
		expect(decide(merged, 'browser', { action: 'navigate', url: 'https://example.com/' })).toBe(
			'allow',
		)
		// The rest of the table keeps its place after the site rules.
		expect(merged.at(-1)).toEqual({ type: 'allow_by_name', toolNames: ['bash'] })
		const patterned = compilePermissions({ browser: { '*evil*': 'deny' } }).rules
		expect(
			decide(withBrowserSiteRules(patterned, rules), 'browser', {
				action: 'navigate',
				url: 'https://example.com/evil',
			}),
		).toBe('deny')
	})
})

describe('site keys', () => {
	it('canonicalises keys, fills in "*" and keeps the narrower of two spellings', () => {
		const { sites, diagnostics } = normalizeBrowserSites({
			'HTTPS://GitHub.com/': 'act',
			'https://github.com': 'read',
		})
		expect(sites).toEqual({ 'https://github.com': 'read', '*': 'ask' })
		expect(diagnostics).toEqual([])
	})

	it('reports what it cannot read instead of compiling it', () => {
		const { diagnostics, sites } = normalizeBrowserSites({
			'https://git*hub.com': 'act',
			'file:///etc': 'read',
			'https://ok.example': 'sometimes' as never,
		})
		expect(diagnostics).toHaveLength(3)
		expect(sites).toEqual({ '*': 'ask' })
	})

	it('names the key that decides an origin, as the gate would', () => {
		expect(browserSiteRuleFor(SITES, 'https://example.com')).toEqual({
			site: 'https://example.com',
			level: 'act',
		})
		expect(browserSiteRuleFor(SITES, 'https://secret.corp.example')).toEqual({
			site: 'https://secret.corp.example',
			level: 'deny',
		})
		expect(browserSiteRuleFor(SITES, 'https://a.corp.example')).toEqual({
			site: 'https://*.corp.example',
			level: 'ask',
		})
		expect(browserSiteRuleFor(SITES, 'https://example.com.evil.example')).toEqual({
			site: '*',
			level: 'ask',
		})
	})

	it('finds the origin a call opens or acts on', () => {
		expect(browserCallOrigin('browser', { action: 'navigate', url: 'https://example.com/a' })).toBe(
			'https://example.com',
		)
		expect(
			browserCallOrigin('browser_act', { action: 'click', origin: 'https://example.com' }),
		).toBe('https://example.com')
		expect(browserCallOrigin('browser', { action: 'snapshot' })).toBeUndefined()
		expect(browserCallOrigin('browser', { action: 'navigate', url: 'about:blank' })).toBeUndefined()
		expect(browserCallOrigin('bash', { command: 'ls' })).toBeUndefined()
	})
})
