import { describe, expect, it, vi } from 'vitest'
import { TOKEN_EARLY_EXPIRY_MS, createAzureTokenSource, parseAzTokenOutput } from '../token.js'

const out = (token: string, expiresAtMs: number) =>
	JSON.stringify({ accessToken: token, expires_on: Math.floor(expiresAtMs / 1000) })

describe('createAzureTokenSource', () => {
	it('uses the variable when it is set, without asking az', async () => {
		const runAz = vi.fn()
		const source = createAzureTokenSource(undefined, {
			env: { AZURE_FOUNDRY_TOKEN: 'env-token' },
			runAz,
			findAz: () => '/bin/az',
		})
		expect(await source()).toBe('env-token')
		expect(runAz).not.toHaveBeenCalled()
	})

	it('asks az once and keeps the token until five minutes before it expires', async () => {
		let clock = 1_000_000_000_000
		const runAz = vi.fn(async () => out('t1', clock + 60 * 60 * 1000))
		const source = createAzureTokenSource(undefined, {
			env: {},
			now: () => clock,
			runAz,
			findAz: () => '/usr/bin/az',
		})
		expect(await source()).toBe('t1')
		expect(runAz).toHaveBeenCalledWith('/usr/bin/az', [
			'account',
			'get-access-token',
			'--resource',
			'https://cognitiveservices.azure.com',
			'--output',
			'json',
		])
		clock += 60 * 60 * 1000 - TOKEN_EARLY_EXPIRY_MS - 1
		expect(await source()).toBe('t1')
		expect(runAz).toHaveBeenCalledTimes(1)
		runAz.mockImplementation(async () => out('t2', clock + 60 * 60 * 1000))
		clock += 2
		expect(await source()).toBe('t2')
		expect(runAz).toHaveBeenCalledTimes(2)
	})

	it('shares one az run between concurrent calls', async () => {
		const runAz = vi.fn(async () => out('t', Date.now() + 3_600_000))
		const source = createAzureTokenSource(undefined, { env: {}, runAz, findAz: () => 'az' })
		expect(await Promise.all([source(), source()])).toEqual(['t', 't'])
		expect(runAz).toHaveBeenCalledTimes(1)
	})

	it('is empty, not an error, when az is missing or fails', async () => {
		expect(await createAzureTokenSource(undefined, { env: {}, findAz: () => undefined })()).toBe('')
		const failing = createAzureTokenSource(undefined, {
			env: {},
			findAz: () => 'az',
			runAz: async () => {
				throw new Error('Please run az login')
			},
		})
		expect(await failing()).toBe('')
	})

	it('means the named variable only when the config names one', async () => {
		const runAz = vi.fn()
		const source = createAzureTokenSource('MY_TOKEN', { env: {}, runAz, findAz: () => 'az' })
		expect(await source()).toBe('')
		expect(runAz).not.toHaveBeenCalled()
	})
})

describe('parseAzTokenOutput', () => {
	it('reads expires_on and the older expiresOn', () => {
		expect(parseAzTokenOutput(out('a', 5_000_000))?.expiresAt).toBe(5_000_000)
		const old = parseAzTokenOutput(
			JSON.stringify({ accessToken: 'b', expiresOn: '2030-01-01 00:00:00.000000' }),
		)
		expect(old?.token).toBe('b')
		expect(old?.expiresAt).toBeGreaterThan(0)
		expect(parseAzTokenOutput('not json')).toBeUndefined()
		expect(parseAzTokenOutput('{"accessToken":"x"}')).toBeUndefined()
	})
})
