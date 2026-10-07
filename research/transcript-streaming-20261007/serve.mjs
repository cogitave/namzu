/** One Vite server for the measurement scripts: HMR off, optional production React, optional baseline overlay. */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const desktop = resolve(here, '../../packages/desktop')
export const require = createRequire(join(desktop, 'package.json'))

// Modules replaced by their HEAD copy (`git show HEAD:<path>` saved as <name>.baseline.<ext>) when BASELINE=1.
const baselined = ['message.tsx', 'transcript.tsx', 'use-transcript-scroll.ts', 'transcript-motion.css']

export async function startServer() {
	// REACT=production serves the production React build (no dev-mode element stacks and checks) while
	// keeping the preview's dev-only entry alive; that is the cost the installed app pays.
	const production = process.env.REACT === 'production'
	if (production) process.env.NODE_ENV = 'production'
	const { createServer } = await import(require.resolve('vite'))
	const overlay = process.env.BASELINE === '1'
	const server = await createServer({
		root: desktop,
		...(production ? { define: { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false' } } : {}),
		plugins: overlay
			? [{
				name: 'baseline-overlay',
				enforce: 'pre',
				async resolveId(source, importer, options) {
					const found = await this.resolve(source, importer, { ...options, skipSelf: true })
					const id = found?.id.split('?')[0]
					if (!id?.includes('/src/renderer/')) return null
					const name = id.split('/src/renderer/')[1]
					if (!baselined.includes(name)) return null
					const copy = id.replace(/(\.[a-z]+)$/, '.baseline$1')
					if (!existsSync(copy)) throw new Error(`missing baseline copy ${copy}`)
					return copy
				},
			}]
			: [],
		server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
		optimizeDeps: production ? { force: true } : undefined,
		logLevel: 'error',
	})
	await server.listen()
	return { server, origin: `http://127.0.0.1:${server.httpServer.address().port}/preview` }
}
