import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
	claudeCredentialsPath,
	codexCredentialsPath,
	preferFresherCredential,
	readClaudeCredentialFile,
	readClaudeFileCredential,
	readCodexFileCredential,
	replaceClaudeCredentialFile,
	windowsPathToWsl,
	wslWindowsHome,
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

	it('publishes a rotating refresh grant back to the exact owner envelope', () => {
		const root = home()
		const path = claudeCredentialsPath(root)
		writeJson(path, {
			claudeAiOauth: {
				accessToken: 'claude-access',
				refreshToken: 'claude-refresh',
				expiresAt: 42,
				scopes: ['user:inference'],
				subscriptionType: 'max',
			},
			primaryApiKey: 'preserve-this-owner-field',
		})
		const expected = readClaudeCredentialFile(path)
		expect(expected).not.toBeNull()
		const replacement = {
			accessToken: 'claude-next-access',
			refreshToken: 'claude-next-refresh',
			expiresAt: 99,
		}

		expect(replaceClaudeCredentialFile(path, expected!, replacement)).toEqual({
			replaced: true,
			current: replacement,
		})
		const stored = JSON.parse(readFileSync(path, 'utf8'))
		expect(stored).toEqual({
			claudeAiOauth: {
				accessToken: 'claude-next-access',
				refreshToken: 'claude-next-refresh',
				expiresAt: 99,
				scopes: ['user:inference'],
				subscriptionType: 'max',
			},
			primaryApiKey: 'preserve-this-owner-field',
		})
		expect(statSync(path).mode & 0o777).toBe(0o600)
	})

	it('lets a newer owner credential win instead of overwriting it', () => {
		const root = home()
		const path = claudeCredentialsPath(root)
		writeJson(path, {
			claudeAiOauth: {
				accessToken: 'owner-winner',
				refreshToken: 'owner-refresh',
				expiresAt: 100,
			},
		})
		const before = readFileSync(path, 'utf8')
		expect(
			replaceClaudeCredentialFile(
				path,
				{ accessToken: 'stale', refreshToken: 'stale-refresh', expiresAt: 1 },
				{ accessToken: 'derived', refreshToken: 'derived-refresh', expiresAt: 200 },
			),
		).toEqual({
			replaced: false,
			current: {
				accessToken: 'owner-winner',
				refreshToken: 'owner-refresh',
				expiresAt: 100,
			},
		})
		expect(readFileSync(path, 'utf8')).toBe(before)
	})
})

describe('the paired Windows home visible from WSL', () => {
	it('converts only absolute drive paths without traversal', () => {
		expect(windowsPathToWsl('C:\\Users\\Arda\r\n')).toBe('/mnt/c/Users/Arda')
		expect(windowsPathToWsl('D:/People/Ada')).toBe('/mnt/d/People/Ada')
		expect(windowsPathToWsl('C:\\Users\\..\\Other')).toBeNull()
		expect(windowsPathToWsl('/home/arda')).toBeNull()
	})

	it('uses the pinned system command only on WSL', () => {
		const root = home()
		const command = join(root, 'cmd.exe')
		writeFileSync(command, '')
		const run = vi.fn(() => 'C:\\Users\\Arda\r\n')
		expect(wslWindowsHome({ WSL_DISTRO_NAME: 'test' }, run as never, command)).toBe(
			'/mnt/c/Users/Arda',
		)
		expect(run).toHaveBeenCalledWith(
			command,
			['/d', '/s', '/c', 'echo', '%USERPROFILE%'],
			expect.objectContaining({ timeout: 1_000, killSignal: 'SIGKILL' }),
		)
		const nativeRun = vi.fn()
		expect(wslWindowsHome({}, nativeRun as never, command)).toBeNull()
		expect(nativeRun).not.toHaveBeenCalled()
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
