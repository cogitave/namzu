/**
 * `web_fetch` is on by default and still asks: each new domain once, and the
 * answer is allow for this session or allow always (remembered per host).
 *
 * The tool declares itself read-only, and the kernel's read-only allowance
 * never asks what a call reaches, so the gate every session of this
 * application runs under excludes the network category from that allowance.
 * These tests run a real `web_fetch` definition through the real gate built
 * for a session, with the remembered answers consulted as a session consults
 * them, rather than through a stub that decides for itself.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	AuthorizationGate,
	NOOP_LOGGER,
	WebFetchTool,
	WebSearchTool,
	builtinCommandArguments,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { loadConfigWithProvenance } from '../../config/load.js'
import { cliGate } from '../read-only-gate.js'
import { compilePermissionLayers, permissionLayersOf } from '../rules.js'
import { type SessionAllow, allowFor, createSessionAllows } from '../session-allow.js'

const commands = builtinCommandArguments()

const fetchCall = (url: string) => ({
	name: 'web_fetch',
	input: { url, prompt: 'what is on the page' },
})

function decide(
	gate: AuthorizationGate,
	toolName: string,
	toolInput: unknown,
	toolDef: typeof WebFetchTool | typeof WebSearchTool,
) {
	return gate.evaluate({ toolName, toolInput, toolDef, commandDialect: 'sh' }).decision
}

const fetchDecision = (gate: AuthorizationGate, url: string) =>
	decide(gate, 'web_fetch', fetchCall(url).input, WebFetchTool)

describe('web_fetch under the session gate', () => {
	it('asks on the first call, and a session allow covers that host only', () => {
		const store = createSessionAllows(commands, {
			keepIgnored: async () => ({ state: 'not-a-repository' }),
		})
		const gate = new AuthorizationGate(cliGate([store.rule]), NOOP_LOGGER)

		expect(fetchDecision(gate, 'https://example.com/a')).toBe('review')

		const allow = allowFor(fetchCall('https://example.com/a'), commands)
		expect(allow).toEqual({ kind: 'host', tool: 'web_fetch', host: 'example.com' })
		store.add([allow as SessionAllow])

		expect(fetchDecision(gate, 'https://example.com/other?x=1')).toBe('allow')
		expect(fetchDecision(gate, 'http://example.com/b')).toBe('allow')
		expect(fetchDecision(gate, 'https://docs.example.org/')).toBe('review')
		expect(fetchDecision(gate, 'https://example.com.evil.test/')).toBe('review')
	})

	it('asks again for a new host once another was allowed', () => {
		const store = createSessionAllows(commands, {
			keepIgnored: async () => ({ state: 'not-a-repository' }),
		})
		const gate = new AuthorizationGate(cliGate([store.rule]), NOOP_LOGGER)
		store.add([{ kind: 'host', tool: 'web_fetch', host: 'a.dev' }])

		expect(fetchDecision(gate, 'https://a.dev/')).toBe('allow')
		expect(fetchDecision(gate, 'https://b.dev/')).toBe('review')
	})

	it('an always-allow is written down and covers the host in the next session', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-fetch-restart-'))
		const home = join(root, 'home')
		const cwd = join(root, 'work')
		mkdirSync(home, { recursive: true })
		mkdirSync(cwd, { recursive: true })

		const first = createSessionAllows(commands, {
			cwd,
			keepIgnored: async () => ({ state: 'not-a-repository' }),
		})
		first.add([{ kind: 'host', tool: 'web_fetch', host: 'example.com' }])

		const { config } = loadConfigWithProvenance({ home, cwd, env: {} })
		const { rules } = compilePermissionLayers(permissionLayersOf(config))
		const next = new AuthorizationGate(cliGate(rules), NOOP_LOGGER)

		expect(fetchDecision(next, 'https://example.com/page')).toBe('allow')
		expect(fetchDecision(next, 'https://other.example.net/')).toBe('review')
	})

	it('a deny the operator wrote still beats a remembered allow', () => {
		const store = createSessionAllows(commands, {
			keepIgnored: async () => ({ state: 'not-a-repository' }),
		})
		store.add([{ kind: 'host', tool: 'web_fetch', host: 'example.com' }])
		const gate = new AuthorizationGate(
			cliGate([{ type: 'deny_by_name', toolNames: ['web_fetch'] }, store.rule]),
			NOOP_LOGGER,
		)
		expect(fetchDecision(gate, 'https://example.com/')).toBe('deny')
	})

	it('keeps web_search running without a question, unless the operator says otherwise', () => {
		const open = new AuthorizationGate(cliGate([]), NOOP_LOGGER)
		expect(decide(open, 'web_search', { query: 'q' }, WebSearchTool)).toBe('allow')

		const asked = new AuthorizationGate(
			cliGate([
				{ type: 'custom_pattern', pattern: 'web_search', target: 'name', decision: 'review' },
			]),
			NOOP_LOGGER,
		)
		expect(decide(asked, 'web_search', { query: 'q' }, WebSearchTool)).toBe('review')
	})
})
