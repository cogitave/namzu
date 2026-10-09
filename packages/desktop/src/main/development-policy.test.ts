import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

it('serves valid exact dev websocket sources while preserving the production policy', async () => {
	const root = fileURLToPath(new URL('../../', import.meta.url))
	const filename = fileURLToPath(new URL('../../index.html', import.meta.url))
	const productionHtml = await readFile(filename, 'utf8')
	const server = await createServer({
		root,
		server: { host: '127.0.0.1', port: 0, strictPort: true },
		optimizeDeps: { noDiscovery: true, include: [] },
	})
	try {
		await server.listen()
		const address = server.httpServer?.address()
		if (!address || typeof address === 'string') throw new Error('No local Vite address')
		const response = await fetch(`http://127.0.0.1:${address.port}/`)
		expect(response.ok).toBe(true)
		const developmentHtml = await response.text()
		expect(developmentHtml).toContain('/@vite/client')
		const policy = (html: string) => {
			const value = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
			if (!value) throw new Error('No document CSP')
			return new Map(
				value.split(';').map((directive) => {
					const [name, ...sources] = directive.trim().split(/\s+/)
					return [name, sources.join(' ')]
				}),
			)
		}
		const productionPolicy = policy(productionHtml)
		const developmentPolicy = policy(developmentHtml)
		expect(developmentPolicy.get('connect-src')).toBe(
			`'self' ws://127.0.0.1:${address.port} ws://localhost:${address.port}`,
		)
		developmentPolicy.delete('connect-src')
		expect(developmentPolicy.get('worker-src')).toBe("'self' blob:")
		developmentPolicy.delete('worker-src')
		expect(productionPolicy.has('worker-src')).toBe(false)
		expect(productionPolicy.get('connect-src')).toBe("'none'")
		productionPolicy.delete('connect-src')
		expect(developmentPolicy).toEqual(productionPolicy)
		const nativePort = address.port === 23456 ? 23457 : 23456
		const live = await fetch(`http://127.0.0.1:${address.port}/?namzuStreamPort=${nativePort}`)
		expect(live.ok).toBe(true)
		expect(policy(await live.text()).get('connect-src')).toBe(
			`'self' ws://127.0.0.1:${address.port} ws://localhost:${address.port} ws://127.0.0.1:${nativePort}`,
		)
		for (const query of [
			'namzuStreamPort=0',
			'namzuStreamPort=65536',
			'namzuStreamPort=01',
			'namzuStreamPort=1%3Bconnect-src%20*',
			`namzuStreamPort=${nativePort}&namzuStreamPort=${nativePort}`,
		]) {
			const rejected = await fetch(`http://127.0.0.1:${address.port}/?${query}`)
			expect(rejected.ok).toBe(true)
			expect(policy(await rejected.text()).get('connect-src')).toBe(
				`'self' ws://127.0.0.1:${address.port} ws://localhost:${address.port}`,
			)
		}

		const plugin = server.config.plugins.find((item) => item.name === 'namzu-local-development')
		expect(plugin?.apply).toBe('serve')
		expect(await readFile(filename, 'utf8')).toBe(productionHtml)
	} finally {
		await server.close()
	}
	// Starts a real Vite server on a real socket and transforms index.html over HTTP, so its time is
	// server start-up and socket I/O, which a loaded CI runner stretches to several seconds.
}, 30_000)
