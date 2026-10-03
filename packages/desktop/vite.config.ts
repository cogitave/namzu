import tailwindcss from '@tailwindcss/vite'
import { type Plugin, defineConfig } from 'vite'
import { readStreamRendererPort } from './src/main/stream-renderer-policy.js'

function localDevelopment(): Plugin {
	return {
		name: 'namzu-local-development',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use((request, _response, next) => {
				if (request.url === '/preview') request.url = '/preview.html'
				next()
			})
		},
		configurePreviewServer(server) {
			server.middlewares.use((request, response, next) => {
				if (request.url?.split('?')[0]?.startsWith('/preview')) {
					response.statusCode = 404
					response.end('The visual preview is available only in development.')
					return
				}
				next()
			})
		},
		transformIndexHtml: {
			order: 'pre',
			handler(html, context) {
				if (!context.server) return html
				const address = context.server.httpServer?.address()
				if (!address || typeof address === 'string') return html
				const streamPort = readStreamRendererPort(context.originalUrl)
				const streamSource = streamPort ? ` ws://127.0.0.1:${streamPort}` : ''
				// The production document stays unchanged. Only this listening local
				// server may provide modules and the renderer's HMR websocket.
				// Reconnect pings use a local Blob worker.
				return html.replace(
					"connect-src 'none'",
					`connect-src 'self' ws://127.0.0.1:${address.port} ws://localhost:${address.port}${streamSource}; worker-src 'self' blob:`,
				)
			},
		},
	}
}

export default defineConfig({
	plugins: [tailwindcss(), localDevelopment()],
	base: './',
	build: { outDir: 'dist/renderer', emptyOutDir: true },
	server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
