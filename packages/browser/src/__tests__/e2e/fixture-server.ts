import { readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__')

/**
 * One server, two origins: `http://127.0.0.1:<port>` is the site the tests
 * allow, `http://localhost:<port>` the one they do not. Same bytes, different
 * origin, which is all the policy looks at.
 */
export interface FixtureServer {
	readonly allowed: string
	readonly other: string
	readonly port: number
	/** Every request line the server saw, `GET /path?query` with the Host header. */
	readonly requests: string[]
	close(): Promise<void>
}

export async function startFixtureServer(): Promise<FixtureServer> {
	const requests: string[] = []
	let port = 0
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
		requests.push(`${req.method} ${url.host}${url.pathname}${url.search}`)
		const path = url.pathname
		if (path === '/redirect-away') {
			res.writeHead(302, { location: `http://localhost:${port}/index.html` })
			res.end()
			return
		}
		if (path === '/download') {
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-disposition': 'attachment; filename="report.pdf"',
			})
			res.end('not really a pdf')
			return
		}
		if (path === '/basic') {
			res.writeHead(401, {
				'www-authenticate': 'Basic realm="fixture"',
				'content-type': 'text/html',
			})
			res.end('<!doctype html><title>Unauthorized</title><h1>401</h1>')
			return
		}
		if (path === '/bare-401' || path === '/bare-407') {
			res.writeHead(path === '/bare-401' ? 401 : 407, { 'content-type': 'text/html' })
			res.end('<!doctype html><title>Response</title><h1>Request refused</h1>')
			return
		}
		if (path === '/bare-401-history') {
			res.writeHead(401, { 'content-type': 'text/html' })
			res.end(
				"<!doctype html><title>Response</title><button onclick=\"history.pushState(null, '', '/history-state')\">Change address</button>",
			)
			return
		}
		if (path === '/bare-401-sign-in') {
			res.writeHead(401, { 'content-type': 'text/html' })
			res.end('<!doctype html><title>Account</title><input type="password" aria-label="Password">')
			return
		}
		if (path === '/form-result') {
			const rows = [...url.searchParams].map(([k, v]) => `<li>${k}=${escapeHtml(v)}</li>`).join('')
			res.writeHead(200, { 'content-type': 'text/html' })
			res.end(`<!doctype html><title>Order received</title><h1>Order received</h1><ul>${rows}</ul>`)
			return
		}
		const file = path === '/' ? 'index.html' : path.slice(1)
		if (!/^[a-z-]+\.html$/.test(file)) {
			res.writeHead(404, { 'content-type': 'text/html' })
			res.end('<!doctype html><title>Not found</title><h1>Not found</h1>')
			return
		}
		try {
			const html = readFileSync(join(FIXTURES, file), 'utf8').replaceAll('__PORT__', String(port))
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
			res.end(html)
		} catch {
			res.writeHead(404, { 'content-type': 'text/html' })
			res.end('<!doctype html><title>Not found</title><h1>Not found</h1>')
		}
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	port = (server.address() as AddressInfo).port
	return {
		allowed: `http://127.0.0.1:${port}`,
		other: `http://localhost:${port}`,
		port,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
}
