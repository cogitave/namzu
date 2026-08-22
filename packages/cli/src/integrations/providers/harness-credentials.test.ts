import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	claudeCredentialsPath,
	codexCredentialsPath,
	preferFresherCredential,
	readClaudeFileCredential,
	readCodexFileCredential,
} from './harness-credentials.js'

function home(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-harness-creds-'))
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
}

function jwt(payload: Record<string, unknown>): string {
	return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
}

describe('readClaudeFileCredential', () => {
	it('reads the exact refreshable Claude Code envelope without returning unrelated fields', () => {
		const root = home()
		writeJson(claudeCredentialsPath(root), {
			claudeAiOauth: {
				accessToken: 'claude-access',
				refreshToken: 'claude-refresh',
				expiresAt: 42,
				scopes: ['user:inference'],
			},
			primaryApiKey: 'must-not-be-read',
		})
		expect(readClaudeFileCredential(root)).toEqual({
			accessToken: 'claude-access',
			refreshToken: 'claude-refresh',
			expiresAt: 42,
			scopes: ['user:inference'],
		})
	})

	it('refuses malformed and oversized credential records', () => {
		const root = home()
		writeJson(claudeCredentialsPath(root), {
			claudeAiOauth: { accessToken: 7 },
		})
		expect(readClaudeFileCredential(root)).toBeNull()
		writeFileSync(claudeCredentialsPath(root), 'x'.repeat(1024 * 1024 + 1))
		expect(readClaudeFileCredential(root)).toBeNull()
	})
})

describe('readCodexFileCredential', () => {
	it('reads ChatGPT tokens and explicit account routing, never the API-key field', () => {
		const root = home()
		writeJson(codexCredentialsPath(root, {}), {
			OPENAI_API_KEY: 'must-not-be-read',
			tokens: {
				id_token: jwt({}),
				access_token: jwt({ exp: 123 }),
				refresh_token: 'codex-refresh',
				account_id: 'account-explicit',
			},
		})
		expect(readCodexFileCredential(root, {})).toEqual({
			accessToken: expect.any(String),
			refreshToken: 'codex-refresh',
			accountId: 'account-explicit',
			expiresAt: 123_000,
		})
	})

	it('falls back to the JWT account claim and refuses an unroutable token', () => {
		const root = home()
		const claimed = jwt({
			exp: 456,
			'https://api.openai.com/auth': { chatgpt_account_id: 'account-claim' },
		})
		writeJson(codexCredentialsPath(root, {}), {
			tokens: { access_token: claimed },
		})
		expect(readCodexFileCredential(root, {})?.accountId).toBe('account-claim')
		writeJson(codexCredentialsPath(root, {}), {
			tokens: { access_token: jwt({}) },
		})
		expect(readCodexFileCredential(root, {})).toBeNull()
	})

	it('honours CODEX_HOME without reading the ordinary home location', () => {
		const root = home()
		const custom = join(root, 'custom-codex')
		writeJson(codexCredentialsPath(root, { CODEX_HOME: custom }), {
			tokens: { access_token: jwt({}), account_id: 'custom-account' },
		})
		expect(readCodexFileCredential(root, { CODEX_HOME: custom })?.accountId).toBe('custom-account')
	})
})

it('prefers a fresh harness credential over an expired sibling source', () => {
	const now = 1_000_000
	const expired = { accessToken: 'old', expiresAt: now - 1 }
	const fresh = { accessToken: 'fresh', expiresAt: now + 120_000 }
	expect(preferFresherCredential(expired, fresh, now)).toBe(fresh)
})
