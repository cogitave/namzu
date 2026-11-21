import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { EXIT_FAIL, EXIT_OK } from '../../exit-codes.js'
import {
	credentialsPath,
	pendingLoginPath,
	readStoredSubscriptionCredential,
} from '../../integrations/providers/index.js'
import { writePendingLogin } from '../../integrations/providers/pending-login.js'
import { parseLoginFlags, runClaudeLogin } from '../login.js'

const ACCESS = 'zzz-access-pending-must-never-be-printed'
const REFRESH = 'zzz-refresh-pending-must-never-be-printed'
const CODE = 'auth-code-pending-123'

let home: string
let printed: string[]
let calls: number

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-login-pending-'))
	printed = []
	calls = 0
})
afterEach(() => {
	removeTempDir(home)
})

function fakeFetch(status: number) {
	return (async () => {
		calls++
		return new Response(
			JSON.stringify(
				status === 200 ? { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 } : {},
			),
			{ status, headers: { 'content-type': 'application/json' } },
		)
	}) as unknown as typeof fetch
}

function deps(argv: string[], over: Partial<Parameters<typeof runClaudeLogin>[0]> = {}) {
	const input = new PassThrough()
	input.end()
	return {
		print: (text: string) => printed.push(text),
		flags: parseLoginFlags(['claude', ...argv]),
		input,
		interactive: false,
		home,
		fetch: fakeFetch(200),
		openBrowser: () => false,
		...over,
	}
}

/** Start a sign-in whose stdin is closed, and return the state it kept. */
async function startPending() {
	const code = await runClaudeLogin(deps([]))
	expect(code).toBe(EXIT_OK)
	const raw = JSON.parse(readFileSync(pendingLoginPath(home), 'utf8')) as {
		state: string
		verifier: string
	}
	return raw
}

describe('claude sign-in from a shell whose stdin closes', () => {
	it('keeps a 0600 pending file, prints the address and one line, exits 0, never prints the verifier', async () => {
		const raw = await startPending()
		const path = pendingLoginPath(home)
		if (process.platform !== 'win32') {
			expect(statSync(path).mode & 0o777).toBe(0o600)
			expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
		}
		const output = printed.join('\n')
		expect(output).toContain('https://')
		expect(output).toContain('namzu login claude --code <code>')
		expect(output).toContain('10 minutes')
		expect(output).not.toContain(raw.verifier)
		expect(existsSync(credentialsPath(home))).toBe(false)
	})

	it('keeps the interactive failure for a terminal that closes stdin', async () => {
		const code = await runClaudeLogin(deps([], { interactive: true }))
		expect(code).toBe(EXIT_FAIL)
		expect(printed.join('\n')).toContain('Standard input closed before an authorization code')
		expect(existsSync(pendingLoginPath(home))).toBe(false)
	})

	it('still completes from a piped code without keeping anything', async () => {
		const input = new PassThrough()
		const run = runClaudeLogin(deps([], { input }))
		input.write(`${CODE}\n`)
		expect(await run).toBe(EXIT_OK)
		expect(readStoredSubscriptionCredential(home)?.accessToken).toBe(ACCESS)
		expect(existsSync(pendingLoginPath(home))).toBe(false)
	})
})

describe('namzu login claude --code', () => {
	for (const [name, build] of [
		['a bare code', (_s: string) => CODE],
		['code#state', (s: string) => `${CODE}#${s}`],
		[
			'the finished address',
			(s: string) => `https://example.test/callback?code=${CODE}&state=${s}`,
		],
	] as const) {
		it(`completes with ${name}, stores the credential and removes the pending file`, async () => {
			const raw = await startPending()
			printed = []
			expect(await runClaudeLogin(deps(['--code', build(raw.state)]))).toBe(EXIT_OK)
			expect(readStoredSubscriptionCredential(home)?.accessToken).toBe(ACCESS)
			expect(existsSync(pendingLoginPath(home))).toBe(false)
			const output = printed.join('\n')
			expect(output).not.toContain(ACCESS)
			expect(output).not.toContain(REFRESH)
			expect(output).not.toContain(CODE)
			expect(output).not.toContain(raw.verifier)
		})
	}

	it('says there is no sign-in waiting when none exists, and on a second --code', async () => {
		expect(await runClaudeLogin(deps(['--code', CODE]))).toBe(EXIT_FAIL)
		expect(printed.join('\n')).toContain('no sign-in waiting')
		const raw = await startPending()
		expect(await runClaudeLogin(deps(['--code', `${CODE}#${raw.state}`]))).toBe(EXIT_OK)
		printed = []
		expect(await runClaudeLogin(deps(['--code', CODE]))).toBe(EXIT_FAIL)
		expect(printed.join('\n')).toContain('no sign-in waiting')
		expect(calls).toBe(1)
	})

	it('refuses an expired pending sign-in without calling the endpoint, and removes it', async () => {
		writePendingLogin(
			{
				verifier: 'v',
				state: 's',
				redirectUri: 'https://x.test/cb',
				createdAt: Date.now() - 11 * 60_000,
			},
			home,
		)
		expect(await runClaudeLogin(deps(['--code', CODE]))).toBe(EXIT_FAIL)
		expect(printed.join('\n')).toContain('expired')
		expect(calls).toBe(0)
		expect(existsSync(pendingLoginPath(home))).toBe(false)
	})

	it('refuses a state that does not match, without calling the endpoint', async () => {
		await startPending()
		expect(await runClaudeLogin(deps(['--code', `${CODE}#some-other-state`]))).toBe(EXIT_FAIL)
		expect(printed.join('\n')).toContain('cannot be matched')
		expect(calls).toBe(0)
		expect(existsSync(credentialsPath(home))).toBe(false)
	})

	it('removes the pending file when the exchange fails, and stores nothing', async () => {
		const raw = await startPending()
		printed = []
		expect(
			await runClaudeLogin(deps(['--code', `${CODE}#${raw.state}`], { fetch: fakeFetch(400) })),
		).toBe(EXIT_FAIL)
		expect(calls).toBe(1)
		expect(existsSync(pendingLoginPath(home))).toBe(false)
		expect(existsSync(credentialsPath(home))).toBe(false)
		expect(printed.join('\n')).not.toContain(CODE)
	})
})
