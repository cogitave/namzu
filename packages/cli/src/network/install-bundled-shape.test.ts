import { expect, it, vi } from 'vitest'

/**
 * Bundled into one file, the HTTP client library's exports arrive under
 * `default` instead of by name. Starting with a proxy set crashed on exactly
 * that, in the built command and nowhere else.
 */

const EnvHttpProxyAgent = vi.fn()
const setGlobalDispatcher = vi.fn()
vi.mock('undici', () => ({ default: { EnvHttpProxyAgent, setGlobalDispatcher } }))

it('finds the exports under default', async () => {
	const { installNetwork, loadUndici } = await import('./install.js')
	expect(typeof (await loadUndici()).EnvHttpProxyAgent).toBe('function')
	const result = await installNetwork({
		env: { HTTPS_PROXY: 'http://proxy.corp:3128' },
		report: () => {},
	})
	expect(result.installed).toBe(true)
	expect(EnvHttpProxyAgent).toHaveBeenCalledOnce()
	expect(setGlobalDispatcher).toHaveBeenCalledOnce()
})
